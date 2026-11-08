# The room is load-bearing, and the instrument that said it was not

**Run:** `42373407439` (24,000-character room, 500 questions × 2 repetitions) against `42355323615`
(48,000-character room, 500 questions × 4 repetitions).

**Registered before the meter ran:** `PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.301. Five
predictions, written in advance precisely so that this document could not be a description.

> **Correction (retraction 12, `docs/MEASURE-COST-LEVER.md` §5).** The pair below carries **two**
> variables, not one. `42373407439` ran `ask=verbatim`; `42355323615` runs `ask=verbatim-acts`, and
> §13.294 prices that alone at `MR` **+5.75 questions** and +1.00 point overall. The clean pair is
> `42310779222` (48,000, `ask=verbatim`, `MR` **95.75**) against `42373407439` (24,000, `ask=verbatim`,
> `MR` **93**), which reads **−2.75 questions, −2.65 points** — not −6.61 on `MR` and not −3.20
> overall. Every `MR`-attributed sentence in this document inherits that error, and the title's
> "load-bearing" survives only at the smaller size. The room's price is real; it was overstated by
> roughly the amount `ask` is worth.

## 1. The five registrations, read against the artifact

| id     | prediction                                                                                                 | reading                                                                                    | verdict                             |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| **C2** | median evidence tokens per question falls to **at most 0.70x**                                             | `46,926` → `22,830` characters = **0.487x**                                                | **pass**                            |
| **C1** | prompt tokens per question fall to **at most 6,000**                                                       | `22,830 / 4.06` = **5,623** tokens at the measured 4.06 chars/token                        | **pass**                            |
| **A**  | overall accuracy is **not more than 2.0 points below** the control (>= 89.4 on the 91.40 first repetition) | **88.20** — `441/500` twice, identical in both repetitions                                 | **fail**, by 1.20 points            |
| **B**  | the fall is **concentrated in ABS, IE and KU**                                                             | the fall is **entirely in MR and TR**: `-6.61` and `-4.72`, against `0.00 / -0.67 / -1.39` | **fail**, in the opposite direction |
| **C**  | the abstention route does not gain                                                                         | ABS reads `30/30` at both rooms                                                            | **pass**                            |

`C1` and `C2` — the two rows that had an instrument and no numerator — now have numerators, and both
clear their thresholds. The cost was **3.20 points**, which `A` refuses, and the shape of the loss,
which `B` refuses, is the more interesting half.

## 2. What `B`'s failure means, in the registration's own words

§13.301.4 wrote the falsifier before the reading existed:

> a fall in MR or TR contradicts 13.301.3, which says their gold fits at 24,000 by arithmetic, so a
> loss there is a defect in the arm and not a cost of the room

The prediction was arithmetic: `tools/gold-room.py --max-chars 24000` priced every question's gold
against the smaller room and reported **zero** questions losing full gold coverage in MR and TR —
`MR 0, TR 0`, against `ABS 9, IE 2, KU 38`. So the registered exposure was 49 questions in three
capabilities, and the two capabilities that hold the gap were supposed to be free.

They were not free. They were the entire cost.

| capability |   n |      48,000 room |      24,000 room |     delta | `gold-room.py` predicted |
| ---------- | --: | ---------------: | ---------------: | --------: | ------------------------ |
| ABS        |  30 |  30/30 = 100.00% |  30/30 = 100.00% |  **0.00** | 9 questions exposed      |
| IE         | 150 | 140/150 = 93.33% | 139/150 = 92.67% | **-0.67** | 2 questions exposed      |
| KU         |  72 |   64/72 = 88.89% |   63/72 = 87.50% | **-1.39** | 38 questions exposed     |
| MR         | 121 | 101/121 = 83.47% |  93/121 = 76.86% | **-6.61** | 0 questions exposed      |
| TR         | 127 | 122/127 = 96.06% | 116/127 = 91.34% | **-4.72** | 0 questions exposed      |

The three capabilities the instrument named lost **2.1 points combined**. The two it cleared lost
**11.3**.

## 3. The defect is in the risk model, and the artifact says what it should have been

`gold-room.py` asks one question: _do the gold turns fit?_ That is the right question for a
single-turn fact, and it is the wrong question for an aggregation.

The delivered-turn counts in the two artifacts make the difference visible without a provider call:

| capability | median delivered turns, 48,000 | median delivered turns, 24,000 |     change | accuracy change |
| ---------- | -----------------------------: | -----------------------------: | ---------: | --------------: |
| ABS        |                             76 |                             34 | **-54.3%** |            0.00 |
| IE         |                             64 |                             32 | **-49.6%** |           -0.67 |
| KU         |                             67 |                             28 | **-57.5%** |           -1.39 |
| MR         |                            199 |                            102 | **-48.7%** |       **-6.61** |
| TR         |                            205 |                            109 | **-46.8%** |       **-4.72** |

Every capability lost about half its turns. Only two of them lost accuracy. The turn loss is
uniform and the accuracy loss is not, which rules out "less evidence is worse" as the mechanism and
leaves one that fits:

- **IE, KU and ABS are single-turn questions.** Their gold is one fact in one turn, and half the
  packet still contains that turn. Losing 33 of 64 turns costs `-0.67` because the turns that leave
  are the ones the answer never needed. This is the same result MemStrata measured from the other
  side — 4.7x the evidence is worth `+0.2` points — and it is why the short-window arm reads better
  than its own volume cut would suggest.
- **MR and TR are aggregations.** `I attended four movie festivals.` is not in any turn; it is a
  count over turns, and four separate festival turns must all be present for a reader to count four.
  Halving the packet removes about 97 of 199 turns, and a count over a sample is not the count. The
  failure signature is in the artifact: `gpt4_a56e767c` answers **3** against a gold of four
  festivals, `gpt4_2f8be40d` answers **6** against three weddings, `gpt4_7fce9456` answers **5**
  against four properties. Every one of them is off by the number of turns the cut removed, which is
  what a truncated count looks like.

So `gold-room.py`'s `room` column is not wrong arithmetic; it is the right arithmetic on the wrong
model. **"The gold fits" is a sufficient condition for a single-turn question and an irrelevant one
for an aggregation**, because an aggregation's requirement is not its gold turn but the complete set
of turns the gold counts. A tool that prices gold coverage will report an aggregation question as
safe at every room where its gold turn survives — which is every room down to about 1,500 characters
— and the reading above is what that costs.

This is the fourth time in this campaign that an instrument reported a safe prediction and the
measurement disagreed, and it is the first time the instrument's _model_ rather than its _reading_
was the defect. `tools/evidence-budget.py` was published one round earlier with a median and a
conversion factor and no risk model at all; this run supplies the one it was missing, and
`gold-room.py`'s `room` column must now be read as a **lower bound on exposure** rather than as an
estimate of it.

## 4. What the two passing rows actually bought

This is the first time in this campaign that a cost row is met by measurement rather than by
argument, and it is worth stating exactly how much was bought and how much was paid.

|                                                 |      48,000 room |      24,000 room |     change |
| ----------------------------------------------- | ---------------: | ---------------: | ---------: |
| prompt characters per question, median          |           46,926 |           22,830 | **-51.3%** |
| prompt tokens per question, at 4.06 chars/token |           11,558 |            5,623 | **-51.3%** |
| accuracy, first repetition                      |           91.40% |           88.20% |  **-3.20** |
| MR                                              |           83.47% |           76.86% |  **-6.61** |
| TR                                              |           96.06% |           91.34% |  **-4.72** |
| IE + KU + ABS                                   | 92.86% (234/252) | 92.06% (232/252) |  **-0.79** |

The last row is the finding that matters for the product, not for the benchmark: **half the evidence
costs 0.79 points on the 252 questions whose answers live in one turn.** The cut is close to free
there and it is expensive on the 248 that aggregate.

## 5. The repair this licenses, and it is nearly free

`memoryArmConfig` already resolves a **per-route** room (`maxPromptCharsByRoute`, §13.299), and the
capabilities map onto routes without ambiguity: `MR -> multi-session`, `TR -> temporal`,
`ABS -> abstention`, `KU -> knowledge-update`, `IE -> flat` and `assistant`.

So the run above is the two endpoints of a curve whose middle is free to take:

| arm                    | room per route                                                                                 |                              predicted accuracy | predicted tokens/question |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------: | ------------------------: |
| control `42355323615`  | 48,000 everywhere                                                                              |                               91.40% (measured) |         11,558 (measured) |
| this run `42373407439` | 24,000 everywhere                                                                              |                               88.20% (measured) |          5,623 (measured) |
| **next**               | 24,000 on `abstention, assistant, flat, knowledge-update`; 48,000 on `multi-session, temporal` | **91.00%** (arithmetic over the measured cells) |                 **8,567** |

That is `-0.40` points for `-26%` tokens, against `-3.20` for `-51%` — and unlike the prediction in
§13.301, every cell of it is a measured number rather than a model. The prediction is registered in
§13.302 with its own falsifier, because a number computed from two measured arms is still a
prediction about a third.

## 6. What this does not license

`C1` is met at a room where accuracy falls, and **a met cost row is not a licence to ship it**. The
product's registered configuration stays at 48,000 characters until the per-route arm reads, because
`A` was the registration that decided whether the cut was reachable at all and it said no. `C1` and
`C2` now have numerators; they do not yet have an arm that satisfies both them and `A`.

The honest one-line state: **cost is solved and accuracy is not**, and the 252/248 split says where
the boundary is.
