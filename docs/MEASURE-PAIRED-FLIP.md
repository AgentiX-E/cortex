# The gap was never a constant: reading the two arms as a pairing

`tools/paired-flip.mjs`, `packages/cortex-eval/src/paired-flip.ts`, reading
`tools/paired-flip-reading.json`, taken on `41159983913`. No model, no key, no dispatch.

## 0. Running it

```
gh run download <run_id> --name longmemeval-s-report --dir run
node tools/paired-flip.mjs --artifact run/benchmark-cortex-memory-ablation-report.json \
  --census --list --out readings/paired-flip.json
```

No model, no key, no dispatch, and no workflow: every other instrument here has one because it needs
the model, and this one needs only the artifact — which is the 39 MB object the job's own log cannot
hand back. A workflow for it would add a step that fails on the download rather than on the reading.

## 1. The number this replaces

MR has been quoted as **87.25 against 103.75, sixteen questions behind**, for several iterations. Both
are averages over four repetitions, and every plan row calls the comparison "paired" while quoting the
difference of two means — same run, not same question.

The artifact has stored `ablation.featureCorrectByRun` and `ablation.baselineCorrectByRun` the whole
time: four correctness masks per arm, one character per dataset question. The field was added with the
stated purpose of telling *"one question flapping four times"* apart from *"four questions flapping
once each"*. **Nothing in the repository had ever read them.**

## 2. What the pairing says

| capability | n   | baseline per repetition | feature per repetition | gap per repetition |
| ---------- | --: | ----------------------: | ---------------------: | -----------------: |
| MR         | 121 |        105, 104, 104, 102 |         84, 86, 87, 92 |      **21, 18, 17, 10** |
| TR         | 127 |            84, 83, 83, 83 |       105, 100, 104, 101 |     −21, −17, −21, −18 |
| IE         | 150 |              1, 1, 1, 1 |        141, 143, 144, 144 |   −140, −142, −143, −143 |
| KU         |  72 |              0, 0, 0, 0 |          60, 59, 61, 61 |       −60, −59, −61, −61 |
| ABS        |  30 |            30, 30, 30, 30 |          29, 29, 29, 29 |       1, 1, 1, 1 |

**The MR gap is 21, 18, 17 and 10 in four repetitions of a byte-identical prompt.** The mean of 16.5 is
an average over a range of 11, and the *other* arm is not stable either: 105, 104, 104, 102.

| capability | durable-miss | durable-win | agreed-wrong | contested | flapping (b/f) |
| ---------- | -----------: | ----------: | -----------: | --------: | -------------: |
| MR         |       **17** |       **4** |            8 |        20 |          3 / 18 |
| TR         |            3 |          20 |           13 |        17 |          1 / 17 |
| IE         |            0 |         136 |            4 |         9 |           0 / 9 |
| KU         |            0 |          58 |           10 |         4 |           0 / 4 |
| ABS        |        **1** |           0 |            0 |         0 |           0 / 0 |

## 3. The decomposition, which is the finding

16.50 mean gap = **17 durable misses − 4 durable wins = 13**, plus 3.5 from flapping asymmetry.

The arms disagree on **29 and 8 of 121** MR questions in the first repetition. A 21-question gap
built on 37 disagreements is a residue, not a deficit: 72 questions are agreed-right, 8 are agreed-wrong,
and 20 are decided differently by the same code from one repetition to the next.

**The ceiling follows arithmetically.** The 84 already contains the four durable wins. Closing every
durable miss and losing nothing is 84 + 17 = **101/121 = 83.5%**; closing them while losing the four wins —
which is what "become more like the reference arm" means, since those four are questions *it* loses in
every repetition — is 84 + 13 = **97/121 = 80.2%**.

Both are below the **96/121** that `PREREG-MR-SESSION-CHANNEL` §5 registered. That target was above the
ceiling of the strategy that named it, and reaching it requires winning questions the reference arm also
loses — a different class of work that is on no plan row.

## 4. The seventeen, with a class each

