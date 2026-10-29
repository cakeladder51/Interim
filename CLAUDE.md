# Interim

Interim is a voice tutor that runs mock Oxbridge-style admissions interviews. A student talks (or types) through a problem; the interviewer listens mid-answer, interjects when they go off track, watches a scratchpad, and gives rubric-based feedback at the end. Recording is opt-in and stays on the device.

## Stack
- Next.js 16 App Router with `cacheComponents: true`, React 19, TypeScript strict, zod v4, Tailwind.
- This Next.js has breaking changes from older versions: read `node_modules/next/dist/docs/` before writing Next code. `next dev` writes an `AGENTS.md` note about this (git-ignored).
- The model is Meta's Muse Spark through the OpenAI SDK (`src/lib/meta.ts`). TTS is OpenAI `gpt-4o-mini-tts`, with a browser `speechSynthesis` fallback. Speech-to-text goes through the WebSocket relay in `relay/`.

## Commands
- `npm run dev`: the app on localhost:3000. Add `INTERIM_FAKE_MODEL=1` to use the offline fake model; it's ignored under `next start`.
- `npm test` (vitest, node environment), `npm run typecheck`, `npm run lint` (0 warnings expected), `npm run build`
- `npm run relay`: the speech-to-text relay
- `npm run eval`: the scripted-student regression suite against the live model (needs `MODEL_API_KEY`)
- `npm run latency`: the Meta latency check (needs `.env.local`)

## Environment
Keys live in `.env.local` only, never in `.env.example` or in code. Variables: `MODEL_API_KEY`, `META_MODEL` (default `muse-spark-1.3`), `OPENAI_API_KEY`, `RELAY_URL`, `RELAY_SECRET`, `RELAY_ALLOWED_ORIGINS`, `RELAY_MAX_SESSIONS`, `ASR_UPSTREAM_URL`, `INTERIM_FAKE_MODEL`.

## Layout
- `configs/*.json`: interview configs (problems, hints, checkpoints, misconceptions, rubric). They're secret: only `src/config/public.ts` reaches the browser.
- `src/engine/`: the pure interview state machine (`fsm.ts`) and prompts
- `src/server/`: `/api/step` (assess + speak, streamed as SSE), `/api/feedback`, `/api/tts`, `/api/relay-token`, and the offline fakes
- `src/client/`: the browser side: the interview model and runners, `voice/` (mic, relay, TTS) and `recording/`
- `src/app/`: the pages: `/` (start) and `/interview` (consent gate, interview, feedback)
- `src/contracts/`, `src/shared/`: types and protocols shared by client and server
- `relay/`: the speech-to-text WebSocket relay; `evals/` and `src/eval/`: the regression suite
- `tests/`: vitest tests. Files copied from `agent-os/review/stage-*-tests/*.txt` must stay byte-identical.

## Rules
- Nothing in `src/client` or `src/app` imports `src/server`, `src/lib` or `src/config/load`.
- Never log keys, tokens or transcript text.
- The stream invariant: concatenating every `token.text` must equal `done.utterance`.
- When the model fails, the interview still works: `assess` returns null, `speak` yields a fallback line, and feedback returns a 502 with a Try again.

## Failure drills (all offline; each has tests)
- No `MODEL_API_KEY`: steps finish with fallback lines (`tests/config-error.test.ts`).
- Model timeout or error: fallback line or null assessment (`tests/speak.test.ts`, `tests/assess.test.ts`).
- No `OPENAI_API_KEY`: `/api/tts` returns 503 and the browser speaks with `speechSynthesis` (`tests/tts-route.test.ts`).
- Relay down: voice mode falls back to text (`tests/voice-controller.test.ts`).
- Feedback fails: 502 and a Try again button (`tests/feedback-review.test.ts`).
- Microphone or tab share refused: the interview runs without that recording (`tests/recording-session.test.ts`, `tests/recording-review.test.ts`).

## Process
The build is staged: `agent-os/specs/2026-10-26-1914-voice-tutor-engine/stages/STATUS.md` lists every stage, its frozen file hashes and the held items (anything that needs real API keys or a public deploy).
