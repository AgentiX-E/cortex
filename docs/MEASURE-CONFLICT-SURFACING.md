# Two statements of one detail, and which came later

`conflict.ts` is the first mechanism since §13.118 acquired a ceiling above its own population's
noise. This document is its reading, taken on the artifact that already exists — **run
`42355323615`, 500 questions × 4 repetitions, `deepseek-chat` as the reader, Zhipu `embedding-3` as
the embedding model, `ask=verbatim-acts`, rooms 48,460 / 48,000 / 24,000 by route** — and it costs
nothing, because the mechanism spends no model calls and the artifact holds every window it needs.

## 1. The failure, stated as a pair

Five of the seven `KU` questions that are wrong in all four repetitions answer with a value the
corpus later replaced, and the replacing statement is inside the delivered window every time:

| question | gold | the reply | the earlier statement | the later statement |
| --- | --- | --- | --- | --- |
| `ce6d2d27` | `Friday` | `Thursday` | 2023/06/16, turn 4 of 66 | 2023/06/30, turn 29 of 66 |
| `9ea5eabc` | `Paris` | `Hawaii` | 2023/05/26 | 2023/05/28 |
| `ed4ddc30` | `20` | `30 dozen` | 2023/01/11 | 2023/03/15 |
| `59524333` | `6:00 pm` | `7:00 pm` | 2023/02/11 | 2023/05/30 |
| `a2f3aa27` | `1300` | `1250` | 2023/05/25 | 2023/05/25 |

The instruction block already carries the rule for this — `knowledge-update`'s shipped text says
"use the evidence with the latest date … if it asks for the current or most recent value, reply with
the later one". So the failure is not a missing instruction and not a retrieval miss
(`MEASURE-FAILURE-STABILITY.md` §3.1 measured `goldOverlap` on all seven: 16/24, 17/24, 17/24,
14/22, 22/22, 17/20, 17/24 gold turns carried). It is a **comparison the reader has to find before it
can perform**, inside 23,084 characters of conversation.

## 2. What the block reaches on the real windows

The block is computed over the artifact's own turns, at their own lengths, not over excerpts:

| question | statements in the block | block chars | gold in the block | gold prints after the replaced value | reached |
| --- | ---: | ---: | :---: | :---: | :---: |
| `ce6d2d27` | 6 | 984 | yes | yes | **yes** |
| `9ea5eabc` | 6 | 1,005 | yes | yes | **yes** |
| `ed4ddc30` | 5 | 721 | yes | yes | **yes** |
| `59524333` | 6 | 1,203 | yes | yes | **yes** |
| `a2f3aa27` | 2 | 584 | no | — | no |
| `69fee5aa` | 6 | 1,154 | no | — | no |
| `0977f2af` | 5 | 935 | no | — | no |

**Reach is four of seven.** The three misses are three different reasons and none of them is a
threshold:

- **`a2f3aa27` — segmentation.** "I think I am close to 1300 now" is the last sentence of a long turn
  whose opening is "I am looking to create a new Instagram post", so the turn's best-scoring sentence
  is the opening: it shares one term with the question where the statement it replaces shares two.
  Every sentence of that turn is about Instagram and one of them carries the number. Widening the
  term threshold until it reached that sentence would also admit every turn that mentions Instagram
  once — and on these 72 questions that population is already 31 blocks that name no gold.
- **`69fee5aa` is not supersession.** The corpus says "I have a total of 37 coins" and later "I just
  added a new coin … a 1915-S Barber quarter". The value is an **increment**, not a replacement, so
  the gold `38` never appears in the text at all. §13.351.5 classified this question as
  stale-value selection; that classification was wrong and this document corrects it.
- **`0977f2af` names neither thing.** The question asks for the gadget bought **before** the Air
  Fryer; neither "Instant Pot" nor the relation to it shares a term with the question. Matching words
  cannot reach a value that is only named by its relation to another one.

Of the **72 `KU` questions**, the block is non-empty on **69**, mean **1,104 characters**, median
1,139, maximum 1,392 — about **2.3%** of a 47,542-character delivered prompt. On 41 of the 69 it
names the gold.

## 3. Why a 2.3% insertion is worth a dispatch and a window rewrite is not

Because it is the only increment in the queue whose ceiling clears its own noise, and because its
cost is the control's bill.

| | value |
| --- | --- |
| ceiling on `KU` | 4 questions = **5.56 points** of 72 |
| ceiling on the file | 4 questions = **0.80 points** of 500 |
| `KU`'s own 2 sd (`MEASURE-FAILURE-STABILITY.md` §2.3) | **2.52 questions** = **3.50 points** |
| model calls the mechanism spends | **0** |
| delivered evidence with the block on | byte-identical to the control's |

The last row is the design constraint and it is a property of the code rather than of the run: the
block is inserted **after** `fitToBudget` decided the carried set, so a run with it on carries
exactly what its control carried. `conflict-reach.test.ts` asserts it by deleting the block from the
treatment's prompt and requiring the control's prompt back, byte for byte, on every route that moves.

## 4. What this does not license

**It does not license calling the block a fix.** Four questions is 0.80 points of the file and the
gap to Synap is 4.40. It is the first increment that can be *read*, not the one that closes the gap.