| id             | class       | gold                      | ours                            |
| -------------- | ----------- | ------------------------- | ------------------------------- |
| `0a995998`     | off-by-one  | `3`                       | `2`                             |
| `gpt4_a56e767c`| off-by-one  | `four movie festivals`    | `3`                             |
| `88432d0a`     | off-by-one  | `4`                       | `3`                             |
| `gpt4_2f91af09`| off-by-one  | `23`                      | `22`                            |
| `21d02d0d`     | off-by-one  | `2`                       | `1`                             |
| `2e6d26dc`     | off-by-one  | `5`                       | `6`                             |
| `60bf93ed`     | decline     | `5 days … 6 days also acceptable` | —                       |
| `d905b33f`     | decline     | `20%`                     | —                               |
| `a4996e51`     | decline     | `50`                      | —                               |
| `d6062bb9`     | decline     | `1,998`                   | —                               |
| `c18a7dc8`     | decline     | `7`                       | —                               |
| `edced276`     | aggregation | `15 days`                 | `5` (Hawaii duration "not stated") |
| `2b8f3739`     | aggregation | `$495`                    | `375` (third item "not stated") |
| `92a0aa75`     | aggregation | `1 year and 5 months`     | `6 years and 1 month`           |
| `a9f6b44c`     | aggregation | `2`                       | `4`                             |
| `7405e8b1`     | other       | `Yes.`                    | `20`                            |
| `5025383b`     | other       | `photography and cooking` | `2`                             |

Composition: **off-by-one 6, decline 5, aggregation 4, other 2.**

Two things this table says that the counts do not:

- **Five of the six off-by-one misses are under-counts and one is an over-count** (`2e6d26dc`), and the
  aggregation class carries a second over-count (`a9f6b44c`, 2 → 4). Any treatment that pushes the arm
  toward inclusion moves five questions up and may move two down, so **the net of a purely directional
  fix is three at best**. That is stated before the experiment rather than after it.
- **Two answers say the evidence does not contain the fact** (`edced276`, `2b8f3739`), and in both the
  reference arm produces the gold. An answer that names its own missing operand is the most informative
  failure in the set, because it cannot be a miscount.

## 5. The one deterministic defect outside MR

ABS is 29/30 in every repetition while the reference arm is 30/30 in every repetition, and the one
question is `6456829e_abs`: gold `None` (a false premise), answer `5 tomato plants` four times out of four.
The question asks for **tomatoes and chili peppers**; the reply answers the tomato half and drops the
other operand.

The `ask: operands` contract is built for exactly this, and it reaches the **`multi-session` route
alone** — its reach map says one route although its gate admits three, and `classifyQuestionShape` runs
only under that ask. So the one mechanism in this repository that asks a reader whether every operand
of a question is present cannot see the route whose whole job is to notice that a question cannot be
answered from what is there.

## 6. What this withdraws

> **"The next step is `PREREG-MR-SESSION-CHANNEL` (session-granularity relevance, MR ≥ 96/121)."**

It was dispatched. `PREREG-MR-SESSION-CHANNEL.md` §6 records run `40498191604`, whose gate line confirms
`relevanceSignal=retrieval-session`, and MR read **83/121** against the control's 84. P2 was refuted by 13
questions, and §6.2 closed the retrieval-unit axis on two independent lines.

That was reported to the user as the next step and written into `04` §9.135 and `03` §14.2. The cost is
not the arithmetic — the arithmetic was right about the wrong thing — it is that the plan and the
registration file disagreed and nothing cross-checked them. A registration that has a `§6 Result` is no
longer a registration.

## 7. What it does not say

1. **`durable` is a property of the code only when the repetitions share a prompt.** Here `promptVariants`
   is 1 for 500 of 500, so they do. On an artifact where it is 4, `durable` would mean "durable across
   four *different* prompts" and would understate what a fix can reach.
2. **`agreed-wrong` is a ceiling of this harness, not of the capability.** A question both arms miss may be
   one a different prompt, window or reader wins — 8 such questions on MR.
3. **The census classes are read from strings and inherit `mr-failure-census.mjs`'s blindness**: a wrong
   answer that keeps the gold's number is invisible, and a gold that spells its number is read from the
   first number in its sentence.
4. **`feature.metrics.correct` is repetition 0.** 419 of 419 / 417 / 425 / 427. The tool prints that
   sentence above every number, because the artifact cannot: no field records which repetition produced
   the headline, and `runs: 4` sits in the same object.
