# Stage 11 brief: Hardening (I2 resilience, I3 CLAUDE.md) (handoff to the external model)

## Goal
Make the app degrade gracefully and leave it documented. This stage is small and exact:
- **H1:** a missing or empty `MODEL_API_KEY` must behave like any other model failure. The interview then continues on the fallback lines; today it shows an error.
- **H2:** fix an intermittently failing test. The product code is correct; the test depends on a weak browser-runtime behaviour.
- **H3:** add a `CLAUDE.md` project guide at the repo root.

**Build and test everything offline:**
- Never call any external API.
- Never read or add keys.
- Deployment is **held**: don't attempt Vercel or Fly.

---

## What already exists: read this first
You're starting in a fresh session.
- **`plan.md` is historical**: where it differs from this brief or the code, this brief and the code win.
- `STATUS.md` lists completed stages (1–10), frozen file hashes and held items.
- **This repo uses Next.js 16.4 with breaking changes**; see `node_modules/next/dist/docs/` if you need Next APIs. This stage needs none.

**Stack:**
- Next.js 16.4 App Router, React 19.3, TypeScript strict, zod v4.
- vitest runs in a node environment: `npx vitest run`, with tests in `tests/` and `@/*` mapped to `src/*`.
- ESLint is `eslint-config-next`: **no `any`**, and 0 warnings expected.

**The model client, `src/lib/meta.ts`** (frozen since Stage 3 at `81491a95`; H1 unfreezes it for one exact change):
- `MetaError(code, message, retryable, status?)`, with `code` one of `"timeout" | "rate_limited" | "upstream" | "invalid_output" | "config"`.
- `getMetaClient()`, `chatJSON(opts)` and the async generator `chatStream(opts)` each call `getServerEnv()` from `./env` **exactly once** (three calls in total).

