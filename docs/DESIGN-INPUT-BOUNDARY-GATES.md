# Two input-boundary gates: a mistyped limit and an impossible date

**The defects this records.** The last six iterations closed the "recording" half of the pipeline — a value
another instrument reports differently or loses. This iteration moves one stage upstream, to the **input** of the
benchmark itself, and finds the same shape twice: a value crossing a boundary with a weaker check than the
consumer assumes.

1. `LIMIT=abc` became `NaN`, which slipped past every range guard and scored a benchmark over **zero questions**.
2. `isValidDate('2023/02/30')` returned `true`, so a phantom February date scored a **negative "days ago"** on a
   temporal-reasoning question.

Neither raised an error. Both produced a well-formed number in a leaderboard artifact.

## 1. The `NaN` limit: an empty population that still publishes a score

`bench/run.ts` and `bench/run-ablation.ts` both read the question count with `Number(process.env.LIMIT ?? 0)`.
`Number('abc')` is `NaN`. In `sampleInstances`:

- `limit <= 0` is false for `NaN`;
- `limit >= instances.length` is false for `NaN`;
- `while (result.length < limit)` is false from the first test.

The sampler returns `[]`. Every downstream accuracy is computed over an empty denominator and the run writes a
report. This is worse than a crash: a crash cannot be published, while a zero-question score is indistinguishable
in the summary from a real result.

The repository already reads one env-var count strictly — `reader-transport.ts`'s `readMilliseconds` refuses
anything that is not a run of digits, with the variable named in the message. The fix generalizes that discipline:

- `readWholeNumberLimit(raw, name, fallback)` in `dataset/sampling.ts` treats blank/unset as the fallback, accepts
  only `^\d+$`, and throws with the variable name otherwise. Both bench entry points now use it for `LIMIT` and
  `DIAGNOSTICS_LIMIT`.
- `sampleInstances` itself refuses a non-finite limit, so no future caller can reintroduce an empty sample by
  passing `NaN` or `Infinity` directly. This is the load-bearing guard: the strict parser covers the two known
  callers, the finite check covers every caller.

Other `Number(process.env...)` sites (`RUNS`, `ABLATION_RUNS`, `PROGRESS_EVERY`, thresholds) are deliberately left
alone this iteration: they gate repetition counts and intervals, a NaN there skips a loop rather than publishing
an empty-population score, and none had a reproduced failure. They are recorded as a follow-up, not folded into a
verified fix without evidence (note 13's discipline against speculative edits).

`LIMIT=0` still means "the full dataset", and that is preserved and tested.

## 2. The impossible date: two gates that disagreed

Two date parsers exist. `turn-clock.ts` validates a turn stamp with `year >= 1`, `month` in 1..12, and
`day <= daysInMonth(year, month)`. `temporal-engine.ts`'s `isValidDate` checked only the shape regex
`^\d{4}/\d{2}/\d{2}$`. An event date extracted by the LLM flows through `resolveTemporalDate` into `isValidDate`,
so `2023/02/30` — a string `Date.UTC` silently rolls into 2 March — passed the weaker gate and reached
`elapsedValue`. Against a 1 March question date it scored **-1 days ago**.

The fix makes `isValidDate` mirror `turn-clock.ts`: parse the three components and require a real calendar date,
using the same `daysInMonth` helper already in the file. `2023/02/29` is now rejected, `2024/02/29` (a leap year)
accepted, and months/days of `00` or `13+` refused. The valid path is guarded by a test that still scores a real
28 February event as one day.

## 3. Acceptance

| Check | Result |
|---|---|
| `readWholeNumberLimit` | unset/blank -> fallback; `0`, `60`, ` 500 ` accepted; `abc`, `-1`, `1.5`, `1e3`, `NaN`, `Infinity` thrown with the name |
| `sampleInstances` | `NaN` and `Infinity` throw; `0`, covers-all, and round-robin behavior unchanged |
| `isValidDate` | phantom and out-of-range dates rejected; leap day accepted |
| `computeTemporalAnswer` | phantom event date -> no answer, not `-1`; real 28 Feb event -> `1` |
| Test files | `sampling.test.ts` 13 passed (was 9), `temporal-engine.test.ts` 142 passed (was 140) |
| Export census | `readWholeNumberLimit` is a caller-bearing export, not an orphan; baseline regenerated with `rebuild-export-census-baseline.py` (a hand edit is rejected by the byte-for-byte test): totals `exports 1333->1334`, `withCaller 838->839`, orphan set unchanged at 495; `export-census-gate.test.ts` 23 passed, `test_rebuild_census_baseline.py` 12 passed |
| Red -> green | every new case failed against the old code, with the exact `-1` and empty-sample behavior reproduced |

## 4. Why this belongs in the instrument, not the result

Both defects are in the code that *feeds* the scorer, not in a score. A reviewer reading only the leaderboard could
not see either: an empty sample and a phantom date both render as ordinary numbers. This is the same property as
the six prior fixes (cost frames, cache keys, manifest fields, billing retries, summary counts) — the instrument
must be right before the number it prints can be trusted. The three un-adopted mechanism leads (per-question
routing, extractive memory, multi-step ReAct) and Cortex's 93.40% position are unchanged.
