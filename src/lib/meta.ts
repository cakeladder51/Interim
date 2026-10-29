import "server-only";

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z, toJSONSchema } from "zod";
import { getServerEnv } from "./env";

export type MetaErrorCode =
  | "timeout"
  | "rate_limited"
  | "upstream"
  | "invalid_output"
  | "config";

export class MetaError extends Error {
  constructor(
    public code: MetaErrorCode,
    message: string,
    public retryable: boolean,
    public status?: number
  ) {
    super(message);
    this.name = "MetaError";
  }
}

/** Stage 11: a missing or invalid server env is a non-retryable MetaError("config"), so callers fall back. */
function serverEnv(): ReturnType<typeof getServerEnv> {
  try {
    return getServerEnv();
  } catch (err) {
    throw new MetaError("config", err instanceof Error ? err.message : String(err), false);
  }
}

let metaClient: OpenAI | null = null;

export function getMetaClient(): OpenAI {
  if (metaClient === null) {
    const env = serverEnv();
    metaClient = new OpenAI({
      apiKey: env.MODEL_API_KEY,
      baseURL: "https://api.meta.ai/v1",
      maxRetries: 0,
    });
  }
  return metaClient;
}

/**
 * Convert an error from the OpenAI SDK into a MetaError.
 * Centralizes error mapping to avoid duplication.
 */
function toMetaError(err: unknown, isCallerAbort: boolean): MetaError | null {
  // Don't convert caller aborts - let them propagate
  if (isCallerAbort) {
    return null;
  }

  // SDK abort error or generic abort
  if (err instanceof OpenAI.APIUserAbortError || (err instanceof Error && err.name === "AbortError")) {
    return new MetaError("timeout", "Request timed out", true);
  }

  // Connection timeout
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new MetaError("timeout", "Connection timed out", true);
  }

  // API errors
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    if (status === 429) {
      return new MetaError("rate_limited", err.message, true, status);
    }
    if (status >= 500 || err instanceof OpenAI.APIConnectionError) {
      return new MetaError("upstream", err.message, true, status);
    }
    if (status >= 400 && status < 500) {
      return new MetaError("upstream", err.message, false, status);
    }
    return new MetaError("upstream", err.message, true, status);
  }

  // Already a MetaError
  if (err instanceof MetaError) {
    return err;
  }

  // Unknown error
  return new MetaError("config", String(err), false);
}

export interface ChatJSONOptions<T> {
  schema: z.ZodType<T>;
  schemaName: string;
  messages: ChatCompletionMessageParam[];
  timeoutMs?: number; // default 8000
  model?: string;
  signal?: AbortSignal;
  client?: OpenAI;
  retry?: boolean; // default true; when false, don't retry on retryable errors
}

export interface ChatJSONResult<T> {
  data: T;
  latencyMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export async function chatJSON<T>(
  opts: ChatJSONOptions<T>
): Promise<ChatJSONResult<T>> {
  const client = opts.client ?? getMetaClient();
  const env = serverEnv();
  const model = opts.model ?? env.META_MODEL;
  const timeoutMs = opts.timeoutMs ?? 8000;

  const startTime = Date.now();
  const jsonSchema = toJSONSchema(opts.schema) as Record<string, unknown>;

  const doCall = async (): Promise<ChatJSONResult<T>> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Combine with caller's signal if provided
    let combinedSignal: AbortSignal;
    if (opts.signal) {
      combinedSignal = AbortSignal.any([opts.signal, controller.signal]);
    } else {
      combinedSignal = controller.signal;
    }

    try {
      const response = await client.chat.completions.create(
        {
          model,
          messages: opts.messages,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: opts.schemaName,
              schema: jsonSchema,
              strict: false,
            },
          },
          temperature: 0.2,
        },
        {
          signal: combinedSignal,
        }
      );

      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;

      const content = response.choices[0]?.message?.content;
      if (typeof content !== "string") {
        throw new MetaError("invalid_output", "No content in response", true);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new MetaError("invalid_output", "Failed to parse JSON", true);
      }

      const result = opts.schema.safeParse(parsed);
      if (!result.success) {
        throw new MetaError(
          "invalid_output",
          `Schema validation failed: ${result.error.issues[0]?.message}`,
          true
        );
      }

      // Log success
      logModelCall({
        op: "chatJSON",
        model,
        latencyMs,
        ok: true,
      });