**`getServerEnv()`** (`src/lib/env.ts`, frozen; **don't change it**) validates `process.env` with zod. If `MODEL_API_KEY` is missing or empty, it throws a **plain** `Error("Missing/invalid env: MODEL_API_KEY")`.

**What the callers do with errors** (all frozen; don't change them):
- **`assess`** (`src/server/assess.ts`): a `MetaError` gives `null`, and the state machine carries on without an assessment. Any other error is rethrown.
- **`speak`** (`src/server/speak.ts`): a `MetaError` before any text gives one `fallbackUtterance(...)`. Any other error is rethrown.
- **The step handler** (`src/server/step-handler.ts`): an error thrown out of a step is logged with `console.error("Step error:", err)` and sent as `error{code:"internal"}`.

**So today, with no key, every step fails.** The plain `Error` is rethrown by `assess`, the student sees "Step failed", and the fallback lines never run. H1 turns the env error into `MetaError("config", …, false)`. `assess` then returns `null`, and `speak` yields its fallback line. `/api/feedback` already maps a non-retryable `MetaError` to a 502 with `retryable:false`.

---

## Constraints
- **New files allowed, as byte-identical copies:**

  | Copy from | To | SHA-256 starts with |
  |---|---|---|
  | `agent-os/review/stage-11-tests/config-error.test.ts.txt` | `tests/config-error.test.ts` | `cb0b89f0` |
  | `agent-os/review/stage-11-files/CLAUDE.md.txt` | `CLAUDE.md` (repo root) | `96b8526b` |

  You may also add `STAGE11_NOTES.md`.
- **Modified files allowed,** with the exact edits below and nothing else:

  | File | Edits | SHA-256 now | SHA-256 after |
  |---|---|---|---|
  | `src/lib/meta.ts` | §H1 | `81491a95` | `92eaa326` |
  | `tests/step-route.test.ts` | §H2 | `3d0bbce8` | `1a297fcd` |

  These "after" hashes assume the edits are made exactly as written, with LF line endings, which the files already use. The reviewer applied exactly these edits to copies of the current files and got exactly these hashes, with tsc 0, eslint 0 and 94/94 across the affected test files.
- **Frozen; SHA-256 checked:** every other file, including:
  - all of `src/` (in particular `src/lib/env.ts`, `src/server/*` and `src/engine/*`)
  - `relay/`, `configs/`, `evals/`, `scripts/`, `public/`, `tests/helpers/`
  - every other test file, including the reviewer copies listed in `STATUS.md`
  - `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.mjs`
  - `.env.example`, `.env.local`, `.gitignore`
  - everything under `agent-os/`
- **No new dependencies.**
- **Never edit a frozen file to get around a problem,** and **never edit a test to make it pass.** The new test file was verified by the reviewer: against today's code all 4 of its tests fail, and with H1 applied all 4 pass. If something blocks you, stop and write it in `STAGE11_NOTES.md`.
- **Add tests if you like** (in new files; list them in your notes). **Don't delete, rename or weaken any.** Test names are compared file by file.

---

## H1. `src/lib/meta.ts`: env errors become `MetaError("config")` (two edits, nothing else)
1. **Replace each of the three calls** `getServerEnv();` with `serverEnv();`. They're in `getMetaClient`, `chatJSON` and `chatStream`, and each is the right-hand side of `const env = …`. Keep the `import { getServerEnv } from "./env";` line.
2. **Directly before the line** `let metaClient: OpenAI | null = null;`, insert this block. It ends with one blank line, so `let metaClient` stays separated from it:
   ```ts
   /** Stage 11: a missing or invalid server env is a non-retryable MetaError("config"), so callers fall back. */
   function serverEnv(): ReturnType<typeof getServerEnv> {
     try {
       return getServerEnv();
     } catch (err) {
       throw new MetaError("config", err instanceof Error ? err.message : String(err), false);
     }
   }

   ```

After the edits, `getServerEnv()` appears exactly once in the file (inside `serverEnv`), and `serverEnv()` appears three times. The error message is the env error's own text: it names the variable, never a value.

## H2. `tests/step-route.test.ts`: make "abort mid-speak" deterministic (two edits, nothing else)
**Why it's flaky:** the test aborts its own `AbortController`, but the handler reads the *derived* `Request.signal`, which undici makes follow the creator's signal only weakly. Under CPU load, about 1 run in 300, the abort doesn't arrive, and the stream shows `token:Second` and `done`. The handler is correct: it checks `signal.aborted` before every event. The fix passes a Request stand-in whose `signal` **is** the test's signal. The handler only reads `headers.get`, `json()` and `signal`.

In the test `it("abort mid-speak: no events after abort, no unhandled rejection", …)`:
1. Replace exactly:
   ```ts
       const responsePromise = handler(
         new Request("http://localhost/api/step", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ state, event: { type: "turn_complete", text: "test", source: "voice" } }),
           signal: controller.signal,
         }) as NextRequest
       );
   ```
   with:
   ```ts
       // Stage 11 H2: a Request stand-in whose signal IS the test's own signal. A real Request follows its
       // creator's abort only weakly (undici), which made this test fail about 1 run in 300 under load.
       const requestBody = { state, event: { type: "turn_complete", text: "test", source: "voice" } };
       const responsePromise = handler({
         headers: new Headers({ "Content-Type": "application/json" }),
         json: async () => requestBody,
         signal: controller.signal,
       } as unknown as NextRequest);
   ```
2. Replace the line `    expect(events.length).toBeLessThanOrEqual(3);` with these two lines. This tightens the test now that it's deterministic: the move and the first token, then nothing.
   ```ts
       expect(events.length).toBeLessThanOrEqual(3);
       expect(events.map((e) => e.event)).toEqual(["move", "token"]);
   ```

Don't change the test's name or anything else in the file.

## H3. `CLAUDE.md`
Copy `agent-os/review/stage-11-files/CLAUDE.md.txt` to `CLAUDE.md` at the repo root, byte for byte (`96b8526b`). It describes the stack, commands, environment, layout, rules and the offline failure drills, each with its test file. Don't reformat or "improve" it. If you think a line is wrong, say so in `STAGE11_NOTES.md` instead.

## Tests
`tests/config-error.test.ts` (4 tests) mocks `@/lib/env` so that `getServerEnv` throws exactly what it throws today without a key. It checks:
- `getMetaClient`, `chatJSON` and `chatStream` throw or reject with `MetaError` `{ code: "config", retryable: false }`, and an injected client is never called
- **the drill:** through the real step handler with the real (non-fake) deps, `start` and then a `turn_complete` both end in `done` with no `error` event; the tokens concatenate to the utterance; the start line is non-empty; `assess` returns `null`; and nothing is logged with `console.error`

No network is reachable in these tests: with the env mocked to throw, no OpenAI client is ever constructed.

## Acceptance criteria
1. Only the allowed files changed. Every frozen file is byte-identical; `meta.ts` and `step-route.test.ts` hash to their "after" values; `tests/config-error.test.ts` and `CLAUDE.md` are byte-identical to their sources.
2. `npx tsc --noEmit` passes, `npx eslint --max-warnings=0` reports 0 problems, and `npx next build` with no keys set passes.
3. **`npx vitest run` exits 0 with no `Errors` / "Unhandled Rejection" line.** It runs **921 tests** (917 before this stage + 4), and no test name disappears.
4. `STAGE11_NOTES.md` lists what you changed, and anything you couldn't do, with reasons.

## Held (not part of this stage)
- Every item under "Held items" in `STATUS.md`: live model, TTS, relay and feedback checks with real keys; real-browser QA; the Vercel and Fly deploys.
