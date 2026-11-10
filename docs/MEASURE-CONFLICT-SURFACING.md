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
