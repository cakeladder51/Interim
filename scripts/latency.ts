import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { toJSONSchema } from "zod";
import { PNG } from "pngjs";
import { AssessmentSchema } from "../src/contracts/engine";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = parseArgs({
  options: {
    n: {
      type: "string",
      short: "n",
      default: "5",
    },
  },
  strict: false,
});

const nValue = args.values.n;
const N = typeof nValue === "string" ? parseInt(nValue, 10) : 5;

interface LatencyResult {
  op: string;
  iteration: number;
  latencyMs: number;
  ok: boolean;
  promptTokens?: number;
  error?: string;
}

function generateSamplePNG(): string {
  // Create a 512x512 white PNG with some black lines
  const width = 512;
  const height = 512;
  const png = new PNG({ width, height });

  // Fill with white
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = 255; // R
      png.data[idx + 1] = 255; // G
      png.data[idx + 2] = 255; // B
      png.data[idx + 3] = 255; // A
    }
  }

  // Draw some black lines
  const drawLine = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;

    let x = x1;
    let y = y1;

    while (true) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = (width * y + x) << 2;
        png.data[idx] = 0; // R
        png.data[idx + 1] = 0; // G
        png.data[idx + 2] = 0; // B
      }

      if (x === x2 && y === y2) break;

      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  };

  // Draw some mathematical-looking lines
  drawLine(100, 100, 400, 100);
  drawLine(100, 100, 100, 400);
  drawLine(100, 400, 400, 400);
  drawLine(200, 100, 200, 400);
  drawLine(100, 200, 400, 200);

  // Return as base64 data URI
  const buffer = PNG.sync.write(png);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

// Realistic ~1.5k token prompt for assessing a student's answer
function buildAssessPrompt(): { system: string; user: string } {
  const system = `You are an Oxbridge maths interviewer assessing a student's partial answer during a live interview.

The current problem is:
"Prove that √2 is irrational."

Checkpoints (IDs must appear in checkpointsHit if hit):
- c1: Student assumes √2 is rational and writes it as p/q where p and q are integers with no common divisor (coprime)
- c2: Student derives that p² = 2q² and concludes that p is even (so p = 2r for some integer r)
- c3: Student substitutes p = 2r, derives q² = 2r², and concludes q is also even, reaching contradiction with coprimeness

Misconceptions to detect:
- m1: Student forgets or omits the assumption that p and q are coprime
- m2: Student makes algebraic errors in deriving the contradiction

Your persona: You are a supportive but rigorous interviewer. You want to see precise mathematical reasoning, clearly stated assumptions, and correct algebraic manipulation.

Instructions:
Assess the student's current partial answer and respond with a JSON object containing:
- status: one of "stuck", "progressing", "partial", "correct", "off_track"
- confidence: a number between 0 and 1 indicating how confident you are in the assessment
- checkpointsHit: array of checkpoint IDs (c1, c2, c3) that the student has clearly hit
- misconceptionId: the ID of a detected misconception, or null if none
- evidence: a brief quote or description supporting your assessment (keep it under 50 words)`;

  const user = `Here is the transcript so far (interviewer messages prefixed with [I], student messages prefixed with [S]):

[I] Hello! Today let's discuss irrational numbers. Can you prove that √2 is irrational?

[S] OK, so I'll try to prove by contradiction. Let me assume that √2 is rational.

[I] Good start. And what does that mean exactly?

[S] So that means there exist integers p and q such that √2 equals p over q. Um, and I think we can assume that p and q have no common factors... they're in their simplest form.

[I] Exactly. We can assume p and q are coprime. What's your next step?

[S] Well, if √2 = p/q, then squaring both sides gives 2 = p²/q², so p² = 2q². That means p² is even, right?

[I] And if p² is even, what can you say about p?

[S] If p² is even, then p must be even too. Let me think... yes, because an odd number squared is odd, so p can't be odd.

[I] Correct. Continue.

[S] So if p is even, I can write p as 2r for some integer r. OK so then p² is 4r². And we had p² = 2q², so 4r² = 2q². That gives 2r² = q². Hmm...

[I] What does that tell you about q?

[S] Oh! So q² is even, which means q is even. But wait, that's a problem because I assumed p and q were coprime. If both are even, they have a common factor of 2!

[I] Exactly! So what do you conclude?`;

  return { system, user };
}

