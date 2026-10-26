# Interim — Meta Global AI Developer Hackathon Brief

## Event
- **Building:** started Mon 26 Oct
- **Submissions due:** Wed 4 Nov, 9pm ET (2am Thu 5 Nov UK)
- **Judging:** 4–8 Nov
- **Finals:** live finals and winners on 9 Nov
- **Workshops:** live sessions + Discord office hours, 27 Oct – 4 Nov

## Startup track
- Judged on **technical execution** and **whether it holds up in production**
- Theme fit: **Build for Your World**

## Models
- Meta lists: Muse Spark series, Muse Image, SAM 3.1 via Meta Model API, plus Meta open-weights models
- Pitch says Llama: confirm the rules allow it; Muse Spark may score better with Meta judges
- Try **Muse Voice Transcribe** for voice input

## What to optimise for
- Deployed public URL
- Graceful handling of model failures and slow responses
- Real users (classmates testing it)
- The edge is tutor behaviour: nudge when stuck, probe when right, structured feedback afterwards
- Configurable layers (question bank, hint ladder, rubric) back up the "any assessment" claim; show it by swapping configs in the demo

## Claude Code setup
- **CLAUDE.md:** short — stack, run/test commands, folder layout
- **SPEC.md:** demo flow, MVP features, explicit "not doing" list
- **Loop:** plan mode → build one thin slice → verify by running it → commit → `/clear`
- **Teamwork:** separate git worktrees; one person on engine, one on UI/voice; agree the API between them
- **From ECC:** install only `security-review` — skip the full install

## Build order
1. Day 1: measure voice and model latency; if voice is too slow, text becomes the main mode
2. Write the tutor state machine and prompts, plus the config schema
3. Write 5–10 scripted student transcripts and rerun them as a regression suite
4. Deploy early, then get real users testing it
5. Polish, write the demo script, keep a buffer before the 2am deadline
