# Voice Tutor Engine + Config: Shaping Notes

## Scope

This spec covers the core of the Interim MVP: a config-driven tutor engine plus a two-way voice interview UI for Oxbridge/Imperial **Maths and CS** interviews.

The interviewer reacts while the student is answering:
- it nudges the student when they're stuck (hint ladder)
- it realigns them mid-answer when they go off track
- it probes when they're right
- it produces structured rubric feedback at the end

The student talks through a problem by voice, or types as a fallback, and works on an infinite canvas that the engine can read.

## Decisions

- **Turn logic:** an LLM assessor returns structured JSON (`stuck | progressing | partial | correct | off_track` plus confidence). A deterministic TypeScript FSM picks the move, and a second call phrases the utterance, grounded in config text.
- **Mid-answer interruption:** debounced partial transcripts and canvas snapshots are assessed during the answer. The engine interrupts only when it's confidently off track, after the cooldown and minimum new words set by the style config.
- **Voice is two-way and in scope:**
  - **STT:** Muse Voice Transcribe realtime WS (ENDPOINTING, CUMULATIVE partials).
  - **TTS:** a hosted streaming TTS behind a provider interface (OpenAI `gpt-4o-mini-tts` by default), because Meta has no TTS model. Browser `speechSynthesis` is the fallback.
  - **Barge-in:** student speech stops the interviewer.
- **ASR relay:** a small Node WS relay on Fly.io holds the Meta key. The ASR WS takes the raw key in its first frame and has no documented browser tokens, and Vercel can't host WebSockets.
- **Canvas:** Excalidraw (MIT). Snapshots are sent as images to Muse Spark.
- **Config locked before start:** subject + style are chosen on a minimal start page, and demo config swaps happen between interviews.
- **Recording:** opt-in through a pre-interview dialog (checkboxes for Audio and Video → Submit → browser permissions).
  - Audio mixes both voices.
  - Video is a tab capture plus the mixed audio.
  - Recordings stay on the device and are offered as downloads at the end. Nothing is uploaded and there is no DB.
- **Stateless API:** engine state round-trips through the client; `/api/step` streams SSE.
- **Regression suite:** 8 scripted student transcripts (deterministic with mocks, plus a live eval).
- **Model:** Muse Spark 1.3 via the Meta Model API (OpenAI-compatible).
- **Working model:** Claude writes one detailed stage brief at a time. An external model implements it, and Claude reviews it thoroughly before the next stage.

## Context

- **Visuals:** `visuals/Layout_files_1.jpg.jpeg` is the interview screen (Interviewer/User transcript, "Speak to respond (default) or type" bar, infinite canvas). `visuals/Layout_files_2.jpg.jpeg` is the dashboard; only the Practice card (subject picker + Interview button) is in scope, and stats tiles and accounts are deferred.
- **References:** no internal code yet. See `references.md` for external docs.
- **Product alignment:** this follows `agent-os/product/`:
  - Maths + CS only for the hackathon
  - Next.js on Vercel
  - Muse Spark + Muse Voice Transcribe
  - production robustness (graceful handling of model failures and slow responses, a public URL)
  - configs (question bank, hint ladder, rubric) back the "any assessment" claim

## Standards Applied

None yet. `agent-os/standards/index.yml` is empty. Run `/discover-standards` once Stage 4 lands.