async function runAssessJSON(client: OpenAI): Promise<{ latencyMs: number; promptTokens?: number }> {
  const startTime = Date.now();
  const { system, user } = buildAssessPrompt();

  const response = await client.chat.completions.create({
    model: process.env.META_MODEL ?? "muse-spark-1.3",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Assessment",
        schema: toJSONSchema(AssessmentSchema) as Record<string, unknown>,
        strict: false,
      },
    },
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content in response");
  }

  // Validate
  const parsed = JSON.parse(content);
  AssessmentSchema.parse(parsed);

  return { 
    latencyMs: Date.now() - startTime,
    promptTokens: response.usage?.prompt_tokens,
  };
}

async function runSpeakStream(client: OpenAI): Promise<{ firstTokenMs: number; totalMs: number }> {
  const startTime = Date.now();

  const response = await client.chat.completions.create({
    model: process.env.META_MODEL ?? "muse-spark-1.3",
    messages: [
      {
        role: "system",
        content: "You are an Oxbridge interviewer. Give a brief one-sentence nudge to encourage the student.",
      },
      { role: "user", content: "Give me a gentle nudge." },
    ],
    stream: true,
    temperature: 0.2,
  });

  let firstTokenMs = 0;
  let tokenCount = 0;

  for await (const chunk of response) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      if (tokenCount === 0) {
        firstTokenMs = Date.now() - startTime;
      }
      tokenCount++;
    }
  }

  const totalMs = Date.now() - startTime;
  return { firstTokenMs, totalMs };
}

async function runAssessWithImage(
  client: OpenAI,
  imageDataURI: string
): Promise<{ latencyMs: number; promptTokens?: number }> {
  const startTime = Date.now();
  const { system } = buildAssessPrompt();

  const userContent = `The student has drawn the following diagram on the whiteboard (attached as image). 

Their verbal answer so far: "Starting the proof. I'll assume √2 = p/q where p and q are coprime integers."`;

  const response = await client.chat.completions.create({
    model: process.env.META_MODEL ?? "muse-spark-1.3",
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userContent },
          {
            type: "image_url",
            image_url: { url: imageDataURI },
          },
        ],
      },
    ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Assessment",
        schema: toJSONSchema(AssessmentSchema) as Record<string, unknown>,
        strict: false,
      },
    },
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content in response");
  }

  // Validate
  const parsed = JSON.parse(content);
  AssessmentSchema.parse(parsed);

  return { 
    latencyMs: Date.now() - startTime,
    promptTokens: response.usage?.prompt_tokens,
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * (p / 100));
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

function printTable(results: LatencyResult[]): void {
  console.log("\n| op | n | ok | p50 | p95 | min | max | p50_prompt_tokens |");
  console.log("|----|---|-----|-----|-----|-----|-----|-------------------|");

  const ops = ["assess_json", "speak_first_token", "speak_total", "assess_with_image"];

  for (const op of ops) {
    const opResults = results.filter((r) => r.op === op);
    if (opResults.length === 0) continue;

    const ok = opResults.filter((r) => r.ok).length;
    const latencies = opResults
      .filter((r) => r.ok)
      .map((r) => r.latencyMs)
      .sort((a, b) => a - b);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const min = latencies[0] ?? 0;
    const max = latencies[latencies.length - 1] ?? 0;

    const promptTokens = opResults
      .filter((r) => r.ok && r.promptTokens !== undefined)
      .map((r) => r.promptTokens!);
    const p50PromptTokens = promptTokens.length > 0 ? percentile(promptTokens.sort((a, b) => a - b), 50) : 0;

    console.log(`| ${op} | ${opResults.length} | ${ok} | ${p50} | ${p95} | ${min} | ${max} | ${p50PromptTokens} |`);
  }
}

