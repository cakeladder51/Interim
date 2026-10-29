# Product Mission

## Problem

Oxford and Cambridge STEM interviews test how you think through unseen problems, but good practice is either scarce or locked behind expensive tutoring. Existing AI interview tools ask generic questions; none simulate a tutor who adapts to your reasoning, nudges you when you're stuck, and probes when you're right.

Interim is a customisable interview agent: students work through a live problem by voice or text and get structured feedback on their reasoning afterwards. Under the hood, interviewers are configurable layers (question bank, hinting policy, rubric), so the same system can later power any assessment, from scholarship panels to technical job interviews.

## Target Users

- **At launch:** Oxbridge and Imperial applicants preparing for Maths and Computer Science interviews, especially those without access to expensive tutoring.
- **Later:** anyone facing a think-out-loud assessment, such as scholarship panels or technical job interviews.

## Solution

- **Adaptive tutor behaviour:** the interviewer reacts to the student's reasoning. It works down a hint ladder when they're stuck, probes deeper when they're right, and finishes with structured, rubric-based feedback. It is not a generic Q&A bot.
- **Live voice:** students speak their reasoning as in a real interview, with text as a fallback.
- **Configurable layers:** the question bank, hinting policy and rubric are config, not code. Swapping configs turns Interim into a different assessment, and the demo shows this live.
