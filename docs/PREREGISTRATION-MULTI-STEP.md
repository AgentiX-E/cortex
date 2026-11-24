# Pre-registration — the reader looks twice

**Status:** pending — not dispatched, or dispatched and not yet read: no Result section exists for it.

## 0. What is being tested, and why now

`MR` is the only capability where this repository is level with its own reference pipeline and behind
every published competitor: **102 of 121 (84.3%)** against Synap's 92.6 and MemCog's 92.48. Three plans
have been written against that gap — `[thing N]` item identity, a listing contract, and more room — and
each was dispatched against the explanation the previous document happened to name. Two of the three
are now retired by measurement (`RETRACTIONS` #12 for the room, #24 for the listing contract), and the
third offline clue points somewhere new.

`44962474136`'s wrong `MR` questions, read at the level of the reader's own `Step 1`:

| question   | reader's list                              | answer | gold |
| ---------- | ------------------------------------------ | -----: | ---: |
| `0a995998` | blazer at the dry cleaner, boots at Zara   |      2 |    3 |
| `2ce6a0f2` | gallery lecture, "Women in Art" exhibition |      2 |    4 |

Both questions delivered **every gold turn** (`goldOverlap.carried == total`: 17/17 and 11/11) and both
blocks were **46,758 and under** of a 48,460-character room. So the reader was shown the evidence, had
room left, and listed two of three or two of four. That is neither a retrieval result nor a room
result, and it is the one shape no `ask` can fix: `enumerated` was designed for exactly this population
and made `MR` **worse by 6.2 questions**.

The mechanism this document registers is the other remedy the evidence allows: **give the reader a
second look, aimed by what it saw the first time.** A reader that lists two of three items and then
searches for the third has a chance; a reader handed the same 194 turns twice does not.

## 1. What is already measured, and what is not

`44867629266` (probe, `maxSteps=1`, `MR` 121 questions) read:

```
gold seed / selected / carried / total : 862 / 1448 / 1377 / 3663
searches that added evidence            : 118 of 121 questions
found but not carried                   : 71
```

Two facts, and they are both needed:

1. **The reader's own search adds evidence on 118 of 121 questions** (+586 gold turns over the seed).
   The loop is not neutral; it is the largest single source of new gold this repository has measured.
2. **71 of 121 questions have gold found and not carried.** The room then refused it. On the questions
   in §0 the room refused nothing, so these 71 are a different population — and both populations are
   large enough that a single mechanism could plausibly reach either.

What is _not_ measured: whether any of it converts to a correct answer. The probe reports evidence
coverage, not accuracy, and this campaign has made the mistake of reading a delivery fact as a
capability fact twice (`RETRACTIONS` #22 is the first).

## 2. The mechanism, and where it lives

`cortex-ai/agent` already holds the loop: `retrieveStepwise` takes a `Retrieval`, a `Renderer` and an
`LLM`, and returns the ids the reader chose. It depends on `cortex-core` and nothing else, which is
what makes it legal for an evaluation arm to call without reversing a dependency.

The measurement needs one thing that does not exist yet: a way for the arm to ask **the product's own
index** for a query, so the second look uses the registered ranking rather than a second implementation
of it. The product change is one public method:

```ts
// packages/cortex-memory/src/memory.ts
/**
 * The turns this memory would show for a query, in the order it would show them.
 *
 * Public because "what do you have about X" is a question a user asks, not only a harness, and
 * because the alternative -- an arm building its own index -- would make the second look a
 * measurement of a different ranking than the one under test.
 */
async search(query: string, options?: { readonly k?: number }): Promise<readonly SearchHit[]>;
```

`SearchHit` stays module-internal (the census already retired it as an export); the return type is
`readonly { turn: number; score: number }[]` spelled out at the boundary.

## 3. The registered comparison

| field         | control                                                     | treatment                   |
| ------------- | ----------------------------------------------------------- | --------------------------- |
| configuration | the registered arm (`91.25%`, run `43140878641`)            | same, plus `readerSearch=1` |
| capability    | all five                                                    | all five                    |
| questions     | 500                                                         | 500                         |
| repetitions   | 4                                                           | 4                           |
| reader        | `deepseek:deepseek-chat`, `thinking=multi-session+temporal` | same                        |
| room          | 48,460 multi-session / 24,000 elsewhere                     | same                        |

`readerSearch=1` means: after the registered retrieval, the reader is asked once for **one** additional
query, the product's index answers it, and the union is ranked by the same relevance signal before the
room is applied. Not a re-render of everything found — the union goes through the registered ranking,
so the second look costs ordering, not characters.

## 4. Bars, both directions, written before the dispatch

| #   | bar                                                              | verdict if missed                                                  |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `MR` **≥ +3 questions** (102 → ≥105)                             | < +1 closes the axis; +1..+2 is a null and is not dispatched again |
| 2   | exact McNemar, two-sided, **p < 0.05** on the paired `MR` roster | a ≥3-question move at p ≥ 0.05 is a null at this sample            |
| 3   | prompt tokens per question **≤ 1.30×** (7,448 → ≤9,682)          | > 1.30× needs its own justification before a second dispatch       |
| 4   | **no capability moves down by more than 2 questions**            | any row at −3 or worse fails the run whatever `MR` does            |
| 5   | total accuracy **≥ 91.25%**                                      | below the control means the mechanism trades `MR` for elsewhere    |

Bar 4 exists because of §2 of `MEASURE-ENUMERATED-ASK.md`: an untreated row moved 3 questions on four
repetitions, so a two-question floor is the largest claim this sample supports.

## 5. Cost

| item                                                     | estimate     |
| -------------------------------------------------------- | ------------ |
| one 500×4 dispatch at 1.3× prompts                       | **≈ 24 CNY** |
| the probe re-run before dispatch (121 questions, 1 step) | ≈ 0.6 CNY    |
| total to a verdict                                       | **≈ 25 CNY** |

The budget is stated before the dispatch for the reason `03-execution-plan.md` §13.147.3 gives: a run
whose price is discovered afterwards is a run nobody can decide about in advance, and the last three
dispatches in this campaign were approved on an estimate that had been computed the same way.

## 6. What would falsify the mechanism being the one that mattered

If `MR` moves but the **discordant set** is dominated by questions whose first-look list was already
complete, the gain came from something other than the second look (a longer prompt, a different order,
noise) and the mechanism name would be wrong even with a positive number. The reading therefore
includes, for every flipped question, whether the reader's `Step 1` list on the control was short —
that is `tools/readout-arm-run.py --lists` and it is the only check that separates "looked twice" from
"got lucky".
