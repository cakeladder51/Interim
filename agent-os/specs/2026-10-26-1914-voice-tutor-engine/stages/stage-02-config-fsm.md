# Stage 2 brief: Config + FSM (handoff to the external model)

## Goal
Add the two interview configs (Maths and CS) with a validated loader, and write the tutor's **decision core**: a pure, deterministic state machine that takes the current state, an event and an (optional) assessment and returns the next state and the interviewer's move. There are no model calls, routes, UI or voice in this stage. Stage 3 wires `decide()` into `/api/step` with the real assessor and speaker.

## Constraints
- **Allowed files:**
  - `configs/` (new)
  - `src/config/` (new)
  - `src/engine/`
  - `src/contracts/engine.ts` (only the contract change below)
  - `tests/`
  - `STAGE2_NOTES.md`
- **Don't touch anything else.** In particular, leave `src/lib/`, `src/app/`, `scripts/`, `package*.json`, `acl-repair/` and `.bridge/` alone. Don't run permission/ACL tooling, and don't write tool output into the repo.
- **No new dependencies.**
- **Purity:** everything in `src/engine/fsm.ts` must be pure.
  - no `Date.now()`, `Math.random()`, I/O or `console`
  - never mutate inputs
  - same input → same output
- **Imports:** `fsm.ts` may import only from `@/contracts` and `src/engine/`.
- If anything is ambiguous, write the question in `STAGE2_NOTES.md` rather than guessing.

## Contract change (the only one allowed)

In `src/contracts/engine.ts`, change `EngineStateSchema`:
- **Rename** `wordsSinceInterject` → `turnWordBaseline` (`int ≥ 0`). Meaning: the word count of the current turn's partial transcript at the moment the interviewer last interjected in this turn. It's 0 at the start of every turn.
- **Add** `probesAsked` (`int ≥ 0`): how many probes have been asked on the current problem. It resets to 0 when the interview advances to the next problem.

Then update every reference: `src/engine/state.ts` (`createInitialState` sets both to 0), plus the state fixtures in `tests/contracts.test.ts`, `tests/sse.test.ts` and `tests/step-route.test.ts`. The stub route needs no logic change.

---

## Files to create

### 1. `configs/maths-oxbridge.json` and `configs/cs-oxbridge.json`
These must validate against `InterviewConfigSchema` from `@/contracts`. **Transcribe the content below exactly**; it has been checked for mathematical correctness. Don't rewrite or "improve" it.

**Shared across both configs:**
- `timing`: `{ "maxMinutes": 25, "silenceStuckMs": 20000 }`
- `fallbackPrompt`: `"Talk me through what you're thinking right now. What would you try next?"`
- Two styles with ids `supportive` and `rigorous`:
  - `supportive`: label `"Supportive tutor"`, tone `"Warm, patient and encouraging. Short sentences."`, interjection `{ "minConfidence": 0.8, "cooldownMs": 20000, "minNewWords": 12 }`
  - `rigorous`: label `"Rigorous examiner"`, tone `"Crisp, direct and neutral. Asks pointed questions."`, interjection `{ "minConfidence": 0.65, "cooldownMs": 12000, "minNewWords": 8 }`
- Rubric (identical in both configs):

| id | name | score 1 | score 2 | score 3 | score 4 |
|---|---|---|---|---|---|
| `approach` | Problem-solving approach | Doesn't find a way in, even with hints. | Finds a way in only after substantial hints. | Finds a sensible approach with occasional nudges. | Independently finds a clear approach and adapts it when needed. |
| `rigour` | Rigour and correctness | Key steps are wrong or missing. | Mostly correct but with unjustified or incorrect steps. | Correct, with minor gaps in justification. | Correct and fully justified at every step. |
| `communication` | Thinking aloud | Rarely explains thinking; hard to follow. | Explains some steps but leaves big gaps. | Explains most steps clearly. | Explains reasoning clearly throughout, including doubts and dead ends. |
| `responsiveness` | Responding to hints | Ignores or can't use hints. | Uses hints only when they're very explicit. | Uses hints well after a short delay. | Picks up subtle hints immediately and builds on them. |

#### `maths-oxbridge`
- `id` `"maths-oxbridge"`, `title` `"Oxbridge Maths Interview"`, `subject` `"Mathematics"`.
- **Personas:**
  - `supportive`: `"A warm Oxford maths tutor who wants the student to succeed. Encourages thinking aloud, praises good reasoning and gives hints gently."`
  - `rigorous`: `"A demanding Cambridge maths interviewer who expects precise reasoning and presses on every unjustified step."`
