# AUDIT-UNREFERENCED-CLASSES

**Scope:** the 30 exports no file refers to, classified by **why** they are unreferenced
rather than by whether they are.
**Verdict:** §28's two-way split — *tested-but-unwired* (29) versus *zero-referenced* (1) — is
**true and not actionable**. It groups four different situations under one label, and one of
them is a genuine defect that the split actively hides: **two exports are not unwired but
superseded**, and a live replacement for them is already running in production.

Measured at revision `00a81c7`.

---

## 1. The 29-versus-1 split is correct and too coarse

`AUDIT-UNREFERENCED-EXPORTS.md` established the headline: of 31 unreferenced exports, 29 are
exercised by tests and 2 are not. That measurement survives re-derivation. What it does not
survive is being used as a **disposition**, because "has a test and no production caller"
describes four unrelated situations:

| Situation | Signature | Correct action |
| --- | --- | --- |
| **Library surface** | A public API of a package meant to be consumed as a library | Keep. The absence of an in-repo caller is the point. |
| **Test instrument** | Exists so a test can observe or reset something | Keep, but the docstring must stop implying a production consumer. |
| **Built-but-unwired** | A feature with a complete implementation and no caller | Wire it, or delete it with its tests. The B7 class. |
| **Superseded** | An earlier implementation that a newer one replaced in place | **Delete.** Keeping it is worse than dead code — it is a second, divergent answer to a question already answered. |

Only the last one is a defect with a mechanical remedy, and it is invisible under a
two-way split.

---

## 2. Method

Three questions per symbol, each answered by a command rather than by reading:

1. **Who mentions it outside a test?** → a script over all `.ts`/`.mjs` in `packages/`,
   excluding `__tests__` and `*.test.ts`.
2. **Does a test mention it?** → the same script, restricted to test files.
3. **Is there a live implementation of the same question?** → for each symbol, whether a
   different export in the same package performs the same job and **has a production
   caller**.

Question 1 produced a clean result that makes the rest tractable:

> **All 30 have exactly one non-test mention, and in every case it is the package barrel
> re-export.** Not one has a production caller. The census's `unreferenced` class is
> therefore exactly what it says, with no near-misses.

Question 2 reproduces §28: 29 have tests, 1 does not.

### 2.1 The script that answers questions 1 and 2

```python
un = [re.match(r'([\w-]+): (\S+) \((.*):(\d+)\)', e) for e in census['unreferenced']]
def mentions(name, pool):
    p = re.compile(r'(?<![A-Za-z0-9_$])' + re.escape(name) + r'(?![A-Za-z0-9_$])')
    return [f for f in pool if p.search(open(f, encoding='utf8').read())]
```

The boundary guards (`(?<!…)` / `(?!…)`) matter: without them `currentValue` matches inside
`previousCurrentValue` and the classification inverts.

---

## 3. Question 3 finds the one defect the split hid

### 3.1 `cortex-eval: isTemporalQuestion` and `cortex-eval: extractDate`

`packages/cortex-eval/src/temporal.ts` opens with a module docstring that makes a claim:

```ts
/**
 * Temporal-reasoning primitives for LongMemEval-style benchmarks. Temporal
 * questions require reasoning over turn timestamps: "how many days between X and
 * Y", "how many weeks ago did I do X", "which happened first". These helpers
 * extract the turn date, compute elapsed days, and detect the question shape so
 * the system can route temporal questions to a dedicated answering path.
 */
```

**That routing exists.** It is not in this file. It is in `temporal-engine.ts`:

```
packages/cortex-eval/src/temporal-engine.ts:81
export function classifyTemporalQuestion(question: string): TemporalKind { … }

packages/cortex-eval/src/natural-language-memory.ts:581
    const kind = classifyTemporalQuestion(question);
```

So the situation is **not** "a feature was described and never built" — the B7 shape that
§28 assigned to all 29. The feature was built, twice. `classifyTemporalQuestion` replaced
`isTemporalQuestion`, and the docstring of the **older** file still describes the newer
file's job.

### 3.2 The replacement is strictly better, and demonstrably so

`isTemporalQuestion` returns a boolean from three regex alternations:

```ts
export function isTemporalQuestion(question: string): boolean {
  return /\b(how many (days|weeks|months|hours)|ago|before or after|happened first|which .* first|order from first)/i.test(question);
}
```

`classifyTemporalQuestion` returns a five-way kind, and its extra structure is not decoration
— it encodes a **disambiguation the boolean cannot express**:

```ts
// Only "how many X ago/since/passed" asks for an elapsed-time count. An
// event-lookup question ("Which book did I finish a week ago?") asks for the
// event itself, not a number, so it must NOT be classified as relative.
if (/\bhow many\b/i.test(question) && /\b(ago|since|passed)\b/i.test(question)) {
  return 'relative';
}
```

The older function's `ago` alternative matches *"Which book did I finish a week ago?"* and
answers `true`, routing it toward date arithmetic — the exact error the replacement's comment
names. **The two functions do not merely differ in fidelity; they disagree, and the older one
is wrong on a case the newer one documents.**

