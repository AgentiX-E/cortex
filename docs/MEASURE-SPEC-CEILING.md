# The ceiling of the specification grammar, measured before it was dispatched

## 0. In one paragraph

`reviewPass: 'tally'` was dispatched on a hypothesis and priced at **−9.5 multi-session questions**; its
autopsy found no arithmetic error among the ten losses, only ten wrong *operands*. The next mechanism,
`reviewPass: 'spec'`, replaces the reader's per-line judgement with a typed plan over a ledger compiled
by programme. Before paying for a second dispatch this document answers the cheaper question: **is there
any plan in that grammar that produces the gold answer?** Over the 17 multi-session failures whose gold
carries a number, a plan over the **question's own vocabulary** reaches **8**, a plan over **any word the
history uses** reaches **12**, and the **5 that remain unreachable are four money sums and one page-count
pair** whose operands share a turn with distractor numbers. That residual is the turn **grain**, not the
prompt — and it is the next increment rather than a longer instruction.

## 1. Why this measurement exists, and why it is offline

Round 61's lesson was structural. A pass was built on the belief that "the reader can find the operands
and cannot add them", dispatched, and lost ten questions; the autopsy showed the operands were wrong, so
the belief had been tested on a population it did not describe. The cheap instrument that would have
prevented it is the one in this document: an **offline search** over the mechanism's own grammar, using
the real executor and the real corpus, costing nothing but wall clock.

The question is deliberately a *ceiling*, not a prediction. It asks whether the mechanism **could** reach
the gold with a perfect plan author. A no is decisive (no specifier could have succeeded); a yes is only
permission to spend the dispatch.

## 2. The instrument

```
node --import tsx bench/measure-spec-ceiling.ts \
  --dataset  <longmemeval corpus> \
  --artifact <benchmark-cortex-memory-ablation-report.json> \
  --capability MR [--keywords question|history] [--max-keywords 500] [--json out.json]
```

It takes the control arm's **failing** questions, rebuilds each question's history from the corpus into
the turn strings the pipeline renders, compiles a ledger with the real `buildLedger`, and enumerates every
plan the grammar can express over a vocabulary and a small operation set:

| axis | values searched |
| --- | --- |
| keyword | every content word of the **question** (stoplist applied, crude stem added), or every word the **history** uses, rarest first and capped |
| unit | `null` plus every unit the ledger's own vocabulary carries |
| operation | `count`, `sum` — the two the renderer can answer with |
| scope | the whole history |

Each plan is executed by `executeSpec` and rendered by `renderAggregate`, and the result is compared to
**every** number the gold carries (`"5 days. 6 days (including the last day) is also acceptable."` accepts
both). Two ceilings are reported:

- **copy** — does a single turn already state an acceptable number?
- **grammar** — does some plan produce one?

`copy` is the weaker bound and it is reported because a question with no copy and no plan is not a
specification problem at all, and counting it against the grammar would misdirect the next increment.

## 3. The measurement

Control arm `42533236864`, 500 questions, four repetitions. Its 20 multi-session failures: **17 carry a
number**, 3 do not (two list answers and one name).

| | reached | of 17 |
| --- | ---: | ---: |
| copy ceiling | 11 | 64.7% |
| grammar, question vocabulary | **8** | **47.1%** |
| grammar, history vocabulary (500 rarest words) | **12** | **70.6%** |

Per question, with the number of matching plans in each vocabulary — a gold reachable by **one** plan is a
different proposition from one reachable by **fifty-four**, and the dispatch has to be read with that in
mind:

| id | copy | question vocab | history vocab | plans (q/h) | gold |
| --- | --- | --- | --- | ---: | --- |
| `6d550036` | yes | **yes** | **yes** | 4 / 54 | `2` |
| `3a704032` | yes | **yes** | **yes** | 2 / 30 | `3` |
| `88432d0a` | yes | **yes** | **yes** | 15 / 63 | `4` |
| `gpt4_7fce9456` | yes | **yes** | **yes** | 6 / 636 | four properties |
| `60bf93ed` | yes | **yes** | **yes** | 4 / 90 | `5 days…` |
| `bf659f65` | yes | **yes** | **yes** | 3 / 51 | `3` |
| `9ee3ecd6` | yes | **yes** | **yes** | 1 / 52 | `100` |
| `21d02d0d` | yes | **yes** | **yes** | 3 / 63 | `2` |
| `gpt4_372c3eed` | yes | no | **yes** | 0 / 23 | `10 years` |
| `gpt4_2f91af09` | no | no | **yes** | 0 / 3 | `23` |
| `d905b33f` | yes | no | **yes** | 0 / 3 | `20%` |
| `c18a7dc8` | yes | no | **yes** | 0 / 4 | `7` |
| `d851d5ba` | no | no | no | 0 / 0 | `$3,750` |
| `gpt4_731e37d7` | no | no | no | 0 / 0 | `$720` |
| `2b8f3739` | no | no | no | 0 / 0 | `$495` |
| `d6062bb9` | no | no | no | 0 / 0 | `1,998` |
| `37f165cf` | no | no | no | 0 / 0 | `856` |
| `gpt4_2f8be40d` | — | — | — | — | list answer |
| `gpt4_2ba83207` | — | — | — | — | `Thrive Market` |
| `gpt4_ab202e7f` | — | — | — | — | list answer |

