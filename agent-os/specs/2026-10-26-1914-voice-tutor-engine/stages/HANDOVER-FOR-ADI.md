# Handover for Adi: the held live, QA and deploy work

All 11 stages are built and reviewed (2026-10-29). Everything left needs real API keys, a real browser or a public deploy, so it was held for you. Work through the steps in order: each one assumes the ones before it passed.

Commands are for PowerShell from the repo root (`D:\CodeFiles\Interim`). Keys go in `.env.local` only (it's git-ignored by `.env*.local`). Never put them in `.env.example`, in code, or in a commit, and **never set `INTERIM_FAKE_MODEL` on a deployed app**.

---

## 0. Offline baseline (2 min, no keys used)
```powershell
npm run typecheck; npm run lint; npm test; npm run build
```
**Expect:** tsc passes with no output; eslint gives 0 problems; vitest **921 passed**, exit 0, and no `Errors` or "Unhandled Rejection" line; the build lists `/`, `/interview`, `/api/step`, `/api/feedback`, `/api/tts` and `/api/relay-token`. If any of these fail, stop: the problem is in the code, not the keys.

## 1. Keys in `.env.local`
It should contain `MODEL_API_KEY`, `META_MODEL=muse-spark-1.3` and `OPENAI_API_KEY`. It already holds real Meta and OpenAI keys. If the Meta key that briefly sat in `.env.example` on 2026-10-28 was ever shared anywhere, rotate it first.

## 2. Meta latency: already run once; decide what it means
`latency.md` holds a run from 2026-10-28 (5 iterations each):

| op | p50 | p95 |
|---|---|---|
| assess (JSON) | 8.9 s | 10.6 s |
| speak, first token | 4.2 s | 6.6 s |
| assess with a canvas image | 7.0 s | 7.7 s |

- **Image input works:** Muse Spark accepted the `image_url` data URI on 5/5 calls, so canvas snapshots are fine.
- **Assess is far over the ~3.5 s target for mid-answer partials.** Expect interjections to land late. An end-of-turn reply takes about assess + speak ≈ 13 s before the interviewer starts talking.
- **Decision for you:** keep voice as the main mode, or lead with text, or try a faster `META_MODEL` (if Meta has one) and re-measure.

To re-run (5 iterations per op, about 2 min; it writes `scripts/out/latency-*.json`):
```powershell
npm run latency
```
Paste the table into `latency.md`.

## 3. Live eval: the 8 scripted students against the real assessor
```powershell
npm run eval
```
`--min-pass` defaults to `0.8`; you can pass it explicitly with `npm run eval -- --min-pass 0.8`.

**Expect:**
- "Loaded 8 scripts"
- a per-script table: status match, misconception match, and partial and turn latency p50/p95
- exit 0, meaning at least 80% passed

**Note** which scripts fail and why. The mocked suite is green, so a failure here is about the assessor's quality (prompting), not wiring.

## 4. Live text interview (Stage 3/4 loop)
```powershell
npm run dev
```
Don't set `INTERIM_FAKE_MODEL`. Open http://localhost:3000, start the maths interview and tick no recording. Type answers for about 6 turns, include at least one deliberate mistake, and end the interview.

**Verify:**
- Replies are specific to what you typed. Generic fallback lines would mean the model calls are failing: check the terminal for `Step error:` or Meta error codes.
- The deliberate mistake gets a realign or a probe.
- Turn latency roughly matches §2.
- The feedback panel appears (see §9).

## 5. TTS (`OPENAI_API_KEY`)
With `npm run dev` still running, switch to voice mode or let the interviewer speak.

**Verify:**
- The voice is OpenAI's (`gpt-4o-mini-tts`), not the robotic browser voice.
- Audio starts within about 1–2 s of the text.

**Drill:** remove `OPENAI_API_KEY` from `.env.local` and restart. `/api/tts` should return 503, and the interviewer should speak with the browser's `speechSynthesis`. Put the key back afterwards.

## 6. Speech-to-text relay against Meta (local)
1. **Make a secret** (32+ characters):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Start the relay** in its own terminal. It doesn't read `.env.local`, so set the variables in that shell:
   ```powershell
   $env:RELAY_SECRET="<secret>"; $env:MODEL_API_KEY="<meta key>"; $env:RELAY_ALLOWED_ORIGINS="http://localhost:3000"; npm run relay
   ```
   **Expect** `relay listening on :8080`. `ASR_UPSTREAM_URL` defaults to `wss://api.meta.ai/v1/asr/realtime`; set it if Meta's realtime ASR URL is different.
3. **WAV test** in another terminal. You need a 16 kHz, mono, 16-bit WAV file of you speaking:
   ```powershell
   $env:RELAY_SECRET="<secret>"; npx tsx relay/scripts/wav-client.ts --url ws://localhost:8080/asr --wav <file.wav> --config maths-oxbridge
   ```
   **Expect** partial transcripts while the file streams, then a final transcript that matches what you said.

   If you get no partials, or an error from Meta: **the upstream event names in `relay/src/map-upstream.ts` were never checked against Meta's real API.** Compare them with Meta's realtime ASR docs, fix the mapping, and run `npm test` again.
4. **Point the app at the relay.** Add these to `.env.local`, then restart `npm run dev`:
   ```
   RELAY_URL=ws://localhost:8080/asr
   RELAY_SECRET=<same secret>
   ```

## 7. Voice mode in real browsers (Chrome, Safari, Firefox)
Keep the relay and `npm run dev` running. In each browser, run a voice interview:
- the mic permission prompt appears once
- partial captions appear as you speak
- a turn is sent when you stop
- talking over the interviewer stops it (barge-in)
- echo doesn't trigger false barge-ins: try with **and** without headphones
- stopping the relay mid-interview makes it fall back to text mode with a notice

## 8. Mid-answer and scratchpad (Chrome, Safari, Firefox)
- **Scratchpad:** drawing works with mouse, touch and pen; Clear empties it; one `canvas` step is sent about 4 s after a stroke (DevTools → Network → `/api/step`).
- **Silence:** stay silent for 20 s and you get a prompt; you get at most 2 prompts until you do something.
- **Waiting:** a voice turn waits until the interviewer has stopped speaking.
- **Live quality:**
  - Talk through a known misconception mid-answer. The interviewer should interject with a realign that fits.
  - Draw a relevant diagram and check that the interviewer refers to it.
  - Note how late interjections land (see §2).
  - With the real mic, check that the interviewer's interjection audio doesn't barge itself in.

## 9. Feedback (live)
Finish a real interview of 6+ turns.

**Verify:**
- The report appears within about 15 s.
- Scores match how you actually did.
- Each key moment quotes your words **exactly**, with the right time.
- Nothing is invented: no criteria or moments that didn't happen.

**Drill:** stop your network, or temporarily set a wrong `MODEL_API_KEY`, and end an interview. You should see the transcript with a Try again button. Restore the key afterwards.

## 10. Recording (Chrome, Safari, Firefox)
On `/interview`:
- the consent dialog appears first
- with audio + video ticked, the mic prompt and then the tab-share prompt appear
- refusing either one still lets the interview run, with a notice

At the end:
- **Audio:** the file plays and has **both** voices. This needs `OPENAI_API_KEY`: `speechSynthesis` can't be captured.
- **Video:** the file shows the tab with the mixed audio.
- **Stop sharing:** the browser's "Stop sharing" ends only the video.
- **Downloads:** both play.
- **Text mode:** check that the audio file isn't silent. The mixer resumes the `AudioContext` after the permission prompt, outside the click; Safari is the most likely to block it.

Nothing is uploaded: confirm in DevTools → Network that no request carries media.

## 11. Deploy the relay to Fly.io (Stage 6 deploy)
The repo has **no `Dockerfile` or `fly.toml` yet**; they were held. What the image needs:
- **Node 20+**, and the repo's `relay/`, `src/` (the relay imports `@/shared/relay-token`, `@/config/load` and `@/contracts`), `configs/`, `tsconfig.json`, `package.json` and `package-lock.json`.
- **Install:** `npm ci`.
- **Start:** `npx tsx relay/src/main.ts`.
- **Port:** it listens on `PORT`, default 8080; set the Fly `internal_port` to match.
- **Path:** the WebSocket path is `/asr`.

Then:
```powershell
fly launch --no-deploy
fly secrets set RELAY_SECRET=<new secret> MODEL_API_KEY=<meta key> RELAY_ALLOWED_ORIGINS=https://<your-vercel-domain>
fly deploy
```
`RELAY_MAX_SESSIONS` is optional; the default is 50. Use a **new** secret for production, not the local one.

**Verify:** run the §6 WAV test against `--url wss://<app>.fly.dev/asr` with the production secret: you should get partials and a final transcript.

## 12. Deploy the app to Vercel (Stage 1/4 deploy, M1)
```powershell
npx vercel link
npx vercel env add MODEL_API_KEY production
npx vercel env add OPENAI_API_KEY production
npx vercel env add RELAY_SECRET production
npx vercel env add RELAY_URL production
npx vercel --prod
```
- `RELAY_SECRET` is the same value as on Fly.
- `RELAY_URL` is `wss://<app>.fly.dev/asr`.
- Add `META_MODEL` too if you're not using the default.
- **Don't add `INTERIM_FAKE_MODEL`.** It's ignored under `next start` anyway, but keep it out.

**Smoke test on the public URL:**
- `/` loads.
- A text interview streams replies: check that `/api/step` returns `text/event-stream`, with `token` events and then `done`.
- Feedback appears at the end.
- `/api/relay-token` returns 200 with a token (not 503).
- Voice mode works over `wss://` in Chrome.
- Repeat §7 briefly on Safari and Firefox.

**If streams cut off:** check the Vercel function duration limit, since a step can take about 13 s (§2).

## 13. Housekeeping
- **Commit the project.** Everything except `.env.local` is untracked right now. `AGENTS.md` (written by `next dev`) is already git-ignored. Decide whether `agent-os/`, `.claude/` and the `STAGE*_NOTES.md` files go in the repo.
- **Record results.** Write the outcome of each step above in `STATUS.md` under "Held items", and tick the item off when it passes.