      return {
        data: result.data,
        latencyMs,
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
            }
          : undefined,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      // Check if caller aborted first
      const isCallerAbort = opts.signal?.aborted ?? false;

      // Convert to MetaError
      const metaErr = toMetaError(err, isCallerAbort);

      // If caller abort, rethrow original error (no logging)
      if (metaErr === null) {
        throw err;
      }

      // Log exactly once
      logModelCall({
        op: "chatJSON",
        model,
        latencyMs: Date.now() - startTime,
        ok: false,
        code: metaErr.code,
      });

      throw metaErr;
    }
  };

  // Retry once on retryable errors (unless retry is false)
  const shouldRetry = opts.retry ?? true;
  try {
    return await doCall();
  } catch (err) {
    if (shouldRetry && err instanceof MetaError && err.retryable) {
      // Don't retry if caller aborted
      if (opts.signal?.aborted) {
        throw err;
      }
      // Wait 400ms before retry
      await new Promise((resolve) => setTimeout(resolve, 400));
      return doCall();
    }
    throw err;
  }
}

export interface ChatStreamOptions {
  messages: ChatCompletionMessageParam[];
  model?: string;
  firstTokenTimeoutMs?: number; // default 5000
  totalTimeoutMs?: number; // default 15000
  signal?: AbortSignal;
  client?: OpenAI;
  maxTokens?: number; // when set, passed as max_tokens in the request
}

export async function* chatStream(
  opts: ChatStreamOptions
): AsyncGenerator<string> {
  const client = opts.client ?? getMetaClient();
  const env = serverEnv();
  const model = opts.model ?? env.META_MODEL;
  const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 5000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 15000;

  const startTime = Date.now();

  const controller = new AbortController();

  // Combine signals
  let combinedSignal: AbortSignal;
  if (opts.signal) {
    combinedSignal = AbortSignal.any([opts.signal, controller.signal]);
  } else {
    combinedSignal = controller.signal;
  }

  // Track if timeout fired
  let timedOut = false;

  // Track if we've logged
  let logged = false;

  // Total timeout
  const totalTimeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, totalTimeoutMs);

  // First token timeout
  let firstTokenTimer: NodeJS.Timeout | null = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, firstTokenTimeoutMs);

  try {
    const stream = await client.chat.completions.create(
      {
        model,
        messages: opts.messages,
        stream: true,
        temperature: 0.2,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      },
      {
        signal: combinedSignal,
      }
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta === undefined || delta === null || delta === "") {
        continue;
      }

      // Clear first token timeout on first token
      if (firstTokenTimer !== null) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }

      yield delta;
    }

    // Check if we timed out silently (before yielding or after)
    if (timedOut && !opts.signal?.aborted) {
      const latencyMs = Date.now() - startTime;
      logged = true;
      logModelCall({ op: "chatStream", model, latencyMs, ok: false, code: "timeout" });
      throw new MetaError("timeout", "Request timed out", true);
    }

    // Log success only if we didn't time out
    const latencyMs = Date.now() - startTime;
    logged = true;
    logModelCall({
      op: "chatStream",
      model,
      latencyMs,
      ok: true,
    });
  } catch (err) {
    clearTimeout(totalTimeoutId);
    if (firstTokenTimer !== null) {
      clearTimeout(firstTokenTimer);
    }

    // Check caller abort first - don't log or throw, just return
    if (opts.signal?.aborted) {
      return;
    }

    // Convert to MetaError
    const metaErr = toMetaError(err, false);

    if (metaErr === null) {
      // Shouldn't happen since we checked caller abort, but handle gracefully
      return;
    }

    // Log exactly once if not already logged
    if (!logged) {
      logModelCall({
        op: "chatStream",
        model,
        latencyMs: Date.now() - startTime,
        ok: false,
        code: metaErr.code,
      });
    }

    throw metaErr;
  } finally {
    clearTimeout(totalTimeoutId);
    if (firstTokenTimer !== null) {
      clearTimeout(firstTokenTimer);
    }
  }
}

export interface LogModelCallOptions {
  op: string;
  model: string;
  latencyMs: number;
  ok: boolean;
  code?: MetaErrorCode;
}

export function logModelCall(opts: LogModelCallOptions): void {
  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      op: opts.op,
      model: opts.model,
      latencyMs: opts.latencyMs,
      ok: opts.ok,
      ...(opts.code ? { code: opts.code } : {}),
      tag: "model_call",
    })
  );
}
