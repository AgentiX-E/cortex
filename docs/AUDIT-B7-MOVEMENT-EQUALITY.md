# AUDIT — The Criterion's Movement Equality

**Status:** instrument defect found on the first real A/B, fixed with tests
(`outcomeMoved`), and the A/B re-read. A second, adjacent defect in the noise
tool was found by the same invocation and fixed in §7.
**Found by:** reading C5 through `tools/read-b7-criterion.mjs` for the first time
on real artifacts, which is the only step that could have found it.

---

## 1. Conclusion first

The B7 criterion decided whether a question **moved** by comparing its answer
**text**:

```ts
const changed = before !== after;
```

On the real C5 arms this returned `REGRESSION` naming four non-target questions,
and **not one of the four had changed correctness**:

| id         | control                     | feature                     | correct       |
| ---------- | --------------------------- | --------------------------- | ------------- |
| `6aeb4375` | `…report the value…: four.` | `Let me work through this.` | **true → false** |
| `71017276` | `4 weeks ago`               | `4`                         | true → true   |
| `945e3d21` | `three times a week`        | `Three times a week`        | true → true   |
| `6ae235be` | `…alkylation, and hydrotreating` | `…alkylation, hydrotreating` | true → true |

`945e3d21` differs by one capital letter. `6ae235be` differs by one conjunction.
Both were reported as regressions, and the non-target clause is checked **first
and cannot be overridden by a target gain** — so two spelling-level edits
rejected the entire arm with the severest verdict the criterion can return.

**A language model never reproduces its own wording byte for byte.** A guard
that fires on capitalisation therefore fires on every arm such a model can
produce, which is the same as not having a guard: the criterion becomes
unpassable and `REGRESSION` becomes its default answer. That is the state it was
in.

## 2. The fix, and why the equality has to be one function

The test now lives in one exported function, `outcomeMoved`, used by **both**
clauses:

1. **Both sides scored** → compare the scores. This is the only case where "the
   outcome changed" is directly observed.
2. **Either side unscored** → compare against **abstention** only. An arm that
   stopped producing an answer did move, and that is visible without a scorer; an
   arm that merely reworded did not, and claiming so needs evidence the criterion
   does not have.

`ArmOutcome` gains an optional `correct`. **Absent means unscored, not wrong** —
reading absence as `false` would be the same substitution that makes a recording
gap look like a reader failure one layer up (`AUDIT-PERSISTED-NULLS.md`).

## 3. The second consequence: two instruments, two equalities

The defect also explains a disagreement that had looked like a contradiction.
Given the **same pair of C5 arms**:

| tool                            | compared        | moves reported |
| ------------------------------- | --------------- | -------------- |
| `read-b7-criterion.mjs`         | answer **text** | 4              |
| `quantify-endpoint-noise.mjs`   | **correctness** | 1              |

Both were labelled "movement". Neither said which it meant. §20.7 had already
recorded an A/B whose arms differed by 2 questions and whose artifacts could not
name them; this is the same family — **a count is not a definition**.

The reader now calls `outcomeMoved` and prints a **movement census**, so the
nine reworded questions are accounted for explicitly rather than disappearing
from every count. Without that line, the disappearance would be indistinguishable
from "the arms were identical".

## 4. Verified effect on the real arms

|                              | before | after |
| ---------------------------- | ------ | ----- |
| non-targets reported moved   | 4      | **1** |
| of those, real score changes | 1      | **1** |
| reworded-only, reported      | 3      | **0** (reported separately: 9) |

The surviving regression is real and is not a measurement artifact:

> `6aeb4375` — *How many Korean restaurants have I tried in my city?* — gold
> `four`. The control arm answered `four` and was scored correct; the feature arm
> emitted `Let me work through this.` and was scored wrong.

So the verdict is still `REGRESSION`, now for a reason a reader can check. The
criterion went from unpassable to informative without being weakened: every case
it was written to catch it still catches, and the case it was never written to
catch — a reworded answer the scorer passed — no longer fires it.

## 5. Two tests had fixed the defect as a contract

