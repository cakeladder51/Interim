# Stage 2 re-review 2: last fixes (handoff to the external model)

Re-reviewed on 2026-10-26.

**Passed:**
- Typecheck, lint (0 warnings), tests (144/144) and build.
- `fsm.ts` is identical to the reviewed version except for the three U1 typing lines (77, 91, 97): no behaviour change.
- The 57 temporary reverts were rerun: **55 caught**. Of the 2 misses:
  - One is the known equivalent mutant (the `turnWordBaseline` reset in `advanceOrWrap`).
  - **The other is G2, which is still not guarded.**
- G1, G3–G11 and P2 are verified.

**Constraint for this pass:** change only `tests/fsm.test.ts`.

## G2. The checkpoint-order test doesn't exercise sorting (`tests/fsm.test.ts:619-629`)

The test starts from `checkpointsHit: ["p1c2"]` with an assessment of `["unknown", "p1c1", "p1c2"]`. Only **one** new id (`p1c1`) gets appended, so the result is the same whether or not new ids are sorted. Removing the `.sort(...)` from `mergeCheckpoints` still passes every test. The comment at line 626 is also wrong: `p1c1` comes *before* `p1c2` in that assessment.

**Fix:**
- Add a separate test: state `checkpointsHit: []`, assessment `checkpointsHit: ["p1c2", "p1c1"]`, on `turn_complete` → expect `["p1c1", "p1c2"]`.
- In the same test, also cover the "existing first, new ones after" rule with a 3-checkpoint problem. Use a config override where problem 0 has checkpoints `p1c1`, `p1c2`, `p1c3`: state `["p1c3"]`, assessment `["p1c2", "p1c1"]` → expect `["p1c3", "p1c1", "p1c2"]`.
- Fix the misleading comment in the existing test.

## P1b. The purity test's "input unchanged" assertions are vacuous (`tests/fsm.test.ts:806-831`)

The snapshot is compared with `i.state` / `i.config` / `i.style` / `i.assessment`, but those originals are **never passed to `decide`**: only the frozen clones are. The deep freeze still does the real work (mutating a frozen array throws in strict mode, which is why the "merge mutates input" revert is caught), but the four `toEqual(snapshot…)` lines can never fail.

**Fix:** compare the objects that were actually passed, i.e. `frozenState`, `frozenConfig`, `frozenStyle` and `frozenAssessment` against the snapshot.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
- Removing `.sort((a, b) => validIds.indexOf(a) - validIds.indexOf(b))` from `mergeCheckpoints` makes the new G2 test fail.
- Only `tests/fsm.test.ts` has changed. `src/engine/fsm.ts` is byte-for-byte unchanged.