- `asrKeywords`: `["irrational", "coprime", "lowest terms", "contradiction", "induction", "product rule", "derivative", "turning point", "asymptote", "e to the minus x"]`

**Problem 1: `sqrt2-irrational`**, title `"√2 is irrational"`
- statement: `Prove that √2 is irrational.`
- canvasHint: `Write your argument on the canvas as you go.`
- checkpoints:
  - `c1`: `Assumes for contradiction that √2 = p/q with p, q integers, q ≠ 0, and the fraction in lowest terms (p and q coprime).`
  - `c2`: `Squares to get p² = 2q² and deduces p is even, justifying that an odd number squared is odd.`
  - `c3`: `Writes p = 2k, derives q² = 2k², so q is even, contradicting lowest terms.`
- hintLadder:
  1. `What would it mean for √2 to be rational? Try assuming it is and see where that leads.`
  2. `If √2 = p/q, is there any assumption you can make about p and q that might be contradicted later?`
  3. `Square both sides. What does p² = 2q² tell you about whether p is odd or even?`
  4. `If p is even, write p = 2k and substitute. What does that say about q, and why is that a problem?`
- probes:
  1. `Does the same argument show that √4 is irrational? Where exactly does it break?`
  2. `How would you adapt this proof to show that √3 is irrational?`
- misconceptions:
  - `lowest-terms-missing`
    - signal: `Writes √2 = p/q without assuming the fraction is in lowest terms, so the final step has nothing to contradict.`
    - realign: `Before you go further, is there anything you're assuming about p and q? Think about what the contradiction will be at the end.`
  - `even-square-unjustified`
    - signal: `Claims p is even because p² is even with no justification, or argues the wrong direction (p even implies p² even).`
    - realign: `Hold on: you've said p² even means p is even. Can you justify that direction? What happens when you square an odd number?`
- solutionSketch: `Assume √2 = p/q in lowest terms. Then p² = 2q², so p² is even; since an odd number squared is odd, p is even, say p = 2k. Then 4k² = 2q², so q² = 2k² and q is even. Both even contradicts lowest terms, so √2 is irrational.`

**Problem 2: `sum-of-odds`**, title `"Sum of the first n odd numbers"`
- statement: `Show that the sum of the first n odd numbers is n² for every positive integer n.`
- checkpoints:
  - `c1`: `Checks small cases (for example 1, 1 + 3, 1 + 3 + 5) and states the pattern.`
  - `c2`: `Identifies the nth odd number correctly as 2n − 1.`
  - `c3`: `Gives a general proof: induction with a base case and the step n² + (2n + 1) = (n + 1)², or an equivalent pairing or geometric argument that works for all n.`
- hintLadder:
  1. `Try the first few values of n. What do you notice?`
  2. `What is the nth odd number, written in terms of n?`
  3. `Checking examples isn't a proof. Could induction help? What would you need to show to go from n to n + 1?`
  4. `Assume 1 + 3 + … + (2n − 1) = n². Add the next odd number, 2n + 1. Can you write the result as a perfect square?`
- probes:
  1. `Can you see a picture of why this is true, say with dots arranged in a square?`
  2. `What is the sum of the first n even numbers? Can you get it from this result?`
- misconceptions:
  - `examples-as-proof`
    - signal: `Checks several cases and concludes the statement is proved.`
    - realign: `Those examples are convincing, but they only cover the cases you've tried. How could you be sure it holds for every n?`
  - `off-by-one-odd`
    - signal: `Uses 2n + 1 as the nth odd number (or otherwise mis-indexes), so the algebra gives the wrong total.`
    - realign: `Let's check your formula for the odd numbers. When n = 1, what does your expression give? Is that the first odd number?`
- solutionSketch: `The nth odd number is 2n − 1. Base case n = 1: 1 = 1². Step: if 1 + … + (2n − 1) = n², adding 2n + 1 gives n² + 2n + 1 = (n + 1)². Alternatively, each odd number adds an L-shaped layer to an n × n square of dots.`