**It does not license a wider reach by lowering `minTerms`.** The 31 blocks that name no gold on the
other `KU` questions are what that costs, and they are charged to the same room the evidence is.

**It does not license treating `KU` as solved by labelling.** The refusal for this population is not
in the store: §13.351.7 measured that the gold turns are carried, and this document measures that the
pair is one sentence each. The mechanism moves the comparison from the reader to the prompt. Whether
the reader then performs it is the dispatch's question, and it is unanswered.

## 5. Reproduction

```
pnpm --filter @agentix-e/cortex-memory build
node -e "
const { conflictBlock } = require('./packages/cortex-memory/dist/conflict.js');
const A = require('./run-42355323615/.../benchmark-cortex-memory-ablation-report.json');
for (const q of A.questions.filter((q) => q.capability === 'KU')) {
  const block = conflictBlock(q.question, q.turns.map((t) => ({ content: t.text })));
  console.log(q.questionId, block.length, block.includes(q.groundTruth ?? ''));
}"
```

Every number in §2 comes from that loop, run against the archived artifact.

## 4. The first run that administered it: three conversions and five regressions

Run `42754985453` — 72 `KU` questions, 4 repetitions, `capability=KU`, `limit=0`, the registered arm
with `conflicts: true` declared. **The block reached the delivered prompts on all 72 questions, and
the delivered evidence was byte-identical to the archived run's on all 72** (`evidenceChars` equal
question for question), so the only difference between the two arms is the 1.1k characters.

| question | archived control (of 4) | this arm (of 4) | verdict |
| --- | ---: | ---: | --- |
| `ce6d2d27` | 0 | **3** | converted |
| `9ea5eabc` | 0 | **4** | converted |
| `ed4ddc30` | 0 | **4** | converted |
| `59524333` | 0 | 0 | not reached |
| `6a1eabeb` | 4 | **0** | **broken** |
| `89941a93` | 4 | **0** | **broken** |
| `c7dc5443` | 4 | **0** | **broken** |
| `f9e8c073` | 3 | **0** | **broken** |
| `852ce960` | 2 | **0** | **broken** |

`KU` mean: **88.54% → 84.03%**, a net **−2** questions. The three conversions are exactly the three
supersession pairs §2 identified, and the five regressions are not the three reach misses — they are
questions the control answers correctly in every repetition.

### 4.1 What the five regressions say, and it is not "the block is noise"

They are the same failure the block was built to prevent, **induced by the block**:

| question | asks for | control | this arm |
| --- | --- | --- | --- |
| `6a1eabeb` | 5K personal best | `25:50` | `27:12` |
| `89941a93` | bikes owned **currently** | reasoned to `4` | `Three bikes.` |
| `c7dc5443` | **current** volleyball record | `5-2` | `3-2` |

All three are "current" questions, all three were answered with the **earlier** value, and all three
saw a block whose third sentence said *"If the question asks about a previous state, the earlier
statement is the answer."* That sentence was written for `0977f2af` — which this mechanism cannot
reach at all (§2: it shares no term with either gadget). So it bought nothing and cost three
conversions, and the block is now directional: it says the later statement is the value now and
offers no invitation to the earlier one.

The value-only gate of §4.2 was measured against these five and **did not save them**: four of the
five still fire, because they genuinely contain two different values. A reader given two numbers and
told nothing about which is current picks one; a reader given two numbers and told a rule that
mentions "previous state" picks the earlier one more often than the control did.

### 4.2 The gate that was added, and what it is worth

The first version printed any two statements about the question's subject — "related statements",
which is what §1 priced at 4/7 reach and 41/69 naming the gold. It now prints only statements that
state a **value** (a weekday, a month, a clock time, a number, or a capitalised name) and only when
two of them state **different** values:

| | before | after |
| --- | ---: | ---: |
| blocks printed (of 72) | 69 | 64 |
| blocks naming the gold | 41 | 42 |
| of the five regressions, still fire | — | 4 |

So the gate is a small improvement in precision and **not** the fix. It is kept because it is the
honest population — a statement with no value cannot conflict with anything — but §4.3 records that
it is not what turns this mechanism from a net loss into a gain.

### 4.3 The bar, against this reading

The registered bar was **≥ 3 of 4 stable conversions**, and this run met it on the letter (three) and
failed it on the sentence that followed: *no capability worse than 2 sd of its own spread*. `KU` fell
**4.51 points** against a 3.50-point 2 sd, on identical evidence. **The mechanism as registered is
rejected.** What is registered next is the directional block of §4.1 with the same target set and a
bar that cannot be met by a trade: **≥ 3 conversions and no regression among the 65 questions the
control answers in every repetition**, falsifier any regression in two or more repetitions.

### 4.4 What the run also showed, about the instrument

The reference pipeline answered **0 of 72** under `capability=KU` — it declined on 58 and answered
the other 14 wrong, against 65 of 72 correct in the full-file run. So a capability-scoped dispatch
has **no usable within-run control**, and this section's comparison is against the archived
full-file artifact on byte-identical evidence rather than against the arm's own baseline. That is
recorded as a defect of the harness rather than of this mechanism: every capability-scoped arm in
this campaign would have carried it.
