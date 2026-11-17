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
| **C1** | prompt tokens per question fall to **at most 6,000** | `22,830 / 4.06` = 5,623 — a **median of evidence characters**, against a threshold on **mean billed tokens**; the ledger reads **6,077** | **fail**, by 1.3%; `MEASURE-COST-FLOOR.md` §1 |
| **A**  | overall accuracy is **not more than 2.0 points below** the control (>= 89.4 on the 91.40 first repetition) | **88.20** — `441/500` twice, identical in both repetitions                                 | **fail**, by 1.20 points            |
| **B**  | the fall is **concentrated in ABS, IE and KU**                                                             | the fall is **entirely in MR and TR**: `-6.61` and `-4.72`, against `0.00 / -0.67 / -1.39` | **fail**, in the opposite direction |
| **C**  | the abstention route does not gain                                                                         | ABS reads `30/30` at both rooms                                                            | **pass**                            |

`C2` — the row that had an instrument and no numerator — now has one and clears its threshold. **`C1` does
not, and the cell above is wrong.** It divides the *median* delivered characters by 4.06 and compares the result
to a threshold written on *mean billed tokens*; the ledger on the same artifact reads **6,077**
(`feature promptTokens 6,077,236` over 500 questions and two runs), which is 1.3% over the ceiling. Three
quantities were conflated and `MEASURE-COST-FLOOR.md` §1 separates them. The cost of the room was **3.20
points**, which `A` refuses, and the shape of the loss, which `B` refuses, is the more interesting half —
neither of which depends on the row that was misread.

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

## 7. The per-route arm read: two rooms were cut, one paid

§5 predicted the next arm at 91.00% for 8,567 tokens, and §13.302 registered it. This section is that
arm's reading, taken at a smaller room than the registration: **every** route at 24,000 (`S15`, run
`43967433821`, 500 × 4, the same reader, judge, prompt and `self-index` as the registered arm).

| route | n | 48,460 / 48,000 room | 24,000 room | Δ questions | discordant | exact McNemar p | delivered characters per question |
| --- | --: | --: | --: | --: | --: | --: | --: |
| `multi-session` | 121 | 100 | 91 | **−9** | 10 / 1 | **0.012** | 48,318 → 23,859 |
| `temporal` | 127 | 120 | 118 | −2 | 3 / 1 | 0.63 | 47,852 → 23,874 |
| `flat` | 94 | 84 | 83 | −1 | 1 / 0 | 1.0 | 22,611 → 22,613 |
| `knowledge-update` | 72 | 67 | 66 | −1 | 1 / 0 | 1.0 | 22,680 → 22,667 |
| `assistant` | 56 | 54 | 54 | 0 | 0 / 0 | 1.0 | 22,639 → 22,639 |
| `abstention` | 30 | 30 | 30 | 0 | 0 / 0 | 1.0 | 23,053 → 23,053 |
| **all** | 500 | 455 | 442 | **−13** | 15 / 2 | **0.0024** | 35,283 → 23,272 |

Overall accuracy 89.40% against 91.40%, i.e. −2.00 points, and the bill 5,861 tokens per question
against 9,074.

**The total is not the finding.** Nine of the thirteen questions come from one route, and the other
four come from three routes whose rooms never moved (the `flat` and `knowledge-update` cells are the
two dispatches disagreeing about one question each, at 22,613 against 22,611 delivered characters —
i.e. an untouched route, which is what a noise measurement looks like). Four routes were left alone
and moved by −2 across 252 questions; two routes were halved, and one of them moved by −9.

Two things follow, and the second is the one that changes the plan.

1. **The mechanism from §3 is confirmed at a second arm.** A count over turns needs the turns.
   `multi-session` is where the counts live: the artifacts answer 3 against a gold of four, 6 against
   three, 5 against four — the same truncation signature §3 recorded, at a different arm, with the
   same sign and a p under 0.05. A temporal question needs its anchor and its neighbours; it lost 2.

2. **The room is a budget per route, not a wall.** Cutting `temporal` to 24,000 is inside noise
   (p = 0.63) while cutting `multi-session` is not (p = 0.012), so the frontier is not "how much room"
   but "which route the room goes to". The middle cell this licenses — `multi-session` at 48,460, the
   other five at 24,000 — is registered as `S16` with two criteria at once (accuracy within five
   questions of the registered arm, and a bill at or below 85% of it) and a prediction of 453–455 at
   about 7,500 tokens per question. It was a prediction when this paragraph was written; §8 is its
   reading, and it met both criteria.

### 7.1 One methodological note, because the same artifact reads two ways

The paired delta depends on which verdict per question is paired. Majority over four repetitions gives
−13 questions (p = 0.0024); the first repetition alone gives −8 (p = 0.115). Both are computed from
this artifact and both are honest; they differ because a question answered in two of four passes is a
loss under the majority rule and a coin flip under a single-pass rule.

The registered producer pairs majority verdicts, for the reason its own docstring gives — a single
pairing of first repetitions reports repetition noise as a treatment effect — and this is the first
time the two conventions disagree by more than a question or two in the *conservative* direction. It
is recorded rather than resolved: the row's conclusion does not depend on it (the loss is in
`multi-session` under both conventions, at p = 0.039 and p = 0.012), but a reader comparing this
document against `room-24k.json` will find −13 there and −8 here if this paragraph does not exist.

## 8. The middle of the curve, read: 91.25% at 7,448 tokens per question

`S16`, run `44017278305`, 500 questions × 4 repetitions, `multi-session` at 48,460 and the other five
routes at 24,000 — the cell §7 licensed and §5's arithmetic predicted.

