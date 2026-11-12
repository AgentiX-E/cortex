# The first like-for-like pairing: 500 questions, both sides' per-question records, no re-run

Every gap this campaign has quoted has been a **difference between two harnesses** — this arm's 91.20% against
Maximem Synap's 95.60% — and the two numbers were produced by different answer models, different judges and
different prompting. Section 1 of this file states what that costs: a subtraction across harnesses is not a
measurement, and the campaign has been treating it as one for several rounds.

That stops here. Synap published `question_records_gemini-3.8-flash.json` in
`maximem-ai/eval_benchmark_runs_output`, 500 records keyed by LongMemEval's own `question_id`. This arm's
control artifact, `42533236864`, is keyed by the same ids. **All 500 pair up.** No re-run, no model calls, no
judge — two published record sets, joined on the only key both sides were given.

The pairing does not make the accuracies comparable, because the answer models and judges still differ. It does
something the accuracies cannot: it names **which questions** the difference is made of, and what those
questions have in common.

## 1. The matrix

| | theirs wrong | theirs right |
| --- | ---: | ---: |
| **ours wrong** | 8 | **36** |
| **ours right** | **14** | 442 |

Theirs 478/500 (95.60%), ours 456/500 (91.20%). The net is 22, and 22 = 36 − 14. **The entire gap is 36
questions they answer and this arm does not, minus 14 this arm answers and they do not.** Any account of the
four-point difference that does not name those 36 is an account of the model or the judge, not of the system.

## 2. The 36, by capability

| this arm's capability | count |
| --- | ---: |
| `MR` | 14 |
| `IE` | 9 |
| `KU` | 7 |
| `TR` | 6 |

| theirs' category | count |
| --- | ---: |
| multi-session | 14 |
| knowledge-update | 7 |
| temporal-reasoning | 6 |
| single-session-preference | 5 |
| single-session-user | 2 |
| single-session-assistant | 2 |

`MR` is 14 of the 36, which is the largest single block and also the block with the most headroom: this arm
already reads 83.47% there against their published 75.2% on the paper's own table, so their 14 wins are not a
category they own.

## 3. What the 36 actually are

Reading all 36 answers side by side splits them into five populations, and only one of them is a reasoning
difference.

### 3.1 Seven `KU` answers that took the superseded value

Every one of this arm's seven `KU` losses is the same failure, and the other side's answer states the mechanism
out loud:

| question | gold | this arm | theirs |
| --- | --- | --- | --- |
| `852ce960` | `$400,000` | `$350,000` | `$400,000 (though you previously stated $350,000)` |
| `a1eacc2a` | `seven` | `Four` | `7 short stories` |
| `f9e8c073` | `five` | `Three sessions` | `5 sessions (though you previously mentioned 3)` |
| `59524333` | `6:00 pm` | `7:00 pm on Mondays, Wednesdays, Fridays` | `6:00 pm` |
| `e66b632c` | `27 minutes and 45 seconds` | `26 minutes and 30 seconds` | `27 minutes and 45 seconds` |
| `69fee5aa` | `38` | `37` | `38` |
| `c7dc5443` | `5-2` | `3-2` | `5-2` |

Their answers **name both values and pick the later one**. This arm's pick the earlier one, every time. That is
`MEASURE-FAILURE-STABILITY.md` section 3's finding reproduced by a second system: the rule is stated in the
contract and the comparison still fails, because it is a comparison demanded across a window rather than a
missing instruction. **The failure is one mechanism, not seven accidents**, and its repair is the one this file's
section 14.10 closed: a second consultation cannot make the comparison the first consultation could not make.

### 3.2 Five `single-session-preference` questions where the evidence retrieved was the wrong session

The golds are criteria — *"The user would prefer suggestions of hotels in Miami that offer great views"* — and
this arm's replies are **the evidence block quoted back**, which the report's census calls `evidence-echo`.

| question | what the gold needs | what was retrieved |
| --- | --- | --- |
| `0edc2aef` | hotels in **Miami** | a Seattle hotel conversation |
| `57f827a0` | plans to replace the **bedroom dresser** | a smart-home troubleshooting turn |
| `09d032c9` | the **portable power bank** already owned | a turn about drinking water |
| `1da05512` | current **home network storage capacity** | a generic NAS explainer |
| `5d3d2817` | `Marketing specialist at a small startup` | a pharmaceutical career profile |

