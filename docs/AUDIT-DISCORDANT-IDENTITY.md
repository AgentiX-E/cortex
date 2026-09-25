# AUDIT — The Discordant Identity Gap

**Status:** instrument defect found, fixed, and tested (`discordantQuestions`); the
archived artifacts it affects cannot be repaired retroactively.
**Found by:** roadmap item 9b, which asked for the conjunction arm's four
regressions to be _located_ and discovered that no artifact could locate them.

---

## 1. What 9b asked for, and why the second half was impossible

Item 9b read:

> 复核 conjunction 臂的 −1.67% 回归 — 180 题上区分度不足（4 vs 1）；
> **需扩大该臂题数或定位这 4 个反转**

The second route — locate the four flips — is the cheap one, and it was the
preferred one: a located flip can be read against the mechanism, whereas a
bigger arm only buys more power on the same unknown. It could not be taken.

## 2. The defect

`AblationResult` carried three things about discordant pairs:

| Field                                                | What it answers                                  |
| ---------------------------------------------------- | ------------------------------------------------ |
| `discordant.baselineCorrectFeatureIncorrect: number` | how many                                         |
| `discordant.baselineIncorrectFeatureCorrect: number` | how many                                         |
| `featureCorrect: boolean[]`                          | the feature side, per question, in dataset order |

And two things it did not:

| Missing                                | Consequence                                      |
| -------------------------------------- | ------------------------------------------------ |
| The question ids behind the two counts | "which" is unanswerable                          |
| `baselineCorrect: boolean[]`           | the direction of any given failure is unknowable |

So the archive can say _four questions regressed, all inside IE_ and cannot say
which four. The count is a number a reader cannot check.

**This is the same defect class as `AUDIT-SILENT-DENOMINATOR.md`.** There, the
recall curve measured 428 questions while the main report measured 500, and said
so nowhere. Here, the report stores enough to _count_ a finding and not enough to
_verify_ it. Both are a measurement discarding the part of its own scope that
would let a reader reproduce the claim.

## 3. Why it mattered here specifically

`tools/audit-discordant-identity.py` reconstructs every constraint the archive
does support. For the A2 artifact:

```
IE has 9 feature-failures, of which 4 regressed
baseline per-question vector absent -> which 4 is not recoverable
(ambiguity size: C(9,4) assignments)
```

126 consistent assignments. Any single one would have been a fabrication dressed
as a finding, and the fabrication would have been _plausible_ — which is what
makes it worth writing down rather than quietly picking the most likely candidate.

## 4. What the archive still decided

The tool hard-codes no positions. It establishes, from counts alone, two things
that do not need them:

**4.1 The block structure is verified, not assumed.** The arm filters to
`{ABS, IE}`, and `Array.prototype.filter` preserves order, so the two capabilities
form contiguous blocks. The tool splits the feature vector at the boundary the
per-capability totals imply and checks that each block's `true` count equals that
capability's reported `featureCorrect`. Five of six archived artifacts verify.
The sixth (`reportout`, 2026-09-19) does not: its total matches but its blocks do
not, so it was written under a different ordering and its positions are
meaningless. It is reported as `all-true` rather than `ok`, and its counts are
still used because counts do not depend on ordering.

**4.2 The target population never moved.**

| run              | ABS n   | baseline ✓ | feature ✓ | b✓f✗  | b✗f✓  |
| ---------------- | ------- | ---------- | --------- | ----- | ----- |
| `okout`          | 9       | 9          | 9         | 0     | 0     |
| `okout2`         | 9       | 9          | 9         | 0     | 0     |
| `b1x`            | 22      | 21         | 21        | 0     | 0     |
| `b1cy`           | 22      | 21         | 21        | 0     | 0     |
| `reportout`      | 29      | 28         | 28        | 0     | 0     |
| `lm_report` (A2) | 30      | 29         | 29        | 0     | 0     |
| **total**        | **121** |            |           | **0** | **0** |

R4's P2 is a prediction about one question (`6456829e_abs`) and P3 is about six
controls — both statements about this group. Across 121 ABS questions and six
runs, including the two with a complete 7/7 cohort, decomposition moved **zero**
of them.

That refutes P2 and makes P3 vacuous. A 0-of-n claim is only as strong as its
`n`, and here the group did not move at all, so "the controls stayed put" carries
no information about collateral damage: there was no treatment effect to be
collateral _from_.

## 5. The fix

`AblationResult.discordantQuestions` carries both id lists:

```ts
discordantQuestions: {
  readonly baselineCorrectFeatureIncorrect: readonly string[];
  readonly baselineIncorrectFeatureCorrect: readonly string[];
};
```

Design choices, each with a reason:

- **Required, not optional.** Making it optional would let a construction site
  omit it silently, and the type check found three existing fixtures that would
  have done exactly that. A required field turns "forgot to record identity" into
  a compile error.
- **Ids, not indices.** An index is meaningful only relative to a dataset order
  that is not itself recorded — which is precisely how `reportout` became
  unverifiable. Ids survive reordering.
- **Empty array, not `undefined`.** An empty list is a measured absence; a missing
  field is an unmeasured one. Same distinction the fallback counters draw between
  `null` and `0`, and the renderer prints `(none)` rather than `0` for the same
  reason.
- **Collected in the existing pairing loop.** No extra pass, no extra I/O.

## 6. Verification

| Step                                          | Result                                      |
| --------------------------------------------- | ------------------------------------------- |
| Tests written first                           | 7 red (`discordantQuestions` undefined)     |
| After implementation                          | 19/19 green in `benchmark-ablation.test.ts` |
| Injection: remove id collection               | **6 red**                                   |
| Injection: collect indices instead of ids     | **5 red**                                   |
| Injection: render counts without identity     | **2 red**                                   |
| Injection: render count instead of `(none)`   | **3 red**                                   |
| Injection: tool accepts total-matching blocks | **1 red**                                   |
| Injection: tool always reports zero ABS flips | **1 red**                                   |
| All restores                                  | byte-exact (md5 verified)                   |

The render tests are non-vacuous: the `(none)` test passes under an
empty-array injection because empty arrays _should_ render `(none)`, and it fails
under the numeral injection it exists to catch. Both facts are checked, which is
why both injections were run.

`tools/audit-discordant-identity.py` is re-runnable so the next occurrence is
found by a command rather than by a reader:

```
python3 tools/audit-discordant-identity.py /tmp/okout /tmp/reportout ...
```

## 7. Not claimed

- **The archived artifacts are not repaired.** `discordantQuestions` is
  forward-only. The A2 flips remain unlocatable, and the tool says so in its
  output rather than omitting the line.
- **The IE regressions are not explained.** They are consistent and
  one-directional (4:1 in A2, and zero flips back in five other runs), which is
  itself evidence that decomposition does something to IE. What it does is not
  established here.
- **The block hypothesis is verified, not proven.** It is confirmed against
  per-capability counts in five artifacts. A single artifact could satisfy that
  check by coincidence; five in agreement, with one honest failure, is the
  evidence available and it is stated as such.
