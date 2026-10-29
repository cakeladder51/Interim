# References for Voice Tutor Engine + Config

There is no internal code yet; the repo started empty. These are the external references the plan relies on.

## Meta Model API

### Models
- **Location:** https://dev.meta.ai/docs/models
- **Relevance:** `muse-spark-1.3` takes text and image input, supports structured output and has an OpenAI-compatible Chat Completions endpoint. No Meta model produces audio.
- **Key patterns:** use the OpenAI SDK with `baseURL: https://api.meta.ai/v1` and bearer `MODEL_API_KEY`.

### Structured output
- **Location:** https://dev.meta.ai/docs/structured-output
- **Relevance:** `Assessment` and `Report` calls.
- **Key patterns:** `response_format: {type:"json_schema", json_schema:{name, schema, strict}}`, with the result read from `choices[0].message.content` as a JSON string. `strict:false` still constrains the output. Recursive schemas are rejected, and nesting is limited to 10 levels.

### Speech-to-text (Muse Voice Transcribe realtime)
- **Location:** https://dev.meta.ai/docs/speech-to-text
- **Relevance:** the student voice input and the ASR relay (Stage 6).
- **Key patterns:**
  - Endpoint: `wss://api.meta.ai/v1/asr/realtime`.
  - First frame: `{authorization:{accessToken:"Bearer …"}, audioEncoding:"PCM_16KHZ", model:"muse-voice-transcribe-1.0", mode:"ENDPOINTING", partialMode:"CUMULATIVE"}`. Wait for `{sessionId}` before sending audio.
  - Audio: binary PCM16LE mono frames at real-time pace.
  - Events: `speechStart`, `transcript{transcript,final}`, `speechEnd`, `speechComplete{turnId,transcript}`, `error`.
  - End with `{"type":"endStream"}`. Sessions are capped at 60 min.

### Image understanding
- **Location:** https://dev.meta.ai/docs/image-understanding
- **Relevance:** canvas snapshots.
- **Key patterns:** not yet verified. Stage 1's latency script tests the `image_url` data-URI format.

## Excalidraw
- **Location:** https://docs.excalidraw.com (`@excalidraw/excalidraw`, `exportToBlob`)
- **Relevance:** the infinite canvas (Stages 4 and 8).
- **Key patterns:** use `exportToBlob` for PNG snapshots, downscaled to ≤1024px before sending.

## OpenAI TTS (streaming)
- **Location:** https://platform.openai.com/docs/guides/text-to-speech
- **Relevance:** the interviewer's voice (Stage 7), behind a `TtsProvider` interface.
- **Key patterns:** stream audio to the client and play it through Web Audio so it can be mixed into the recording.