**Problem 3: `sketch-x-exp`**, title `"Sketch y = x·e^(−x)"`
- statement: `Sketch the graph of y = x·e^(−x). Show where it crosses the axes, any turning points, and what happens as x → ∞ and x → −∞.`
- canvasHint: `Sketch the curve on the canvas.`
- checkpoints:
  - `c1`: `Finds the only axis crossing at the origin and the sign: y < 0 for x < 0 and y > 0 for x > 0.`
  - `c2`: `Differentiates correctly with the product rule, dy/dx = e^(−x)(1 − x), and finds a maximum at (1, 1/e).`
  - `c3`: `Describes the end behaviour: y → 0⁺ as x → ∞ because the exponential decays faster than x grows, and y → −∞ as x → −∞.`
- hintLadder:
  1. `Start with the easy features: where does the curve cross the axes, and where is it positive or negative?`
  2. `To find turning points you'll need dy/dx. Which rule do you need for a product of x and e^(−x)?`
  3. `With dy/dx = e^(−x)(1 − x), where is it zero, and is that a maximum or a minimum?`
  4. `For large positive x, which wins: x growing or e^(−x) shrinking? What about large negative x, where e^(−x) is huge?`
- probes:
  1. `Where is the point of inflection, and how could you find it?`
  2. `How would the sketch change for y = x²·e^(−x)?`
- misconceptions:
  - `product-rule-error`
    - signal: `Differentiates as if it were a single term, for example dy/dx = −x·e^(−x) or dy/dx = e^(−x), missing a term of the product rule.`
    - realign: `Let's double-check that derivative. You have a product of two functions of x. What does the product rule give?`
  - `end-behaviour-wrong`
    - signal: `Says y → ∞ as x → ∞ because x grows, or says y → 0 as x → −∞.`
    - realign: `Think about the two factors separately as x gets large. One grows and one shrinks. Which one wins, and how fast?`
- solutionSketch: `Crosses the axes only at (0, 0); negative for x < 0, positive for x > 0. dy/dx = e^(−x)(1 − x) = 0 at x = 1, a maximum at (1, 1/e). As x → ∞, y → 0⁺ because exponential decay dominates; as x → −∞, y → −∞. Point of inflection at x = 2.`

#### `cs-oxbridge`
- `id` `"cs-oxbridge"`, `title` `"Oxbridge Computer Science Interview"`, `subject` `"Computer Science"`.
- **Personas:**
  - `supportive`: `"A friendly Cambridge computer science supervisor who wants the student to succeed. Encourages thinking aloud, praises good ideas and gives hints gently."`
  - `rigorous`: `"A demanding Oxford computer science interviewer who expects precise reasoning about correctness and complexity, and presses on every unjustified claim."`
- `asrKeywords`: `["sorted array", "binary search", "two pointers", "big O", "log n", "graph", "vertex", "degree", "parity", "balance scale", "log base 3"]`

**Problem 1: `pair-sum-sorted`**, title `"Pair sum in a sorted array"`
- statement: `You're given a sorted array of n integers and a target T. Decide whether two different elements of the array add up to T. Start with any correct method, then improve it.`
- checkpoints:
  - `c1`: `Gives a correct brute-force method (check every pair) and states it is O(n²).`
  - `c2`: `Uses the sorted order to improve: for each element a, binary-search for T − a, giving O(n log n).`
  - `c3`: `Describes the two-pointer method (one pointer at each end; move the left pointer up if the sum is too small, the right pointer down if it is too large), explains why it never skips a valid pair, and states it is O(n).`
- hintLadder:
  1. `What's the simplest method you can think of, even if it's slow? How long does it take?`
  2. `The array is sorted. For a given element a, what number are you looking for, and how quickly can you find it in a sorted array?`
  3. `Try one pointer at the start and one at the end. If their sum is too small, which pointer should move?`
  4. `When the sum is too large, the right element can't pair with anything between the pointers to make T. Why? Use that to argue no pair is missed.`
- probes:
  1. `What changes if the array isn't sorted? Can you still beat O(n²)?`
  2. `How would you count the number of pairs that sum to T, including duplicates?`
- misconceptions:
  - `same-element-twice`
    - signal: `Allows an element to pair with itself, for example reports a[i] + a[i] = T as a valid pair.`
    - realign: `Quick check: the question asks for two different elements. Does your method ever pair an element with itself?`
  - `wrong-pointer-move`
    - signal: `In the two-pointer method, moves both pointers at once, moves the wrong pointer, or can't justify why no pair is skipped.`
    - realign: `Let's slow down on the pointers. If the current sum is too small, which single move can increase it, and why is it safe to discard that element?`