```ts
it('reports regression when a non-target changes at all', () => {
  const verdict = judgeCriterion({
    cohort: cohortOf(['t1']),
    control: arm(['t1', 'wrong'], ['n1', 'a']),
    feature: arm(['t1', 'right'], ['n1', 'b']),
  });
  expect(verdict).toEqual({ kind: 'regression', regressed: ['n1'] });
});
```

`'a'` and `'b'` are both **unscored**, so "the text changed" and "the outcome
changed" are the same observation in this fixture: it passes identically whether
the criterion compares bytes or scores, and so it certified the defect. It is the
same failure mode as the `read-b7-criterion.test.ts` case that documented a
recording gap as reader behaviour. Both now use scored fixtures.

The lesson generalises: **a fixture that cannot distinguish the two states cannot
test which one the code reads.**

## 6. Coverage and gates

| gate                                      | result                                    |
| ----------------------------------------- | ----------------------------------------- |
| `b7-cohort.ts` (stmt / branch / fn / line) | **100 / 100 / 100 / 100**                 |
| `b7-cohort.test.ts`                        | 45 → **56** tests                         |
| `read-b7-criterion.test.ts`                | 16 → **17** tests                         |
| `pnpm check`                               | green                                     |
| CI-equivalent tree (`git archive HEAD`, **no `.git`**) | 48 files / **1479 tests**, exit 0 |
| `export-census.mjs --check`                | **no new orphans** (`outcomeMoved` has a real caller) |

The census gate fired on `outcomeMoved` before it was wired, which is the gate
working: the choice was to give it a caller, not to record a new debt. The
reader's movement census is that caller, and the tool that needed it most is the
one that disagreed with the criterion.

## 7. The adjacent defect: a floor computed across configurations

Reading the noise tool on the same C5 artifacts exposed a second defect, in the
tool rather than the criterion — and it is the more consequential of the two,
because **every A/B verdict is judged against this number**.

The tool printed each run's `featureConfig`, then titled the next block:

```
--- endpoint movement (same configuration, repeated) ---
overall: min 49, max 50, mean 49.50, range: 1 questions (1.67 pp)
```

The two runs were the C5 **control and feature arms**, differing in
`retrievalSides` (off vs on). **The detail was printed, and the heading
contradicted it.** That is worse than omitting the detail: a reader who trusted
the heading got a floor that measures the switch, and a reader who checked the
configs got no warning that the number below was unusable.

Two arms that differ in a switch measure **the switch**. A floor has to bound the
endpoint's own restlessness, and restlessness is only visible when nothing else
changed.

The heading now depends on the comparison:

| runs recorded | heading | warning |
| ------------- | ------- | ------- |
| same config | `(same configuration, repeated)` | none |
| different config | `(runs with DIFFERENT configurations -- NOT a floor)` | names the differing key(s): `retrievalSides (off vs on)` |

Configurations are compared **key by key**, not as JSON text: `featureConfig` is
serialized from an object literal, so key order varies between producers and a
textual comparison would warn on identical configurations — training the reader
to ignore the warning.

### 7.1 The method error underneath it

Chasing this produced a conclusion about the method, not just the tool:

> **A floor cannot be computed from one A/B pair at all**, because an A/B pair is
> _defined_ by a configuration difference.

