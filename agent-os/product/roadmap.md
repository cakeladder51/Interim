# Product Roadmap

## Phase 1: MVP

Scope: Oxbridge/Imperial **Maths and CS** interviews only, so effort goes into the system rather than question content. Due Wed 4 Nov, 9pm ET.

- **Voice + text input:** voice via Muse Voice Transcribe, with text as fallback (text becomes the main mode if Day 1 latency tests show voice is too slow)
- **Tutor state machine:** present the problem, work down the hint ladder when the student is stuck, probe when they're right, then wrap up
- **Structured feedback:** a rubric-based report on the student's reasoning after the session
- **Config layers:** question bank, hint ladder and rubric as swappable config
- **Production readiness:** deployed public URL, and graceful handling of model failures and slow responses

## Phase 2: Post-Launch

- **More subjects:** Physics, Engineering, Natural Sciences and other STEM subjects, plus a subject and interview-style picker
- **Other assessments:** new config packs for scholarship panels, technical job interviews and similar
- **Config authoring UI:** teachers and tutors create and share their own question banks, hint ladders and rubrics without editing files