**This is retrieval, and the retrieval is lexical.** `lexicalRelevance` scores a turn by how many of the
question's content terms it contains; a preference question's distinguishing term ("Miami", "dresser", "power
bank") is exactly the term the wrong session does not contain, and none of the five questions' terms appear in
the session that holds the preference. Their system extracts **preferences as a memory type** at write time, so
the question never has to match a term — it matches a type.

### 3.3 Eight `MR` answers that differ from the gold by one or two

`6d550036` 0 against 2, `gpt4_2f8be40d` 6 against 3, `88432d0a` 5 against 4, `gpt4_7fce9456` 5 against 4,
`2b8f3739` $375 against $495, `gpt4_372c3eed` 8 against 10, `gpt4_2f91af09` 22 against 23, `21d02d0d` 1
against 2. These are `MEASURE-REVIEW-TALLY.md`'s population and they are judgement differences, not arithmetic
ones: `gpt4_7fce9456` is the clearest, where the other side hedges — *"5 (or 4 if excluding the townhouse
itself)"* — and this arm commits to 5.

### 3.4 Six `TR` answers that order or subtract dates differently

`gpt4_7abb270c` drops a museum from a six-item ordering, `gpt4_f420262c` puts United before JetBlue, `370a8ff4`
computes 11 weeks where the gold says 15, `9a707b81` says 26 days where the gold says 21. Their answers carry a
per-item date list; this arm's carry the interval.

### 3.5 Three replies that are not answers at all

