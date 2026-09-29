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