| repetition | correct | accuracy |
| --- | --: | --: |
| 1 | 456 | 91.20% |
| 2 | 454 | 90.80% |
| 3 | 458 | 91.60% |
| 4 | 457 | 91.40% |
| **mean** | **456.25** | **91.25%** |

Paired against the registered arm it replaces (`S9`, run `43778036604`) on majority verdicts: **448
both, 6 only `S16`, 7 only `S9`, 39 neither** — **−1 question**, −0.20 points, exact McNemar
**p = 1.0**. The bill is **7,448** prompt tokens per question (14,895,566 over 2,000 question-runs,
2,078 calls, 78 retries) against **9,074**, i.e. **−19.1%**; per correct answer it is **8,162**
against 10,105, **−19.2%**.

Both pre-registered criteria are met, and neither was moved to meet them: the delta threshold was
−5 questions and the bill threshold was 7,821 (85% of 9,201) — the reading came in at −1 and 7,448.

| route | n | accuracy (`S9` → `S16`) | Δ questions | delivered characters per question |
| --- | --: | --: | --: | --: |
| `multi-session` | 121 | 82.64% → **83.47%** | **+1** | 48,318 → 48,322 |
| `temporal` | 127 | 94.49% → 93.70% | −1 | **47,852 → 23,877** |
| `flat` | 94 | 89.36% → 88.30% | −1 | 22,611 → 22,613 |
| `knowledge-update` | 72 | 93.06% → 93.06% | 0 | 22,680 → 22,667 |
| `assistant` | 56 | 96.43% → 96.43% | 0 | 22,639 → 22,639 |
| `abstention` | 30 | 100.00% → 100.00% | 0 | 23,053 → 23,053 |

**The route that kept its room gained a question and the route that lost half of its room lost one.**
`temporal` delivered 23,877 characters against 47,852 and paid one question for it — the second
independent measurement of that cut (§7 read 2 questions at p = 0.63; this reads 1 at p = 1.0), which
is what §5 got wrong when it wrote that the temporal route needs its neighbours *and* its width. It
needs its neighbours. The width it was holding was 24,000 characters of context that 127 questions
did not read.

**What the arithmetic got right and what it got wrong.** §7 predicted 453–455 correct at about 7,508
tokens; the majority count is 454 and the bill is 7,448 — both inside the interval, which is the first
time in this campaign a prediction computed from two measured arms landed on its own centre. §5's
prediction of a different middle (91.00% at 8,567, with `temporal` kept wide) was never run, because
the cheaper middle was available: §5's middle was the *conservative* one, and the cut it protected is
the one that turned out to be free twice.

**One correction to §7's witness, because this artifact can see it.** §7 read the four untouched
routes' delivered characters as identical, and used that as evidence the run never touched them. Here
they are not identical: `flat` +2, `knowledge-update` −13, `multi-session` +4, against rooms that did
not move. The cause is not the room — it is that a build arrived between the two dispatches carrying
`supersededRendering: 'off'` and `replyRepair: 'off'` as recorded fields, and the assembler renders a
few characters differently under them. So the witness for "this route was not cut" is the **cap**, not
the delivered mean, and the bound on build drift is 13 characters in 22,680 (0.06%). A mean-difference
test tight enough to call that a treatment effect would be too tight for this instrument.

**What this did not buy.** `C1` is 7,448 against a 6,000 aim — still a miss, now at **1.24×** instead
of 2.09× (against the old 9,201). Against the published board it is **1.69× Zep's 4,400**, **1.10×
Mem0's 6,800** and **1.006× Maximem's 7,400** — i.e. the bill is now the same as the accuracy leader's
and the accuracy is 4.35 points below it. The gap that remains is not a room: it is `MR` at 83.47%
against MemCog's published 92.48%, and §31.8 of the plan shows that on 48,000 characters the gold
turns are already delivered for 17 of the 21 `MR` questions this arm answers wrong.

## 9. What a call that names no room actually gets

Everything above is a table, and a table is worth nothing to a deployment that assembles the product and
never sets one. Until this release it got `CortexMemory`'s global 48,000 on all six routes: not the 91.25%
arm, not either cut cell, and **dearer than the arm that was measured**.

`assembleMemory` now defaults to `REGISTERED_ROOMS` — `multi-session` 48,460, the other five 24,000. Three
cases, and the difference between them is what a caller wrote:

| what the caller wrote | what the six routes get |
| --- | --- |
| nothing | the registered table |
| `maxPromptChars: N` | `N` on all six (a shape, not a gap — the table is not merged in) |
| `maxPromptCharsByRoute: { … }` | the map **over** the table, so one route moves and five stay as measured |
| `profile: 'minimal'` | the class's global 48,000, because that profile's 39.55% was measured there and it ranks nothing |

`assemble-rooms.test.ts` holds both ends of that: the default is byte-identical to stating the table
explicitly, and it is **not** the global — asserted through `answer` on a 57,000-character corpus, where the
24,000 and 48,000 rooms produce different prompts. The same file reads `tools/arm-config-baseline.json` and
fails if this constant and the dispatched arm disagree in either direction, which is the only way a
product constant and a benchmark registration can be kept honest about being the same configuration.

One consequence is worth stating plainly, because it is the kind of thing a default hides: **the shipping
product is now the arm every published reading was taken on.** "What ships is what was measured" was true of
the code paths and false of the configuration for nine rounds, and the fix was not a new mechanism — it was
naming the first arm as the default instead of inheriting a fourth one.