- solutionSketch: `Brute force checks all pairs, O(n²). Binary search for T − a[i] among the other elements gives O(n log n). Two pointers i = 0, j = n − 1: if a[i] + a[j] < T then i++, if it is greater than T then j--, otherwise found; stop when i ≥ j. When the sum is too small, a[i] is too small to pair with any remaining element, so discarding it is safe (symmetrically for too large). O(n) time, O(1) extra space.`

**Problem 2: `odd-handshakes`**, title `"Odd handshakes"`
- statement: `At a party, some pairs of people shake hands. Prove that the number of people who shook an odd number of hands is even.`
- checkpoints:
  - `c1`: `Models the party as a graph: people are vertices, handshakes are edges, and each person's handshake count is their degree.`
  - `c2`: `Shows the total of all handshake counts is twice the number of handshakes, because each handshake is counted once for each of its two people, so the total is even.`
  - `c3`: `Concludes by parity: the people with even counts contribute an even amount, so the odd counts must sum to an even number, which requires an even number of odd-count people.`
- hintLadder:
  1. `Can you draw the party as a diagram? What would the people and the handshakes be?`
  2. `Add up everyone's handshake count. How does that total relate to the number of handshakes?`
  3. `So the total is even. Split the people into those with even counts and those with odd counts. What can you say about each group's sum?`
  4. `A sum of odd numbers is even exactly when there is an even number of them. Can you finish the argument?`
- probes:
  1. `Is it possible for exactly one person to have shaken an odd number of hands? Why not?`
  2. `Can everyone at a party of 5 shake exactly 3 hands? Justify your answer.`
- misconceptions:
  - `assumes-everyone-shakes-everyone`
    - signal: `Assumes every pair shakes hands (or some specific pattern) instead of an arbitrary set of handshakes.`
    - realign: `Careful: the question says some pairs shake hands, not all of them. Your argument needs to work for any set of handshakes.`
  - `parity-slip`
    - signal: `Argues that because the total is even, each person's count is even, or asserts the odd-count people number must be even without justification.`
    - realign: `The total being even doesn't make each count even. What do you actually know about a sum that includes some odd numbers?`
- solutionSketch: `Model as a graph. The sum of degrees counts each edge twice, so it equals 2E and is even. Even-degree vertices contribute an even total, so the degrees of the odd-degree vertices sum to an even number. A sum of k odd numbers has the same parity as k, so k is even.`

**Problem 3: `heavy-coin`**, title `"Finding the heavy coin"`
- statement: `You have 9 identical-looking coins; one is slightly heavier. Using a balance scale, what is the smallest number of weighings that always finds the heavy coin? Then generalise to n coins.`
- canvasHint: `Sketch your weighing plan on the canvas.`
- checkpoints:
  - `c1`: `Finds a 2-weighing strategy: split the coins 3–3–3, weigh two groups, then weigh two coins from the group that must contain the heavy coin.`
  - `c2`: `Explains why 1 weighing can't work: a weighing has only 3 outcomes (left heavier, right heavier, balance), which can't distinguish 9 possibilities.`
  - `c3`: `Generalises to the smallest k with 3^k ≥ n, i.e. ⌈log₃ n⌉ weighings, using the same three-way split together with the counting argument.`
- hintLadder:
  1. `How many different results can a single weighing give you?`
  2. `If each weighing can rule out two-thirds of the candidates, how should you split the 9 coins?`
  3. `Weigh 3 against 3. Whatever happens, how many candidates are left, and how do you finish in one more weighing?`
  4. `After k weighings you can tell apart at most 3^k cases. What does that say about the number of weighings needed for n coins?`
- probes:
  1. `What if you don't know whether the odd coin is heavier or lighter? How many coins can you handle with 3 weighings?`
  2. `Does your formula still work when n isn't a power of 3, say n = 10?`
- misconceptions:
  - `halving`
    - signal: `Splits the coins into two halves each time, getting about log₂ n weighings (for example 3 or 4 for 9 coins), missing that leaving a group off the scale gives information.`
    - realign: `Halving works, but is it the best you can do? When you weigh, what does it tell you if the scale balances?`
  - `ignores-balance-outcome`
    - signal: `Treats a weighing as a two-way result, ignoring that a balance also gives information, so the lower-bound argument uses 2^k.`
    - realign: `You've counted two possible results of a weighing. Is there a third? What does it mean when the scale balances?`
