# Stage 2 review: fixes required (handoff to the external model)

Reviewed on 2026-10-26.

**Passed:**
- Typecheck, lint (0 warnings), tests (137/137) and build.
- **Configs:** checked character for character against the brief with a parser. 0 differences in both files; all 3×3 problems and the 4 rubric criteria were parsed and matched.
- **Contract change:** correct, and `wordsSinceInterject` is gone.
- **`fsm.ts`:** matches every numbered rule. It's pure, and its only imports are `@/contracts`, `./errors` and `./types`.
- **Allowed files:** only allowed files changed.

**Problem: the tests don't guard every rule** (acceptance criterion 4). Each rule was reverted one at a time in `fsm.ts` and `tests/fsm.test.ts` was run. **45 of 57 reverts were caught; 12 weren't.** One of those is an equivalent mutant (see note). The other 11 are test gaps, listed below.

**Constraints for this pass:**
- **Change only `tests/fsm.test.ts`**, plus the one small typing fix in U1.
- Don't change `fsm.ts` behaviour.

## Test gaps: add or tighten a test for each

Each item gives the revert that currently passes all tests, and the test that must catch it.

| # | Revert that wasn't caught | Test to add or tighten |
|---|---|---|
| G1 | wrap_up `turn_complete` keeps `turnWordBaseline` | In the `wrap_up` → `closing` test, start from `turnWordBaseline: 7` and assert it is `0`. |
| G2 | Checkpoint merge doesn't sort new ids into problem order | State `checkpointsHit: []`, assessment `["p1c2", "p1c1"]` → expect `["p1c1", "p1c2"]`. |
| G3 | `mergeCheckpoints` pushes into the input array (`const merged = current`) | Rewrite the purity test (see P1 below). |
| G4 | `advance` doesn't reset `hintRung` | Start from `hintRung: 1` on problem 0. Advance (via solved, and via hints exhausted) and assert `hintRung === -1`. |
| G5 | Last-problem `advanceOrWrap` doesn't set `phase: "wrap_up"` | In the `solved_wrap_up` **and** `hints_exhausted_wrap_up` tests, assert `state.phase === "wrap_up"`. |
| G6 | `timeUp` uses `>` instead of `≥` | At exactly `now − startedAt === maxMinutes × 60_000`, `turn_complete` → `wrap_up`/`time_up`. One ms earlier → not `time_up`. |
| G7 | Solved check skipped when the assessment says `off_track` (rule order) | All checkpoints already hit, assessment `{status: "off_track", confidence: 0.9}` on `turn_complete` → `probe`/`solved_probe`, because rule 3 comes before rule 4. |
| G8 | `turn_complete` realign returned with `interrupt: true` | Assert `interrupt === false` on the `turn_complete` off_track realign. Also assert `interrupt === false` in at least one test each for hint, probe, advance, acknowledge, wrap_up and silent. |
| G9 | `shouldAssess` doesn't treat `intro` as `problem` | `phase: "intro"` + `turn_complete` (not time up) → `true`. |
| G10 | `shouldAssess` doesn't subtract `turnWordBaseline` | Partial with 13 words and `turnWordBaseline: 5`, supportive style (`minNewWords` 12) → `false`. With `turnWordBaseline: 0` → `true`. |
| G11 | `shouldAssess` canvas ignores cooldown | Canvas with `lastInterjectAt` inside the cooldown → `false`. |

**Note:** removing the `turnWordBaseline: 0` reset inside `advanceOrWrap`'s advance branch is an **equivalent mutant**: every caller already passes a state with `turnWordBaseline: 0`. Keep the reset (the brief specifies it), but no test is needed for it.

## Weak or incorrect tests to fix

### P1. The purity test isn't a deep freeze and doesn't check that inputs are unchanged (`tests/fsm.test.ts:698-740`)
`Object.freeze(JSON.parse(JSON.stringify(x)))` freezes only the top level, so nested arrays like `state.checkpointsHit` can still be mutated. The test also only asserts "doesn't throw".

**Fix:**
- Add a recursive `deepFreeze` helper that freezes every nested object and array.
- For each case: build the input, take a `structuredClone` snapshot, deep-freeze the input, and call `decide`. Assert it doesn't throw **and** the input still deep-equals the snapshot.
- **Cases must include:**
  - a checkpoint merge where the state already has `checkpointsHit: ["p1c1"]` and the assessment adds `"p1c2"` (this catches G3)
  - a partial interjection
  - a canvas interjection
  - a silence hint
  - a hints-exhausted advance
  - a solved probe
  - a solved advance
  - a time-up wrap_up
  - each `end` branch
- Keep the "same input twice gives deep-equal output" test, but run it on the merge case above.

### P2. The "partial while time is up" test accepts either outcome (`tests/fsm.test.ts:663-674`)
`expect(["realign","silent"]).toContain(...)` passes whatever happens. The inputs satisfy every gate (13 words ≥ 12, confidence 0.9, no cooldown), so assert exactly:
- `move.type === "realign"`
- `reason === "interject_off_track"`
- `interrupt === true`

## U1. Small typing fix (`src/engine/fsm.ts`)
`advanceOrWrap(baseState, prefix: string)` builds the reason with `` `${prefix}_advance` as DecisionReason ``. That cast lets a typo compile.
- Type the parameter as `prefix: "solved" | "hints_exhausted"`.
- Build the reason so TypeScript checks it without a cast, for example `` `${prefix}_advance` as const ``, which narrows to the template-literal union and is assignable to `DecisionReason`.
- There is no behaviour change.

## Acceptance
- `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
- Each of the 11 reverts above makes at least one test in `tests/fsm.test.ts` fail.
- `fsm.ts` behaviour is unchanged. The reviewer will diff it: the only allowed edit is the U1 typing change.
- No files are changed outside `tests/fsm.test.ts` and `src/engine/fsm.ts`.
