import "server-only";

import type { InterviewConfig, Style, EngineState, Report } from "@/contracts";
import { MetaError } from "@/lib/meta";
import { getConfig, getStyle, ConfigError } from "@/config/load";
import {
  FEEDBACK_MAX_BODY_BYTES,
  FeedbackRequestSchema,
  type FeedbackView,
} from "@/shared/feedback-protocol";
import {
  toFeedbackView,
  noAnswerView,
  FeedbackInvalidError,
} from "./feedback";

export const FEEDBACK_ATTEMPTS = 2;
export const FEEDBACK_RETRY_DELAY_MS = 400;

export interface FeedbackDeps {
  generate: (args: {
    config: InterviewConfig;
    style: Style;
    state: EngineState;
    signal?: AbortSignal;
  }) => Promise<Report>;
  sleep?: (ms: number) => Promise<void>;
  modelLabel?: string;
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a feedback handler that can be used as a Next.js route POST handler.
 */
export function createFeedbackHandler(
  deps: FeedbackDeps
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const sleep = deps.sleep ?? defaultSleep;

    // H1: Check content-length first
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > FEEDBACK_MAX_BODY_BYTES) {
      return new Response(
        JSON.stringify({
          error: {
            code: "payload_too_large",
            message: "Request body too large.",
          },
        }),
        {
          status: 413,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // H2: Parse JSON body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            code: "bad_request",
            message: "Invalid feedback request.",
          },
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // H3: Validate request schema
    const parseResult = FeedbackRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "bad_request",
            message: "Invalid feedback request.",
          },
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const { state } = parseResult.data;

    // H4: Resolve config and style
    let config: InterviewConfig;
    let style: Style;
    try {
      config = getConfig(state.configId);
      style = getStyle(config, state.styleId);
    } catch (err) {
      if (err instanceof ConfigError) {
        return new Response(
          JSON.stringify({
            error: {
              code: "bad_request",
              message: "Invalid feedback request.",
            },
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          }
        );
      }
      throw err;
    }

    // H5: Check phase is done
    if (state.phase !== "done") {
      return new Response(
        JSON.stringify({
          error: {
            code: "not_finished",
            message: "The interview hasn't finished yet.",
          },
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // H6: Check for no student entries
    const hasStudentEntry = state.transcript.some((e) => e.speaker === "student");
    if (!hasStudentEntry) {
      const view = noAnswerView(config);
      const response: FeedbackView = deps.modelLabel
        ? { ...view, modelLabel: deps.modelLabel }
        : view;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    // H7: Try up to FEEDBACK_ATTEMPTS times
    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt < FEEDBACK_ATTEMPTS; attempt++) {
      try {
        const report = await deps.generate({
          config,
          style,
          state,
          signal: request.signal,
        });

        const view = toFeedbackView(config, state, report);
        const response: FeedbackView = deps.modelLabel
          ? { ...view, modelLabel: deps.modelLabel }
          : view;

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        attempts = attempt + 1;
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check for abort
        if (request.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          // Don't retry on abort
          break;
        }

        // Determine if retryable
        const retryable =
          err instanceof FeedbackInvalidError ||
          (err instanceof MetaError && err.retryable);

        // Retry?
        const isLastAttempt = attempt === FEEDBACK_ATTEMPTS - 1;
        if (retryable && !isLastAttempt) {
          await sleep(FEEDBACK_RETRY_DELAY_MS);
          if (request.signal.aborted) break;
          continue;
        }

        // Don't retry
        break;
      }
    }

    // H8: All attempts failed - return 502
    const retryable =
      lastError instanceof FeedbackInvalidError ||
      (lastError instanceof MetaError && lastError.retryable);

    // Determine code for logging
    let code: string;
    if (lastError instanceof FeedbackInvalidError) {
      code = "invalid";
    } else if (lastError instanceof MetaError) {
      code = lastError.code;
    } else {
      code = "error";
    }

    console.warn("Interim: feedback failed", {
      attempts,
      code,
    });

    return new Response(
      JSON.stringify({
        error: {
          code: "feedback_failed",
          message: "We couldn't prepare your feedback.",
          retryable,
        },
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }
    );
  };
}