- solutionSketch: `Weigh 3 against 3: the heavier side, or the unweighed 3 if the scale balances, contains the coin. Then weigh 1 against 1 among those 3. That is 2 weighings. One weighing has only 3 outcomes, fewer than 9 cases, so 2 is optimal. In general k weighings distinguish at most 3^k cases, so the minimum is ⌈log₃ n⌉, achieved by splitting into three near-equal groups each time.`

### 2. `src/config/load.ts`
- Import both JSON files statically (relative path from `src/config/`; `resolveJsonModule` is already on).
- Parse each with `InterviewConfigSchema.parse` at module load, so an invalid config fails fast at import or build time.
- Exports:
  - `class ConfigError extends Error { code: "unknown_config" | "unknown_style" }`
  - `listConfigs(): { id: string; title: string; subject: string; styles: { id: string; label: string }[] }[]`, in a stable order: maths, then cs.
  - `getConfig(id: string): InterviewConfig`. Throws `ConfigError("unknown_config")` if `id` isn't known.
  - `getStyle(config: InterviewConfig, styleId: string): Style`. Throws `ConfigError("unknown_style")` if `styleId` isn't known.
- At load, also throw if two configs share an `id`.
- This module is isomorphic: it contains no secrets, so don't add `server-only`.

### 3. `src/engine/types.ts`
```ts
export type DecideEvent = Exclude<EngineEvent, { type: "start" }>;

export type DecisionReason =
  | "phase_inactive" | "end" | "closing" | "gated" | "interject_off_track"
  | "silence_short" | "silence_stuck" | "time_up" | "assessor_unavailable"
  | "solved_probe" | "solved_advance" | "solved_wrap_up"
  | "hints_exhausted_advance" | "hints_exhausted_wrap_up"
  | "off_track" | "stuck" | "progress";

export interface DecideInput {
  state: EngineState;
  event: DecideEvent;
  assessment: Assessment | null;   // null = not assessed or the assessor failed
  config: InterviewConfig;
  style: Style;
  now: number;                     // epoch ms, supplied by the caller
}

export interface DecideResult {
  state: EngineState;
  move: Move;
  interrupt: boolean;              // true only for mid-answer interjections (partial/canvas)
  reason: DecisionReason;
}
```

### 4. `src/engine/errors.ts`
`class EngineError extends Error { code: "bad_state" }`.

### 5. `src/engine/fsm.ts`
Exported constants:
- `TURN_OFF_TRACK_MIN_CONFIDENCE = 0.5`
- `PROBES_PER_PROBLEM = 1`

Exported helper:
- `countWords(text: string): number` returns the number of whitespace-separated non-empty tokens (`""` → 0).

#### `decide(input: DecideInput): DecideResult`
**Validation.** Throw `EngineError("bad_state")` if any of these hold:
- `state.configId !== config.id`
- `state.styleId !== style.id`
- `state.problemIdx` is out of range for `config.problems`

**Definitions** (with `problem = config.problems[state.problemIdx]`):
- `phase`: if `state.phase === "intro"`, treat it as `"problem"` and write `"problem"` into the returned state.
- `canInterject`: `state.lastInterjectAt === null || now − state.lastInterjectAt ≥ style.interjection.cooldownMs`
- `confidentOffTrack`: `assessment?.status === "off_track" && assessment.confidence ≥ style.interjection.minConfidence`
- `misconceptionFor(a)`: `a.misconceptionId` if it equals the `id` of one of `problem.misconceptions`, otherwise `null`
- `timeUp`: `now − state.startedAt ≥ config.timing.maxMinutes × 60_000`
- **Checkpoint merge.** Applied in the problem phase whenever `assessment !== null`, before the rules below run:
  - new `checkpointsHit` = existing ids (in their existing order), followed by ids from `assessment.checkpointsHit` that belong to `problem.checkpoints` and aren't already present
  - those new ids are appended in the order they appear in `problem.checkpoints`
  - unknown ids are ignored
- **`advanceOrWrap(prefix)`:**
  - If `problemIdx + 1 < problems.length`:
    - move `{type:"advance", toProblemIdx: problemIdx + 1}`
    - state: `problemIdx + 1`, `hintRung: -1`, `checkpointsHit: []`, `probesAsked: 0`, `turnWordBaseline: 0`
    - reason: `` `${prefix}_advance` ``
  - Otherwise: move `{type:"wrap_up"}`, `phase: "wrap_up"`, reason `` `${prefix}_wrap_up` ``.