async function main() {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    console.error("MODEL_API_KEY environment variable is required");
    process.exit(1);
  }

  // Use maxRetries: 0 for accurate latency measurements
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.meta.ai/v1",
    maxRetries: 0,
  });

  const results: LatencyResult[] = [];

  // Check for existing PNG or generate one
  let imageDataURI: string;
  const fixturePath = join(__dirname, "fixtures", "canvas-sample.png");
  if (existsSync(fixturePath)) {
    const buffer = readFileSync(fixturePath);
    imageDataURI = `data:image/png;base64,${buffer.toString("base64")}`;
  } else {
    imageDataURI = generateSamplePNG();
  }

  console.log(`Running ${N} iterations of each operation...\n`);

  // Run assess_json
  for (let i = 0; i < N; i++) {
    console.log(`assess_json ${i + 1}/${N}...`);
    try {
      const { latencyMs, promptTokens } = await runAssessJSON(client);
      results.push({ op: "assess_json", iteration: i, latencyMs, ok: true, promptTokens });
      console.log(`  ✓ ${latencyMs}ms (prompt: ${promptTokens ?? "N/A"} tokens)`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ op: "assess_json", iteration: i, latencyMs: 0, ok: false, error: errorMsg });
      console.log(`  ✗ ${errorMsg}`);
    }
  }

  // Run speak_stream
  for (let i = 0; i < N; i++) {
    console.log(`speak_stream ${i + 1}/${N}...`);
    try {
      const { firstTokenMs, totalMs } = await runSpeakStream(client);
      results.push({ op: "speak_first_token", iteration: i, latencyMs: firstTokenMs, ok: true });
      results.push({ op: "speak_total", iteration: i, latencyMs: totalMs, ok: true });
      console.log(`  ✓ first: ${firstTokenMs}ms, total: ${totalMs}ms`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ op: "speak_first_token", iteration: i, latencyMs: 0, ok: false, error: errorMsg });
      results.push({ op: "speak_total", iteration: i, latencyMs: 0, ok: false, error: errorMsg });
      console.log(`  ✗ ${errorMsg}`);
    }
  }

  // Run assess_with_image
  let firstRejectionStatus: number | null = null;
  let firstRejectionMessage: string | null = null;
  for (let i = 0; i < N; i++) {
    console.log(`assess_with_image ${i + 1}/${N}...`);
    try {
      const { latencyMs, promptTokens } = await runAssessWithImage(client, imageDataURI);
      results.push({ op: "assess_with_image", iteration: i, latencyMs, ok: true, promptTokens });
      console.log(`  ✓ ${latencyMs}ms (prompt: ${promptTokens ?? "N/A"} tokens)`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({ op: "assess_with_image", iteration: i, latencyMs: 0, ok: false, error: errorMsg });
      console.log(`  ✗ ${errorMsg}`);
      
      // Check for 4xx rejection using APIError
      if (err instanceof OpenAI.APIError && err.status !== undefined && err.status >= 400 && err.status < 500) {
        if (firstRejectionStatus === null) {
          firstRejectionStatus = err.status;
          firstRejectionMessage = err.message;
        }
      }
    }
  }

  printTable(results);

  // Print image rejection message if all failed with 4xx
  const imageResults = results.filter((r) => r.op === "assess_with_image");
  const allImageFailed = imageResults.length > 0 && imageResults.every((r) => !r.ok);
  if (allImageFailed && firstRejectionStatus !== null) {
    console.log(`\nIMAGE INPUT FORMAT REJECTED: ${firstRejectionStatus} ${firstRejectionMessage ?? ""}`);
  }

  // Write results to file
  const outDir = join(__dirname, "out");
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `latency-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${outPath}`);

  // Exit non-zero if assess_json failed on every run
  const assessJsonSuccess = results.some((r) => r.op === "assess_json" && r.ok);
  if (!assessJsonSuccess) {
    console.error("\nassess_json failed on every run");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