## 4. What the residual five are, in one sentence each

Every one of the five is a **sum whose operands share a turn with distractor numbers**, which is why no
single keyword isolates them:

- `d851d5ba` `$3,750` — three amounts are stated across the history; the sum needs the subset that
  belongs to the sale, and the turns that state the others also state things the keyword matches.
- `gpt4_731e37d7` `$720` and `2b8f3739` `$495` — same shape, different arithmetic: a per-item price times
  a count, with the count and the price in different turns.
- `d6062bb9` `1,998` — two platform view counts that must be added, each stated beside other numbers.
- `37f165cf` `856` — `440 pages` and `416 pages` in one turn each, with a date and a page count in the
  same sentence.

**This is a grain problem and it has a name in the literature.** TallyMem's ledger has one row per
*logged step* with annotated fields (targets, outcomes, changes), and StructMemEval's counting subset is
built on **transaction ledgers**. Both are finer than a turn: their rows are events. A turn-grain ledger
can say "the turns that mention a sale" and cannot say "the amounts of this transaction". No keyword, and
therefore no prompt, reaches that distinction — which is exactly why the residual is reported as a
ceiling rather than as a bug to be fixed next round by wording.

## 5. What the measurement changed in the implementation

Three things, all before the dispatch:

1. **The plan prompt carries a compiled table, not the window.** Per keyword: how many turns contain it,
   how many of those state a number, and the sums by unit. A model choosing from the table is choosing a
   number it has already seen, and the table is built by the same `mentions` predicate the executor runs,
   so the prompt and the executor cannot disagree about what the history contains.
2. **The text predicate matches at a word start, not anywhere.** The first version used
   `text.includes(keyword)` and a keyword table for *"how many books did I read"* selected a turn that said
   *"I baked bread"* and reported its two hours. Word-start prefix keeps `bake`→`baked` and refuses
   `bread`→`read`; the limit that it does **not** reach `baking` is stated in the code rather than papered
   over.
3. **The table's vocabulary is the question's, and the contract allows more.** The prompt prints the
   question's words because that is the cheapest honest hint, and the parser accepts any string, so a model
   that knows to say `sold` where the question said `sales` can. The gap between 8 and 12 is precisely that
   act of naming, and it is what the dispatch measures.

## 6. The four things this does not claim

1. **Not a prediction of accuracy.** A ceiling of 12 needs 12 correct plan choices. The mechanism's
   registered bar is 3 questions, not 12.
2. **Not a ceiling over the whole vocabulary.** The history search is capped at 500 words, rarest first;
   12 is therefore a **lower bound** on the history ceiling, not its value.
3. **Not a statement about the three non-numeric golds.** They are outside the measurement by construction:
   the renderer answers counts and sums only, and a list answer is the tally pass's failure mode.
4. **Not a verdict on the mechanism.** The verdict needs the dispatch, and the dispatch needs the runner.

## 7. Status

The mechanism is wired (`reviewPass: 'spec'`), off by default, with its census (`attempted`, `changed`,
`refused`), its report section, its dispatch input and its gate membership. The default remains `bare`.

| | value |
| --- | --- |
| population (multi-session failures with a numeric gold) | 17 |
| grammar ceiling, question vocabulary | **8 / 17** |
| grammar ceiling, history vocabulary | **12 / 17** (lower bound) |
| copy ceiling | 11 / 17 |
| unreachable, and why | 5 — four money sums and one page pair; the operators share a turn with distractors |

**Next.** Dispatch `spec` on the runner and read it against the shipped arm. If `MR` moves by fewer than
three questions, the finding is about the grain and the next increment is an **annotated ledger** — one row
per event, compiled before the question — rather than a longer plan language.