- **`stuckMove(reason)`:**
  - `next = hintRung + 1`.
  - If `next < problem.hintLadder.length`: move `{type:"hint", rung: next}`, `hintRung: next`, with the given reason.
  - Otherwise: `advanceOrWrap("hints_exhausted")`.
- **`wrapUp(reason)`:** move `{type:"wrap_up"}`, `phase: "wrap_up"`.

**Rules, applied in this order** (the first match wins):
1. **`end` event:**
   - `phase === "done"` → `silent`, reason `phase_inactive`.
   - `phase === "problem"` → `wrap_up`, `phase: "done"`, reason `end`.
   - `phase === "wrap_up"` → `silent`, `phase: "done"`, reason `end`.
2. **`phase === "done"`** → `silent`, state unchanged, reason `phase_inactive`.
3. **`phase === "wrap_up"`:**
   - `turn_complete` → `acknowledge`, `turnWordBaseline: 0`, reason `closing`.
   - Anything else → `silent`, reason `phase_inactive`.
4. **Problem phase.** Apply the checkpoint merge, then go by event type:
   - **`partial`:**
     - `words = countWords(event.text)` and `newWords = max(0, words − turnWordBaseline)`.
     - If `canInterject && newWords ≥ minNewWords && confidentOffTrack`: move `{type:"realign", misconceptionId: misconceptionFor(assessment)}`, `interrupt: true`, `lastInterjectAt: now`, `turnWordBaseline: words`, reason `interject_off_track`.
     - Otherwise: `silent`, reason `gated`. The merged checkpoints are kept.
   - **`canvas`:**
     - Same as `partial`, but with no word gate.
     - On interjection, set `lastInterjectAt: now` and leave `turnWordBaseline` unchanged.
   - **`silence`:**
     - `event.ms < config.timing.silenceStuckMs` → `silent`, reason `silence_short`.
     - Else, if `timeUp` → `wrapUp`, reason `time_up`.
     - Else → `stuckMove("silence_stuck")`, with `turnWordBaseline: 0`.
   - **`turn_complete`:** always set `turnWordBaseline: 0`. Then:
     1. `timeUp` → `wrapUp`, reason `time_up`.
     2. `assessment === null` → `acknowledge`, reason `assessor_unavailable`.
     3. All of `problem.checkpoints` are in `checkpointsHit` (solved):
        - If `probesAsked < min(PROBES_PER_PROBLEM, problem.probes.length)`: move `{type:"probe", probeIdx: probesAsked}`, `probesAsked + 1`, reason `solved_probe`.
        - Otherwise: `advanceOrWrap("solved")`.
     4. `status === "off_track"` and `confidence ≥ TURN_OFF_TRACK_MIN_CONFIDENCE` → `realign(misconceptionFor(assessment))`, reason `off_track`.
     5. `status === "stuck"` → `stuckMove("stuck")`.
     6. Otherwise → `acknowledge`, reason `progress`.

`interrupt` is `false` for every result except the partial/canvas interjections. Any state field not mentioned in a rule passes through unchanged.

#### `shouldAssess(state, event, config, style, now): boolean`
This is a pure function. Stage 3 calls it to skip pointless model calls. It returns `true` only when:
- the phase (with `intro` treated as `problem`) is `"problem"`, **and**
- one of these holds:
  - `turn_complete` and `!timeUp`
  - `partial` and `canInterject` and `newWords ≥ minNewWords`
  - `canvas` and `canInterject`

`silence`, `end` and every other case return `false`.

### 6. `src/engine/state.ts`
Update it for the contract change. There are no other changes.

---

## Tests (`vitest`, in `tests/`)

### `tests/configs.test.ts`
- `listConfigs()` returns `maths-oxbridge` then `cs-oxbridge`, each with styles `supportive` and `rigorous`.
- `getConfig` returns a schema-valid config. An unknown id throws `ConfigError` with code `unknown_config`. `getStyle` with an unknown style throws code `unknown_style`.
- **Content rules**, checked for every config:
  - 3 problems
  - each problem has exactly 3 checkpoints, a hint ladder of 3–4 rungs, at least 2 probes and at least 2 misconceptions
  - rubric criteria ids are exactly `approach`, `rigour`, `communication`, `responsiveness`, each with scores `1, 2, 3, 4` in order
  - `asrKeywords` is non-empty
  - `rigorous.minConfidence < supportive.minConfidence` and `rigorous.cooldownMs < supportive.cooldownMs`