### 3.3 Why this is worse than dead code

Dead code costs maintenance and misleads a reader about the *repository*. A superseded export
misleads a reader about the *answer*: it is a second, divergent implementation of a question
the package has already answered, sitting in the public barrel, reachable by any consumer, and
tested — so its tests certify the wrong classifier.

The test file makes the cost concrete:

```
packages/cortex-eval/src/__tests__/temporal.test.ts
  describe('isTemporalQuestion')    ← 2 tests certifying the superseded classifier
  describe('extractDate')           ← 2 tests
  describe('daysBetween')           ← 4 tests, certifying a LIVE function
```

Four tests belong to the live `daysBetween` and must survive; four certify the superseded
pair and go with it.

### 3.4 The module is not dead, only two-thirds of it

`temporal.ts` itself stays. `daysBetween` is imported by the live engine:

```
packages/cortex-eval/src/temporal-engine.ts:16
import { daysBetween } from './temporal.js';
```

That is why the census classifies the two functions rather than the file: a per-file reading
would have either deleted a live dependency or kept two superseded ones.

---

## 4. The other 27: no defect, and why the census cannot say so

Every remaining symbol is a legitimate public API of its package. The census's `unreferenced`
class is a **measured fact about call sites**, and for these it is measuring the intended
state:

| Group | Members | Why no in-repo caller is correct |
| --- | --- | --- |
| Storage backends | `PgStorage`, `SqliteStorage`, `ensurePgSchema` | `interfaces/storage.ts` defines the contract; these are two implementations of it, selected by a consumer that lives outside the repo or in `bench/`. |
| Cognitive primitives | 13 in `cortex-core` (`consolidate`, `createMemory`, `decideWrite`, `decideRetrieval`, `resolveContradiction`, …) | Exported from the barrel because the package *is* the cognitive library. `index.test.ts` asserts 13 of them are functions, so the barrel surface is itself under test. |
| Measurement helpers | `candidateSpanCount`, `flattenTurns`, `sidesLandInDistinctClusters` | Produce numbers that a reader reads, not values a program branches on. Their consumer is the person interpreting a report. |
| Environment adapters | `createEmbeddingFromEnv`, `createLongMemEvalMini`, `generateSyntheticBenchmark` | Factory/builder entry points for the evaluation harness, driven from `bench/` and from operator commands. |
| Aggregation | `createRetryStatsAggregate`, `runEmbeddingBenchmark` | Same shape as the above for the LLM and runner layers. |

`cortex-eval: FactMemorySystem` deserves its own note: it is a **whole reference
implementation** of the `MemorySystem` interface used to demonstrate the M2 feature through
the harness. Six test files reference it. It is the clearest case of "public surface with no
in-repo caller" in the set, and deleting it would remove the executable documentation of the
interface.

`cortex-eval: clearJudgeCache` is the one that needs a **docstring** fix rather than a code
fix. Its comment says:

> Clear the shared judge-verdict cache (used by tests and long-running processes).

Only tests call it. The second half of that sentence is the same claim-shape as §3.1, but the
consequence is different: the function is correctly factored (a long-running process
genuinely would want it), and the sentence is a prediction about future callers rather than a
description of a deleted one. It is recorded here so the class is complete, and the docstring
is corrected to stop asserting a consumer that does not exist.

---

## 5. Result

| Class | Count | Disposition |
| --- | --- | --- |
| Superseded by a live implementation | **2** | **Delete** (with their 4 tests) |
| Zero-referenced | 1 | Roadmap call (`ProvenanceNode`) — **resolved: deleted, superseded by `Fact`**. See `DECISION-PROVENANCE-NODE.md` |
| Public surface, tested, correctly unwired | 27 | Keep; correct one docstring — **re-examined by `AUDIT-UNREFERENCED-GROUPS.md`**: 26 confirmed as surface, **1 was a defect, not surface** (`isCandidateDiscriminationEnabled`, an inert switch; deleted) |

`AUDIT-UNREFERENCED-EXPORTS.md` is **amended, not superseded**: its 29/2 split is a correct
measurement. What changes is the reading of the 29 — one of them was never the B7 class at
all.

---

## 6. What this document does not claim

**It does not claim the census should report supersession.** Deciding that two functions
answer the same question requires understanding what they compute; a call-site census counts
references and cannot see it. The value here is that the census **narrowed 452 exports to 30
candidates**, which is what made a per-symbol question cheap enough to ask.

**It does not claim the other 27 should stay unexamined.** It claims that for each of them the
evidence points to public surface rather than a defect, and records the evidence. If a
consumer outside the repo is retired, the questions reopen.

**It does not claim `isTemporalQuestion` was always wrong.** It was correct when written, and
its regexes still pass the tests written for it — those tests assert the behaviour, and the
behaviour is unchanged. What changed is that a better classifier now exists and the tests were
never told.
