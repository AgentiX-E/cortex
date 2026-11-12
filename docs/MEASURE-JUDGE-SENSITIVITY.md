# The headline number moves 3.2 points when the judge changes, and the movement is all in `IE`

**Runs:** audit `43164165343` re-grading the artifact of `43140878641`. Judge swap
`deepseek-chat` → `deepseek-v4-pro`, both at temperature 0, `scorer=full` (the instrument the
artifact itself used), `population=all`, `passes=2`, 467 recorded answers.

**Registered before this reading:** `J9` (§13.312.8) asks whether an `M1` arm difference survives a
common judge. This reading answers the prior question — *how far does the number itself move?* — and
it is a census of one artifact rather than a new experiment, so it has no prediction to violate.

## 0. One paragraph

Every accuracy this project has ever published, and every competitor comparison it has ever drawn,
rests on one judge. `§13.312.8` measured a **29-point** judge main effect, but only on 29
*preference* questions — the one population where no gold string exists and the model decides every
verdict. Whether the same strictness reaches the headline has never been measured, and 54.4% of this
artifact's verdicts are model-decided. It does reach it: re-reading the same 467 answers with
`deepseek-v4-pro` moves correct from **427 to 412**, a **−3.21-point** swing that is entirely
one-sided (13 lost, 0 gained, 2 ties) against a judge self-flip rate of **0.43%**. Ten of the thirteen
lost questions are `IE`, where the capability falls **93.3% → 86.7%**. So the instrument band on the
headline is **±3.2 points, not ±0.4**, and it is not spread evenly across capabilities.

## 1. The reading

| quantity                            |             value | note                                                              |
| ----------------------------------- | ----------------: | ----------------------------------------------------------------- |
| graded questions                    |           **467** | the artifact's recorded answers: no abstention row, 3 `MR` absent |
| artifact, `deepseek-chat` judge     | **427/467 = 91.4%** | the instrument that produced the published 91.25%                |
| re-grade, `deepseek-v4-pro` judge   | **412/467 = 88.2%** | same answers, same template, same `scorer=full`                   |
| difference                          |       **−15 questions / −3.21 points** |                                                   |
| direction                           |       **13 down / 0 up / 2 ties** | one-sided, so this is strictness rather than noise   |
| same-judge flips on identical input |        **2/467 = 0.43%** | the noise floor the difference has to clear, and it clears it by 7× |
| first-pass agreement with artifact  |           452/467 = 96.8% | the judge is stable on all but sixteen answers             |
| verdict channel split               | **judge 508/934 = 54.4%**, exact 356, numeric 70 |               |

The one-sidedness is the load-bearing part. A two-sided 15-question movement would be sampling; a
13–0 split with a 2-question self-flip rate is a **strictness difference between two judges**, and it
means the published number is an **upper** bound among the judges this project can call.

## 2. Where the movement is, and why that is the finding

| capability | graded | artifact | strict judge |     Δ | Δ points |
| ---------- | -----: | -------: | -----------: | ----: | -------: |
| `IE`       |    150 |      140 |          130 | **−10** | **−6.67** |
| `MR`       |    118 |      102 |          101 |    −1 |    −0.85 |
| `TR`       |    127 |      121 |          119 |    −2 |    −1.57 |
| `KU`       |     72 |       64 |           64 |     0 |     0.00 |
| `ABS`      |      — |        — |            — |     — |        — |

`IE` loses **ten of thirteen**. That is not a random allocation: `IE` answers are short free-text
facts ("Business Administration"), which is the shape where a stricter grader can demand an exact
form and a lenient one accepts a paraphrase. `KU` loses nothing, because a knowledge-update answer is
a value the judge either matches or does not. So the instrument band is **capability-shaped**, and a
single global ±3.2 hides a −6.7 on the second-largest population.

This also explains a number the campaign has read without explaining: `§13.232` and the reader-ladder
readings found strong readers scoring *below* weak ones on `IE`, and the note there was that a
stronger reader "declines to be terse". A grader that rewards terseness produces the same pattern
from the other side, and the two readings have never been separated. They still are not — what this
document establishes is that the separation is worth a dispatch, not that it has been done.

## 3. What this licenses, and what it does not

**It licenses three statements.**

1. **The 91.25% carries a −3.2-point instrument band**, measured on 467 answers with a 0.43% noise
   floor, and nobody comparing it with a vendor number has accounted for it.
2. **Cross-vendor comparison at the 3-point scale is not decidable on this instrument.** The two
   nearest published rows — Synap 95.6% and Mastra 94.87% — sit **4.35 and 3.62 points** above this
   arm, i.e. within roughly one judge swap. Their judges are `gpt-4o`; ours is `deepseek-chat`. A
   third judge has never been applied to our answers and a like-for-like reading would need it.
3. **`J9`'s design is now priced.** One artifact, 934 judge verdicts, 8 minutes of runner time, and
   the answer is a 15-question movement. The full `J9` (both `M1` arms under one pinned judge) is the
   same dispatch at twice the population.

**It does not license four things.**

- **It does not change any acceptance row.** `S1`–`S8` are read within one dispatch, one judge, both
  arms; the judge is held fixed there and a strictness difference cancels. A row is a statement about
  a comparison, and no comparison moved.
- **It is not a correction of the artifact.** The artifact is right about itself, as `§13.312.8`
  established the same way: 452 of 467 first-pass verdicts agree, and the two same-judge flips are
  the reproducibility this repository already priced at 5.0%.
- **It does not say `deepseek-v4-pro` is a better judge.** It says it is a stricter one on `IE`. Which
  one is closer to the benchmark's official `gpt-4o` is a separate reading, and `gpt-4o` is not a
  model this arm has ever called.
- **It does not explain the `IE` gap to the field.** Everything it establishes is about the
  instrument; a strictness difference is a property of the grader, and the answers are unchanged.

## 4. Why the population is 467 and not 500

The regrade reads the artifact's recorded answers, and the artifact records **467**: the 30 abstention
questions carry no answer record of their own (their gold *is* a decline, so there is nothing to
re-grade) and three `MR` questions are absent. Every number above is therefore about the four
capabilities that answer, and the abstention capability is untouched by this reading in both
directions — which is also why the artefact's 91.25% over 500 and 91.4% over 467 are the same
quantity read on two populations rather than two measurements of one.

## 5. Reproduction

```bash
# dispatch (the runner holds the judge key; the sandbox cannot reach the model endpoints)
gh workflow run judge-audit.yml -f run_id=43140878641 -f limit=500 \
  -f model=deepseek-v4-pro -f mode=regrade -f passes=2 -f population=all -f scorer=full
```

The reading is committed rather than left in the artifact: `cortex-docs/evidence/longmemeval/
judge-sensitivity.json` (the tool's own output), `judge-sensitivity.txt` (its text form),
`judge-sensitivity-verdicts.json` (467 per-question verdicts) and `judge-sensitivity.meta.json` (the
run ids and the judge pair). The artifact zip is not reachable from this workspace —
`OPS-UNFETCHABLE-ARTIFACT.md` records the redirect/credential defect — so a reading that exists only
as an artifact is a reading nobody can audit.