- **Spot-check transcription:**
  - `maths-oxbridge` problem 3 `c2` contains `e^(−x)(1 − x)`
  - `cs-oxbridge` problem 3 `c3` contains `3^k ≥ n`

### `tests/fsm.test.ts`
- Build fixtures with a small **test-only config factory** inside the test file: 2 problems, each with 2 checkpoints, 2 hint rungs, 2 probes and 1 misconception, plus explicit interjection numbers. This keeps content edits from breaking FSM tests.
- Add one smoke test that runs `decide` against the real `maths-oxbridge` config.
- Cover **each** of these with its own test:
  1. Validation: a configId mismatch, a styleId mismatch and an out-of-range `problemIdx` each throw `EngineError("bad_state")`.
  2. An `intro` phase is treated as `problem`, and the returned state has `phase: "problem"`.
  3. `end` in each of the three phases. Check move, phase and reason.
  4. `done` phase: every event type returns `silent`/`phase_inactive` with the state deep-equal to the input.
  5. `wrap_up`: `turn_complete` → `acknowledge`/`closing`; a partial → `silent`.
  6. **Partial interjection:** fires when all three gates pass; `interrupt` is true, `lastInterjectAt === now`, and `turnWordBaseline` equals the word count.
  7. Partial blocked by **each gate separately**, each returning `silent`/`gated`:
     - cooldown not elapsed
     - too few new words (including the baseline subtraction after an earlier interjection in the same turn)
     - confidence below `minConfidence`
     - status isn't `off_track`
     - assessment is `null`
  8. **Cooldown boundary:** `now − lastInterjectAt === cooldownMs` is allowed; one ms less is blocked.
  9. A partial with an unknown `misconceptionId` → `realign` with `misconceptionId: null`.
  10. **Canvas:** an interjection happens without the word gate and leaves `turnWordBaseline` unchanged; canvas is still blocked by the cooldown.
  11. **Silence:** below the threshold → `silence_short`. At or above it → a hint with the next rung. With the ladder exhausted → advance; on the last problem → `wrap_up` with `hints_exhausted_wrap_up`.
  12. **`turn_complete` paths:**
      - `assessor_unavailable`
      - `stuck` → hint rungs 0, then 1, then exhausted → advance
      - `off_track` at confidence 0.5 → realign; at 0.49 → `acknowledge`/`progress`
      - `progressing`/`partial`/`correct`-but-unsolved → `acknowledge`/`progress`
  13. **Solved:**
      - first `probe {probeIdx: 0}` with `probesAsked` 1
      - next solved turn → `advance` with the problem-local fields reset
      - on the last problem → `wrap_up`/`solved_wrap_up`
      - a problem with 0 probes → advances immediately
  14. **Checkpoint merge:** keeps order, ignores unknown ids, doesn't duplicate, also merges on partial and canvas events, and is not applied when the assessment is `null`.
  15. **`timeUp`:** on `turn_complete` and on a qualifying `silence` → `wrap_up`/`time_up`. A partial while time is up → still governed by the partial rules; there is no time check for partials.
  16. `turnWordBaseline` is reset to 0 by `turn_complete` and by a silence hint.
  17. **Purity:** deep-freeze the inputs (state, config, style, assessment) and call every rule path. Nothing throws, and calling twice with the same input gives deep-equal output.
  18. **`shouldAssess`:**
      - true for `turn_complete` (not time up), a gated-open partial and a gated-open canvas
      - false for `silence`, `end`, a non-problem phase, a partial in cooldown or with too few new words, and a `turn_complete` when time is up
- Also add `countWords` tests: `""`, extra whitespace and newlines.

---

## Acceptance criteria
1. `npm run typecheck`, `npm run lint` (0 warnings), `npm test` and `npm run build` all pass.
2. Searching for `wordsSinceInterject` finds nothing in `src/` or `tests/`.
3. `src/engine/fsm.ts` has no `Date.now`, `Math.random`, `console`, `fetch` or `process`, and its only imports are from `@/contracts` and `src/engine/`.
4. Every numbered rule above has at least one test that fails if the rule is changed. The reviewer will revert rules one at a time to check.
5. No files are changed outside the allowed list.