`afdc33df` (*"The evidence does not contain tips specifically for keeping the kitchen clean"*), `cc539528` (*"No
back-end programming languages were recommended in this evidence"*), `gpt4_8279ba03` (*"No matching items in the
provided evidence"*), and `60bf93ed`, whose parsed answer is the empty string. These are contract violations
rather than mistakes, and section 4 prices them.

## 4. The shape census, which the pairing made urgent

`evidence-echo` is not a new observation — `MEASURE-ORACLE-CEILING.md` section 7.4 counted six of them — but the
pairing shows they are concentrated where the gap is. Running the product's own `classifyReply` over the control
artifact's 500 raw replies, with two deterministic openers added to separate the echo from the rest:

| reply form | n | wrong | wrong rate | mean characters |
| --- | ---: | ---: | ---: | ---: |
| `committed` | 425 | 30 | **7.1%** | 207 |
| `bare-decline` | 30 | 0 | 0.0% | 21 |
| `shape-failed` (not a dump) | 28 | 4 | 14.3% | 617 |
| **`evidence-echo`** | **15** | **8** | **53.3%** | **2,952** |
| **`no-evidence-prose`** | **3** | **3** | **100%** | 281 |
| `prose-decline` | 1 | 1 | 100% | 288 |

Three readings follow, and the third is why this is a repair rather than a note:

1. **A reply that is a transcript dump is wrong seven and a half times as often as one that is an answer**
   (53.3% against 7.1%), and it is 14 times as long. **The rate is right and the name is wrong**: see the correction
   below, which shows there is no dump in this corpus and that what the 15 have in common is having been retried.
2. **A shape failure that is not a dump is a different population.** Its 28 replies are wrong four times, which
   is 14.3%. That is the arithmetic that made `replyRepair: 'shape'` a bad trade — it re-asks 44 replies to reach
   12 wrong ones — and it is why the repair registered below is scoped to the echo rather than to the shape
   failure it belongs to.
3. **The echo has a marker no answer can have.** Every one of the 15 begins a line with `[YYYY/MM/DD ...]`, which
   is this product's own evidence rendering. `parseAnswer` has no way to tell it from an answer, so it returns
   2,952 characters of transcript and the judge scores it wrong. Nothing about that is a question of inference — and
   the parser, not the model, is where the 2,952 characters were produced. See the correction below.

**Correction (`MEASURE-RETRY-SHAPE.md`).** The counts above reproduce exactly, and the reading they were given does
not survive being opened. All 15 replies **end with an answer line**; the parser concatenated the list, the blank line
and that answer because the builders behind them asked for a list without a step heading and closed with a sentence
instead of an `Answer:` label. Sorting the 16 stamped answers by what they contain:

| what the reply contains | n |
| --- | ---: |
| a stamped list followed by an answer line | 16 |
| a stamped list and nothing else | **0** |

So `evidence-echo` in this artifact is a **parsing defect wearing a model-behaviour name**, and the 53.3% belongs to
the population the retry selects (first reply was a bare decline) rather than to a reply form. Two consequences:

- The `echo` gate's `attempted: 0` on `43121298653` is not an unexplained zero: there was nothing of that shape for it
  to fire on, and the 14 replies it was registered against were the parser's reading, produced after the gate ran.
- The repair is a label, not a re-ask: all three list-asking builders now close on `Answer: <the answer>`.

## 5. What the pairing forbids, and what it licenses

**Forbids** two things this campaign was about to do:

- Reading 95.60% as "4.40 points behind". Synap's own paper reports **92.0%** on `gpt-5-mini`, and its
  multi-session column is **75.2%** — below this arm's 83.47%. The 3.6-point spread between their two published
  figures is the size of the harness effect, which is larger than the gap being chased.
- Aiming the next arm at `MR`. `MR` is 14 of the 36 losses, but this arm is already ahead of them there, and its
  failures are judgement (section 3.3) — the one population eight mechanisms have failed to move.

**Licenses** three, in cost order:

1. **A deterministic echo gate** (section 4.3). The marker is `[YYYY/MM/DD` at the head of a line, the predicate
   is decidable without a model, and the reply it catches cannot be a correct answer. The repair is one
   consultation that says what the reply did wrong — the same shape as `commitment`, on a disjoint population.
   Section 5 of `03-execution-plan.md §14.116` registers it. **It was dispatched and reached nothing**:
   `43121298653` recorded `echo.attempted: 0` on all 500 questions while its final replies still contain 14
   dumps. The census this item rests on counts the **last** call, and the gate sits behind the **first**:
   all 14 were written by the bare-decline retry. `MEASURE-ECHO-REACH.md` reads the run, and re-registers the
   line in the retry prompt instead — zero added calls for the same 75-question population.
2. **`preference` as a retrieval type.** Five losses share one cause: the question's terms are absent from the
   session that holds the preference. This is the first loss population in the campaign whose repair is neither a
   prompt nor a pass but a **different index**, and it is also the population where the competitor's write-time
   extraction shows its clearest advantage. It is registered and not priced.
3. **A like-for-like run**, which is now a smaller task than it looked: their harness is MIT, takes a `Provider`
   with four methods, and its judge call is `openai.AsyncOpenAI()` with no arguments — so `OPENAI_BASE_URL` and
   `OPENAI_API_KEY` may be pointed at the reader's own vendor. That is what makes "is this arm SOTA" answerable
   rather than arguable, and it is the only remaining question the campaign cannot answer from its own artifacts.

## 6. Their reading contract, measured against ours

The gap is not only which questions are wrong; it is what each system tells its reader to do. Synap published its
answering prompt (`LME_answering_prompt.md`, 21,366 characters, 3,622 words, seven numbered steps and four
sub-steps). This arm's contract block, measured by building one prompt per contract on a one-turn window:

| contract | instruction characters |
| --- | ---: |
| `extractive` | 229 |
| `abstention` / `temporal` | 383 / 379 |
| `assistant` | 409 |
| `knowledge-update` | 580 |

**37 to 93 times shorter.** That is the single largest structural difference between the two systems, and it runs
opposite to where this campaign has spent its rounds: the window (23,994 median characters of delivered prompt on
`42533236864`) has been tuned for twenty rounds, while the instruction that reads it is between two and five lines.

| dimension | theirs | ours |
| --- | --- | --- |
| **evidence** | write-time extracted facts, one per line: `[n] (said <date>) [thing N] <fact>`, plus `said_at`, `event_date`, `event_precision`, `valid_until` and a `source_evidence` quote | raw admitted turns, `[2023/05/20 (Sat) 03:51] user: …` |
| **attribution** | speaker decides what is proved: an assistant line is evidence of what was *recommended*, never of what the user did | one `assistant` route that *permits* an assistant turn to support an answer; no attribution rule on the user-fact routes |
| **counting** | the unit is fixed before counting — occasions vs objects — then each instance is listed and counted; `[thing N]` says count once | "the number of distinct items, the total of the durations or amounts"; no unit rule |
| **abstention** | three named checks, all must hold; the default is to answer; a bare sentinel is refused when any part is held | permission to decline, plus the token |
| **anti-echo** | *"Never write a reply that says the memories do not hold something and then supplies that very thing"* | nothing; section 4's 15 dumps are repaired after the fact instead |

Reading that table against sections 3 and 4 gives a narrower conclusion than "copy the prompt":

1. **Two of the five gaps name a measured population.** The counting-unit rule lands on `MR` (section 3.3: five of
   the eight differ from the gold by one or two items), and the anti-echo line lands on the 15 dumps, which this
   campaign has already chosen to repair post-hoc at 15 consultations. Neither is registered here: the echo gate
   is registered first, and two treatments on one population cannot be attributed.
2. **Attribution does not name a population** in the 36, so it is not registered. It is written down because it is
   the one rule in their contract that contradicts ours outright.
3. **The evidence representation is the architecture difference.** Their reader is handed a fact list; ours is
   handed a 23,994-character prompt and asked to extract, resolve entities, resolve supersession and do the
   date arithmetic in one pass. `MEASURE-SUPERSEDE.md` §14.11.1 measured what that costs: **40 of the 44
   wrong answers had the gold already inside the delivered window** — 13 fully, 27 partially — and only 4 stood at
   zero coverage. A reader that loses an answer it was given is not a retrieval failure, and the five `preference`
   losses plus the seven `KU` losses are the two populations where a write-time fact list is a different mechanism
   rather than a longer instruction.

That third point is the honest answer to "is the four-point gap capability": their 92.0% factory and 95.60% site
figure differ by 3.6 points on harness alone, and the part of their lead that is *system* is one design decision —
**they read facts, this arm reads transcripts** — which is priced at 12 named questions (5 `preference` + 7 `KU`),
not at 22.

## 7. The adapter is built; the run is not

§5 licensed a like-for-like run and §6 priced the reading contract. Both need the same two files, and they now
exist and are tested:

| file | what it does |
| --- | --- |
| `tools/competitor-adapter/bridge.mjs` | this store behind `tools/competitor-sut/PROTOCOL.md`, with **us** as the child |
| `tools/competitor-adapter/cortex_adapter.py` | their `Provider` ABC: `initialize` / `ingest` / `await_indexing` / `search` / `clear` |
| `tools/__tests__/test_competitor_adapter.py` | seven tests over the five ops, the refusal envelope and the `search` ceiling |

The protocol is reused rather than reinvented: one document already describes how a store is asked three
questions, and a second implementation of it is how two protocols drift into two meanings. The adapter's own
headings say what it refuses — no answer generation inside `search`, `build: none` in the manifest, one store per
`clear`, and a hard top-k on the way out because their `limit` is a session count while this store's hits are
turns (the unit error `provider.ts` records at 25.4% recall).

**What the run can say, and what it cannot.** Their published arm answers with `gemini-3.8-flash` and judges with
`gpt-4o`; this sandbox has neither key, so both roles go to the reader this campaign already pays for. The valid
comparison is therefore **within** the run — their adapter against ours, one answer model, one judge, one corpus
— and where their adapter cannot be run at all (it needs a hosted Synap instance and an `instance_id`), the
remaining honest claim is narrower: *this arm's score under their pipeline*, with the model substitution named in
the same sentence. It is not a SOTA row, and it is not written as one.

**Verified**: the bridge answers all five ops over stdio against `packages/cortex-memory/dist`, and the Python
adapter runs under their own `runner.types` (initialize → ingest → search → clear → close; `manifest` =
`cortex-session`, `build` = `none`, one session in, one hit out, zero after `clear`). **Not verified**: a scored
run. That needs their tree, `requirements-longmemeval.txt`, and the 20-question smoke the README specifies before
the full set.

## 8. What this file is not

It is not a claim that this arm is behind by 36 questions of capability. Thirty-six questions is what one
answer model and one judge produced against another answer model and another judge on the same 500 questions;
sections 3.1 and 3.2 show that at least twelve of them are mechanisms — a superseded value taken, a preference
session missed — rather than capability. The correct reading is narrower and more useful: **there are 36 named
questions, each with a stated cause, and 12 of them have a cause that is already understood.**

