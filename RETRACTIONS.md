# Retractions

Every claim in this repository that was published and later found wrong, with what replaced it and
where the correction is recorded. The rule is borrowed from a competitor's practice and adopted
because it is the cheapest honesty there is: a project that only publishes its current numbers looks
like a project that never changed its mind, and a reader cannot tell which of today's numbers will
survive.

Two conventions:

- **A retraction is not a mistake to be tidied away.** The row stays after the correction, because the
  next person to reach the same conclusion needs to know it was already tested.
- **A number that was retracted is never reused.** If a corrected figure happens to equal an older one,
  the row says which measurement it came from; two equal numbers from different measurements are how a
  drifted claim hides.

| # | claim as published | now | why it changed | recorded in |
| --- | --- | --- | --- | --- |
| 1 | The `MR` gap to the reference pipeline is **10.7–12.4 points** | **8 questions on one draw and 5 on the other** (−6.61 / −4.13 points) | The larger figure counted every question the reference won, including ones both arms lost; the gap is a paired difference | pre-registration §13.328, `cortex-docs` 03 §14.68 |
| 2 | The reference pipeline **leads `MR` by 5 to 8 questions** | **Not readable as a net delta**, and `p ≈ 0.36` as a paired one | The endpoint's own movement on `MR` is 8 questions observed and 15 at 95%; a 5-question difference is inside it, and 5 paired against a 12:7 discordant split is nothing | pre-registration §13.330.3 |
| 3 | Repairing every count-shaped `MR` gold is worth **+17.4 points on `MR`, +4.2 on the arm** | **+7.4 and +1.8**: 9 questions, not 21 | The population is 30 questions, of which 21 are already correct. A ceiling quoted from the population size instead of the failure count | pre-registration §13.333 |
| 4 | `requiredEffectSize` prints **17** for every capability | **1 / 6 / 3 / 8 / 3** observed, **5 / 13 / 8 / 15 / 9** at 95% | The whole-sample movement was substituted into each capability's bar. Safe against false positives, blind to true effects | pre-registration §13.330, `cortex-docs` 02 §22.59 |
| 5 | The registered arm runs `ask: verbatim` with `maxPromptChars: 48000` | **`ask: verbatim-acts`, `maxPromptCharsByRoute.multi-session: 48460`** | Two hand-written documents drifted from the run together and confirmed each other. A third column — the artifact — now decides | pre-registration §13.327 |
| 6 | Coverage is measured per package: `cortex-ai` **98.38 / 97.55 / 96.55 / 98.48**, passing | per **file**: one file was **86.27 / 84.21 / 84.62 / 85.42** | A package average hides a file, and a missing file was counted as neither covered nor uncovered | pre-registration §13.325, `cortex-docs` 03 §14.66 |
| 7 | Supermemory scores **97% on LongMemEval-S** | **Not comparable** — that figure is Recall@20, not answer accuracy | A retrieval metric printed in a table of answer accuracies. The row is kept and labelled | pre-registration §13.332.1 |
| 8 | The README's quick start is a working example | it never compiled: **4 type errors** (an object literal where `MemoryValue` was required, an undeclared `embedding`, a `VectorHit[]` passed where `MemoryValue[]` was required) | The front page was never executed. It is now compiled by `tools/manual-examples.mjs` on every build | this round, `cortex-docs` 04 (round 41) |

## What this list is for

Three uses, in order of importance.

**A reader can discount today's numbers correctly.** Item 2 is the shape of most of them: a difference
that is real in the arithmetic and unreadable against the endpoint's own noise. A reader who knows the
bar (17 questions observed, 27 at 95%) will not be misled by the next five-question claim either.

**The next investigation starts here.** Items 1–3 are one axis — `MR` — approached three times with
three different accounting errors. The axis is still worth working; the accounting is what changed.

**It is a test of the process, not of the people.** Every row above was found by a gate, a re-read of
an artifact, or a cross-check between two documents. None was found by re-reading prose. That is the
argument for `pnpm check` being as large as it is.
