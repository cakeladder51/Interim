# Interim Voice Tutor Engine: Sub-problems & Stages

## Stage map

| Stage | Name | Sub-problems | Ends with |
|---|---|---|---|
| **1** | **Foundation** | SP0, A1 | App scaffold, shared contracts, Meta client, latency probe, stub `/api/step`, deployed URL |
| 2 | Config + FSM | A2, A3 | Maths/CS configs validated; pure FSM fully unit-tested |
| 3 | Assessor + speaker | A4, A5, A8 (step) | Real `/api/step` running on Muse Spark |
| 4 | Text interview UI | B5 (text), minimal B4 | **M1:** text interview end to end, deployed |
| 5 | Regression suite | A7 | 8 scripted students green (mocked) + live eval |
| 6 | ASR relay | B1 | Relay on Fly; WAV test client gets partials |
| 7 | Voice in/out | B2, B3 | **M2:** speak and hear the interviewer, turn by turn |
| 8 | Mid-answer + canvas | B6, I1 | **M3:** realign interjections; canvas read by the engine |
| 9 | Feedback | A6, B7 | Rubric report page |
| 10 | Recording | B4 (consent), B8 | **M4:** opt-in audio/video recording, downloads |
| 11 | Hardening + deploy | I2, I3 | **M5:** failure drills pass; CLAUDE.md written; demo-ready |

**Critical path:** Stage 1 → 3 → 8. The assessor's quality and latency decide whether mid-answer interjection feels good, so Stage 1 measures latency first.

## Design reference (applies across stages)

- **Config** (`src/contracts/config.ts`) is the "any assessment" contract.
  - A config holds problems.
  - Each problem has checkpoints, a hint ladder (gentle → explicit), probes, misconceptions (signal + realign text) and a solution sketch.
  - Each config also has a rubric with leveled criteria, styles (persona, tone, interjection policy `{minConfidence, cooldownMs, minNewWords}`), timing, a fallback prompt and ASR keywords.
  - Files: `configs/maths-oxbridge.json`, `configs/cs-oxbridge.json`, each with 2 styles (`supportive`, `rigorous`).
- **Engine** (`src/engine/`) is pure. Each step runs `assess` (structured Muse Spark call → `Assessment`), then `decide` (FSM → `Move`), then `speak` (streamed utterance grounded in config text).
  - **Partial/canvas triggers:** interrupt only if the assessment is `off_track`, its confidence is ≥ `minConfidence`, the cooldown has elapsed, and there are ≥ `minNewWords` new words. Otherwise the move is `silent`.
  - **`turn_complete`:**
    - stuck → next hint rung
    - off_track → realign
    - correct → probe, then advance once all checkpoints are hit
    - last problem done → wrap_up
  - **Silence:** silence ≥ `silenceStuckMs` counts as stuck.
- **Failure policy:**
  - assess fails on a partial → silent
  - assess fails on `turn_complete` → the config's fallback prompt
  - speak fails → the raw config text
  - feedback fails → retry once, then show the transcript with a retry button
  - mic or relay down → text mode
  - TTS down → speechSynthesis
- **API is stateless.** Engine state round-trips through the client. `POST /api/step` streams SSE; there are also `/api/feedback`, `/api/tts` and `/api/relay-token` (an HMAC token with a 2-min expiry).
- **Client:**
  - mic AudioWorklet → 16 kHz PCM16 → relay
  - partials debounced (≥ `minNewWords` new words or about 3 s, one request in flight)
  - canvas debounced (about 4 s idle, hash dedup)
  - silence timer
  - TTS through Web Audio, with barge-in (student speech stops the interviewer)
- **Recording:** an AudioContext mixes the mic and the TTS output. Audio uses a MediaRecorder (webm/opus). Video uses `getDisplayMedia({preferCurrentTab})` plus the mixed audio. Everything is downloaded on End, and nothing is uploaded.

## Sub-problems

- **SP0 Shared contracts:** config, engine, step SSE protocol and relay protocol types.
- **Track A (engine):**
  - A1 Meta client + latency probe
  - A2 Config content
  - A3 FSM
  - A4 Assessor
  - A5 Speaker
  - A6 Feedback
  - A7 Regression suite
  - A8 API routes
- **Track B (voice/UI):**
  - B1 ASR relay
  - B2 Mic → ASR client
  - B3 TTS + barge-in
  - B4 Start page + consent dialog
  - B5 Interview screen + canvas
  - B6 Turn controller
  - B7 Feedback page
  - B8 Recording
- **Integration:**
  - I1 Wire engine ↔ UI
  - I2 Resilience pass
  - I3 Deploy + CLAUDE.md