The floor has to come from repeats **within** each arm. The tool's own docstring
already said this ("Every input must be the SAME configuration: this tool
measures noise, and a set of runs that differ in their switches measures the
switches instead") — the code then did the opposite, because the input it was
first handed was the one shape the docstring warned about. **The docstring was
right and the invocation was wrong, and nothing in the output said so.**

The floor for C5 is therefore **not yet measured**, and cannot be until each arm
is dispatched more than once. The available figure — 1 question moved between the
arms, `6aeb4375`, correct → wrong — is a **cross-configuration delta** and is
exactly the quantity the criterion's verdict is about, not a bound on it.

---

## 8. The floor, measured: C5 is zero and `6aeb4375` was noise

§7.1 concluded the floor could not be computed from one A/B pair and had to come
from repeats **within** each arm. Four dispatches were made on one SHA
(`4837759b`) — control × 2 (`retrievalSides=off`, runs `#386`/`#388`), feature × 2
(`retrievalSides=on`, runs `#387`/`#389`) — and all four finished `success`.

### 8.1 The arms' own floors

| arm | runs | correct | questions moved | count range |
| --- | ---- | ------- | --------------- | ----------- |
| control (`off`) | #386 / #388 | 52 / 51 | 1 (`32260d93`) | 1 |
| feature (`on`) | #387 / #389 | 51 / 50 | **3** (`0a995998`, `6aeb4375` out; `32260d93` in) | 1 |

Both arms' count-based range is 1, so both would yield a bar of 2. The feature
arm's **roster** movement is 3 — three times its score range.

### 8.2 Only three questions moved, and they do not follow the switch

| question | capability | #386 off | #388 off | #387 on | #389 on |
| -------- | ---------- | -------- | -------- | ------- | ------- |
| `0a995998` | MR | ✅ | ✅ | ✅ | ❌ |
| `6aeb4375` | KU | ✅ | ✅ | ✅ | ❌ |
| `32260d93` | IE | ✅ | ❌ | ❌ | ✅ |

The other **57 questions are stable across all four runs**. The three that move
are not grouped by arm: `32260d93` flips once in each arm. This is decoding
unsteadiness, not a retrieval effect, and `6aeb4375`'s answer text shows the
mechanism directly:

```
#386  'four'                                                            ✅
#388  'The question has no time qualifier, so report the value from the latest turn: fo…'  ✅
#387  'The question has no time qualifier, so report the value from the latest turn: fo…'  ✅
#389  'Let me work through this chronologically.'                       ❌
```

`#389` emitted a reasoning preamble instead of an answer.

**`6aeb4375` is the question §7.1 named as the only movement between the arms.**
With within-arm repeats it is shown to be noise. §7.1's figure was wrong for
exactly the reason §7.1 itself diagnosed: a cross-configuration delta was being
read as a bound on the verdict rather than as the quantity under discussion.

### 8.3 The C5 effect is 0.00 questions, and B7's is +9

`ablation.delta` is byte-identical across all four runs:

| run | sides | baseline | feature | delta | McNemar p | B→W | W→C |
| --- | ----- | -------- | ------- | ----- | --------- | --- | --- |
| #386 | off | 0.7167 | 0.8667 | **+9.0** | 0.003906 | 0 | 9 |
| #388 | off | 0.7000 | 0.8500 | **+9.0** | 0.003906 | 0 | 9 |
| #387 | on | 0.7000 | 0.8500 | **+9.0** | 0.003906 | 0 | 9 |
| #389 | on | 0.6833 | 0.8333 | **+9.0** | 0.003906 | 0 | 9 |

The **discordant set is the same nine `_abs` questions** every time, with B→W
always 0 and W→C always 9.

```
mean control delta = +9.00 questions
mean feature delta = +9.00 questions
C5 (retrievalSides) effect = +0.00 questions
```

### 8.4 Verdicts

| question | answer | evidence |
| -------- | ------ | -------- |
| Does B7 work? | **Yes: +9 questions / +15 pp, p=0.0039, 4/4 repeatable** | the delta's range is **0.0** against an effect of 9 |
| Does C5 (`retrievalSides`) contribute? | **No: 0.00 questions** | identical mean delta in both arms; effect **below** the floor |
| Should C5 ship? | **No** | zero effect, zero repeatability gain, one extra retrieval branch |

This is not "unmeasurable". It was measured, and it measured zero.

> **Rule added here.** **An effect of exactly zero and an effect that cannot be
> measured are different conclusions, and the only way to tell them apart is to
> run the same configuration more than once.** §7 stopped at "refuse to report";
> this section refuses the feature.

## 9. The bar had been derived from the score, and the roster moved three times further

### 9.1 The defect

`quantify-endpoint-noise.mjs` printed the bar, then printed a **warning** below it
saying the bar was too low:

```
minQuestionsStrictlyGreaterThan: 2
...
WARNING: the count-based range is 1 questions but up to 3 questions moved
```

The evidence needed to correct the bar was computed **after** the bar had already
been emitted, and the correction was advisory text on the next screen. An arm
judged against `2` would clear it while the endpoint's demonstrated movement was
`3`.

### 9.2 The fix

`requiredEffectSize` now takes the pairwise roster movements and derives the bar
from the **larger** of the two measurements:

```ts
const movement = rosterChanged ?? 0;
const floorQuestions = Math.max(stats.rangeQuestions, movement);
return {
  rangeQuestions: stats.rangeQuestions,
  floorPp: stats.spreadPp,
  minQuestionsStrictlyGreaterThan: Math.max(1, floorQuestions + 1),
  rosterChanged: movement,
};
```

Measured effect on the real feature arm:

| capability | bar before | bar after |
| ---------- | ---------- | --------- |
| overall | 2 | **4** |
| ABS | 1 | **4** |
| IE | 2 | **4** |
| KU | 2 | **4** |
| MR | 2 | **4** |
| TR | 1 | **4** |

The control arm is unchanged at 2, because there the range already equalled the
roster movement. **The fix raises a bar and never lowers one**, so a caller that
supplies no movements keeps exactly the old, under-cautious figure.

The `WARNING` is now a `floor source:` line naming which of the two figures set
the bar — because a single printed number derived from two measurements does not
say which one it came from.

### 9.3 What the fix does not claim

Per-capability bars take the **overall** roster movement, not a per-capability
one: attributing a flip to a capability needs a second pass this module does not
have, and using the overall figure is the conservative direction — it can only
raise a capability's bar.

The number of movement figures is checked against `n * (n - 1) / 2`. A caller
that passes the wrong count has derived its pairs differently from this module,
and a bar built from two notions of "pair" would average incommensurable things.

### 9.4 The census gate caught a real gap in this change

Making `PairwiseMovement` a new export produced `1 NEW orphan`:

```
cortex-eval: PairwiseMovement (packages/cortex-eval/src/variance.ts:157)
```

Not a false positive. `tools/*.mjs` are counted as callers but never as
declaration sites, so a type only the CLI names has **no TypeScript-side
consumer at all**. The gate's own self-check then caught a second thing: adding
the entry to `knownOrphans` alone left `locations` short by one, failing

```
expect(sites).toBe(orphaned);   // 276 !== 277
```

Both were fixed — the export is recorded in the ledger with the reason above, and
`locations` now carries it, so `448 = 171 + 277` holds again.

> **Rule added here.** **A ledger with two parallel counts will drift, and the
> drift is only visible because something asserts the two counts agree.**

## 10. The census was blind to the benchmark's own entry point

### 10.1 The triage, and what it found

The `eval-harness-surface` group (119 sites) had never been triaged entry by entry
— its rationale said so — and was described as "the one most likely to hold
genuine defects". So it was triaged, by a mechanical question rather than a
reading: **does the file that declares this name also use it somewhere else?**

| classification | count | meaning |
| -------------- | ----- | ------- |
| referenced inside its own declaring file | 221 (79%) | an unnecessary `export` on code that runs |
| referenced from `index.ts` only | 79 | public surface of a package |
| has a non-test caller the census missed | 41 | **census blind spot** |
| mentioned **nowhere** at all, any line, any file | **0** | — |

**Zero.** There is no dead code in this bucket. What there is, is an `export`
keyword on work that runs: 79% of the orphans are used a few lines below where
they are declared.

### 10.2 The 41 that the census missed

`readAllSources` walked `packages/<pkg>/src` and `tools/*.mjs` **and nothing
between them**. `packages/cortex-eval/bench/run.ts` — the benchmark's actual
entry point, 1052 lines that name the export surface directly — is in neither.
Neither walk saw it.

Forty exports were therefore reported as orphans whose only production caller is
that file, among them `createLlmFromEnv`, `createRerankerFromEnv`,
`sampleInstances`, `tableEmbedding`, and **eight `run*Ablation` functions**.

### 10.3 The fix, and its measured effect

The walk now covers the whole workspace, with `dist`, `node_modules` and
`__tests__` excluded.

| metric | before | after |
| ------ | ------ | ----- |
| orphaned exports | 277 | **235** |
| with a non-test caller | 171 | **213** |
| ledger entries removed | — | **40** |
| new orphans introduced | — | **0** |

Zero new orphans appeared, so all forty were pure false positives. The ledger is
one entry shorter per real caller, not per preference.

### 10.4 Why this matters more than the count

> **A gate that reports live entry-point calls as dead teaches its readers to
> ignore the list, and that is the one outcome a debt ledger cannot survive.**

The forty were not noise in a cosmetic sense. They were the gate asserting
something false about the repository — that the benchmark entry point calls
nothing — and doing so at 15% of its total output. A reader who checks three
entries, finds three wrong, and stops reading has been made *less* likely to find
the genuine orphan the gate exists to catch, which is the B7 defect that started
this whole line of work.

The census also cannot currently express "referenced, but only inside its own
file" as a distinct state from "referenced by nothing". That distinction is why
the number stays at 235 while the defect count is zero, and it is the next thing
this measurement should learn to say.

## 11. The gate that was never running

### 11.1 The finding

`.github/workflows/` held one file and its only trigger was `workflow_dispatch`.
There was no `push` trigger and no `pull_request` trigger anywhere in the
repository.

So `pnpm check` — unit tests, coverage floors, lint, typecheck, the export
census, formatting — **ran when somebody remembered to ask**. Every green CI
result recorded in the delivery log was a run that had been dispatched by hand,
and a push that broke the build produced no signal at all until the next
dispatch.

### 11.2 Why it was invisible for so long

Because a dispatched run and a triggered run are **indistinguishable from the
outside**. Both produce a badge-shaped artifact, both report `success`, both name
the SHA. The delivery log recorded "CI green" and the phrase was true of every
run it described. What was false was the implication that a green check meant
the tree had been verified — the tree had been verified *on request*.

It stayed invisible for the same reason as the defects before it: **the check
that would have caught it was the check that was missing.**

### 11.3 The fix, and the evidence it works

`.github/workflows/verify.yml` adds `push` and `pull_request` triggers and calls
the same `pnpm check` the pre-push hook calls, under `set -o pipefail`, with the
transcript uploaded on failure so a red run is diagnosable without a second
dispatch. It is a separate file from `benchmark.yml` because the two have
opposite shapes: this one must run on every push and finish in minutes, while the
benchmark needs the LongMemEval corpus, network model downloads and up to four
hours, and is dispatched deliberately.

The evidence is not that the file exists. It is that **the very next push
produced a run**:

```
#1   10367259 Verify  in_progress  None  event=push
...
#1   10367259 Verify  completed   success  event=push
```

That is the first `event=push` run in the repository's history, and it finished
green. Every prior run was `event=workflow_dispatch`.

It also settles a question this project had been guessing at: the Git Data API
push path **does** deliver `push` events. The four earlier pushes produced no runs
because no workflow listened, not because the API bypasses the event.

### 11.4 The tests

Four assertions in `repo-gates.test.ts`:

1. some workflow triggers on `push` or `pull_request` — asserted over the **set**
   of workflows, so moving the gate between files cannot silently remove it;
2. the `push:` block is scoped with `branches:` rather than filtered to nothing —
   a key that is present but matches no branch would satisfy a check for the key;
3. the step runs `pnpm check` under `set -o pipefail` — without `pipefail`, `tee`
   reports its own success and hides the failing gate behind it;
4. `Setup Python` and the `requirements-dev.txt` install precede the gate.

Assertion 4 was written first against string offsets, and it **failed on a
correct workflow** because the file's own explanatory comment mentions
`actions/setup-python` above the step that uses it. It now asserts over the
ordered list of step **names**, which is a property of the workflow rather than
of its prose.

> **Rule added here.** **A gate you have to remember to run is a gate that is not
> running, and a green result cannot tell you which kind it was.** The only way to
> tell is to check what the gate is attached to.
