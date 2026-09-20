# AUDIT — Persisted Artifacts Against the JSON Null Substitution

**Status:** audit complete, all findings explained; `tools/audit-persisted-nulls.py`
added as the durable instrument; 13 new tests in `report-arm-shapes.test.ts`.

**Closes:** the last declared gap from `FIX-REPORT-JSON-ROUNDTRIP.md` — "other
`benchmark-*.json` writers were not checked for the same in-memory-number /
persisted-null pattern." That gap is now **closed with zero live defects**, and
the closure is a script rather than a paragraph.

---

## 1. Why the last gap needed an instrument, not a pass

The two previous rounds found three defects by re-reading real artifacts. That is
how they were *detected*, but it is not a *method*: each was found only after it
had shipped, by a reader noticing something was missing. Repeating that once more
would answer this gap and leave the next one open in exactly the same way.

The gap asked a question about a class — *does any persisted artifact hold a
value that was a real number in memory and is `null` on disk?* — so the answer
had to be a check that runs against the class, not a reading of the four files
that happened to exist.

## 2. The discriminating problem

`null` is a legitimate value in these schemas, so "find the nulls" is not the
audit. `Answer = string | null`, and `decision.answer: null` is precisely how an
abstention is recorded — it is the datum, not a corrupted version of one. An
audit that flags every null produces a report nobody reads, which fails the same
way as an audit that flags none.

The tool therefore discriminates on **explanation**, not on presence:

| Case | Test | Verdict |
| --- | --- | --- |
| Nullable-by-design field | Is the null *consistent with the record's own state*? | explained or **finding** |
| Numeric field, null | Is a renderer known to handle this path? | explained or **finding** |
| Anything else | — | **finding** |

The first row is where the real discrimination lives, and it is worth stating
exactly. `decision.answer: null` is explained when the record also says
`abstained: true` with an abstention reason — the run declined, and a decline has
no answer. The **same field holding the same null is a finding** when the record
says `abstained: false` or `reason: "answered"`: that record claims to have
answered and has lost its answer. The field name does not decide it; the
co-occurrence does.

## 3. Method

All 24 archived `benchmark-*.json` artifacts across two runs (`/tmp/okout` and
`/tmp/reportout`) were parsed and every leaf inspected:

| Artifact group | Files | Nulls found | Verdict |
| --- | --- | --- | --- |
| `*-ablation-report.json` | 7 arms × 2 runs | `ablation.pValue` (7×2), `ablation.effectSize` (4×2) | JSON substitution, **handled by the renderer** |
| `benchmark-single-session-diagnostics.json` | 2 | `decision.answer` (10 + 31) | **nullable by design**, every one a recorded decline |
| `benchmark-diagnostics.json` | 2 | 0 | not affected |
| `benchmark-mr-diagnostics.json` | 2 | 1 | nullable by design |
| `benchmark-recall-curve.json` | 1 | 0 | not affected |
| `benchmark-ablation-skipped.json` | 1 | 0 | not affected |

**Explained: 100%. Unexplained: 0.**

### 3.1 The `answer: null` nulls are correct, and verified as such

The 41 `decision.answer` nulls are the case that looks like the defect and is
not. Verified three ways rather than assumed:

1. **By type.** `Answer = string | null` (`types.ts:36`). The null is a member of
   the type, not a value forced into it by serialisation.
2. **By source.** `natural-language-memory.ts` assigns `answer: null` at three
   explicit abstention sites (lines 1257, 1268, 1373), and `answer: 'unknown'` or
   `answer: parsed` otherwise. The two literal nulls are the decline path.
3. **By co-occurrence, on real data.** Across the artifact, all 41 non-null
   answers have `abstained: false` and all 41 null answers have `abstained: true`;
   there are **zero** records claiming to have answered while holding a null. The
   coupling is exact in both directions, which is what the schema predicts and
   the opposite of what a serialisation loss would produce.

A loss would be *inconsistent* — some records claiming an answer with none
attached. The data shows a perfect partition, which is the signature of a value.

### 3.2 The `pValue`/`effectSize` nulls are real substitutions, and already handled

These are the genuine article: `NaN` and `-Infinity` in memory, `null` on disk,
because JSON cannot represent either. They are **the three defects' shared
mechanism**, and they are now read correctly by `formatPValue` /
`formatEffectSize` (`report.ts`).

Confirmed by rendering, not by reading: **14/14 archived ablation reports render
without throwing** (0 failures). The audit tool labels these paths as
renderer-handled, which is why its exit code is 0 — but it labels them explicitly
rather than silently passing them, so the day a *new* `ablation.*` field appears
that the renderer does not handle, the label will be wrong and visible.

## 4. What was made durable

**4.1 `tools/audit-persisted-nulls.py`** — runs against any artifact directory,
exit code 0 when every null is explained and 1 when any is not. Being runnable in
CI is the point: "the artifacts are still readable" becomes a checked property
instead of a remembered one. It carries its own exclusion list, and every
exclusion states its reason, because an unexplained exclusion list is exactly how
a real defect gets audited away.

**4.2 `report-arm-shapes.test.ts`** (13 tests) — the renderer is exercised on the
inputs production actually gives it. Seven arm shapes are enumerated, the
two-optional-fields combination is tested separately (an early `return` after the
first section drops the second), and the suite asserts four properties that the
previous suites did not:

- every arm shape renders after a JSON round-trip;
- the round-trip changes **exactly** the non-representable fields and nothing
  else — proving the transformation is specific, which is what makes a targeted
  fix correct rather than lucky;
- a null p-value renders as `n/a (deterministic)` and never as `0.000e+0` (a
  p-value of 0 reads as overwhelming evidence and inverts a no-evidence result);
- a null effect size renders as `n/a` and never as `0.000` (which would read as
  "no effect" when the truth is an unbounded one).

The last two are the reason this class is dangerous rather than merely fragile: a
crash is self-announcing, and a wrong number in a results table is not.

## 5. Acceptance

| Criterion | Evidence |
| --- | --- |
| Every archived artifact audited, not sampled | 24 files across 2 runs |
| Nulls discriminated, not blanket-flagged | 41 explained by co-occurrence; 23 labelled as handled substitutions |
| Every archived report renders | 14/14, 0 throws, measured not asserted |
| The catch-all case still fails | Non-`ablation.*` numeric null → finding, exit 1 |
| The instrument is re-runnable | `python3 tools/audit-persisted-nulls.py <dir>` |
| Renderer covers the arm space | 13 tests, 7 enumerated arm shapes + both-fields + idempotence |
| The fix is specific, not lucky | Test: round-trip changes only the non-representable fields |
| No wrong-number fallbacks | Tests: `n/a` not `0.000`, for both p-value and effect size |
| No regression | All four packages ≥95% on all four dimensions |

## 6. Declared gaps: 3 → 1 → 0

| Round | Open gaps |
| --- | --- |
| After the round-trip fix | 3 |
| After resolving the log-host and audit questions | 1 |
| After the side-channel audit | 1 (other JSON writers) |
| **After this audit** | **0** |

The remaining item from the side-channel round — "other `benchmark-*.json`
writers unchecked" — is the one this document closes.

**What is NOT claimed:** that the class cannot recur. The tool checks the
artifacts that exist and the renderer paths that are known; a *new* writer that
persists a new numeric field would be caught only if the field appeared under a
path the tool does not treat as handled. That is why §3.2 labels the handled
paths explicitly instead of filtering them out — a visible label can be wrong in
a way a silent filter cannot.
