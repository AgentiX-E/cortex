# What a run costs, and where the remaining accuracy is

Two questions that were being answered separately and were in fact one: **how much does a pass
spend**, and **what is left to fix**. The first is now an instrument on the dispatch path
(`tools/spend-projection.mjs`, gated by `--budget`); the second is a reading of the archived
artifacts that changes what the next run should be.

## 1. The answer in three sentences

**One full pass of the cortex-memory A/B costs 14.26 CNY** -- 500 questions, 4 repetitions, 27.23M
prompt and 2.29M completion tokens on artifact `42467`, priced at the provider's published
2026-11-09 rates. **The same measurement on 200 questions at 2 repetitions costs 2.85 CNY**, which
is 20% of it and is enough to answer whether a change moved the arm. **Nothing on the dispatch path
said either number**, so the two dispatches looked identical at the moment of choosing, and the
archive is seven full passes deep in one day.

## 2. Where the money goes, by line

`42467`, feature arm, priced with `tools/spend-projection.mjs`:

| line | tokens | CNY | share |
| --- | --- | --- | --- |
| input, cache hit | 26.15M | 5.23 | 36.7% |
| input, cache miss | 1.08M | 2.16 | 15.1% |
| output | 2.29M | 6.87 | 48.2% |
| **total** | | **14.26** | |

Two readings in that table are not obvious and both change what an optimisation should be.

**The cache already absorbed the input line.** 96.0% of the prompt tokens are prefix-cache hits,
priced at 0.2 CNY/M against 2 CNY/M. Priced as if it were all uncached the same run is **61.34 CNY**, so
the design that puts the stable block first is worth **47.08 CNY a pass** and is already in place. What is
left on that line is 27.23M tokens at an average of 0.27 CNY/M, which is close to the floor.

**The output line is the largest one, and it is not the answers.** Feature completion is 1,071
tokens per call, while the median delivered answer is **18 characters** and the sum of all 500 raw
outputs is 145K characters -- about 36K tokens, or 1.6% of what was billed. The rest is reasoning:
`DEEPSEEK_THINKING` is `multi-session+temporal`, and those are the two routes where the answer is a
count over evidence that is spread across sessions.

## 3. What that means for optimisation, in the order the money is

| lever | effect | verdict |
| --- | --- | --- |
| fewer questions (500 -> 200) | -60% on the question axis, and the sampler keeps every capability | **adopt for screening** |
| fewer repetitions (4 -> 2) | -50% on the repetition axis; McNemar still pairs | **adopt for screening** |
| narrow the thinking reach | up to -6 CNY (-42%) | **test, do not assume** |
| shrink the delivered context | -2.4 CNY at most | **reject** |
| judge verdict cache | -0.15 CNY | not worth the change |

The two rejected rows are the interesting ones.

**Shrinking the context is refused because the input line is already cheap.** Halving the delivered
window from 48,460 to 24,000 characters would save about 2.4 CNY on a 14.26 CNY run, and the room
experiment recorded in `PREREGISTRATION-CORTEX-MEMORY-ARM.md` measured the price on the other side:
at that window `MR` loses 6.61 points and `TR` loses 4.72,
while `IE`, `KU` and `ABS` fall by less than 1.4. Two and a half CNY against eight points of the
capability the arm is losing on is not a trade.

**Narrowing the thinking reach is the one lever that could be worth 40%, and it is refused as a
projection.** The reasoning tokens are a property of the questions asked, not of the reach that
enabled them, so a tool that scaled completion by the reach would understate a thinking run and
overstate the saving from disabling it. `project()` therefore returns `thinkingReachChanged` and a
**lower bound**, and the answer for the reach is a measurement: a screening run at the narrower
reach, paired against the shipped one.

## 4. Where the remaining accuracy is, and where it is not

The category table says the arm is 3.65 points behind the vendor's published figure, and that the
gap sits in two rows: `KU` 88.89% against 97.2 (-8.33) and `MR` 83.47% against 92.6 (-9.13). Every
other row is at or above parity, `ABS` by +6.7.

The question a repair depends on is **whether the evidence was there**. `goldOverlap` answers it per
question, and on `42467` the answer is that **no wrong answer on any capability had its gold
entirely absent from the delivered window**:

| capability | n | accuracy | wrong | gold absent | gold partial | gold fully carried |
| --- | --- | --- | --- | --- | --- | --- |
| IE | 150 | 94.0% | 9 | 0 | 5 | 4 |
| MR | 121 | 82.6% | 21 | 0 | 10 | 11 |
| TR | 127 | 93.7% | 8 | 0 | 4 | 4 |
| KU | 72 | 88.9% | 8 | 0 | 7 | 1 |
| ABS | 30 | 100.0% | 0 | 0 | 0 | 0 |

Reproduce with the artifact and the `goldOverlap` field:

```sh
python3 - <<'PY'
import json, collections
d = json.load(open('benchmark-cortex-memory-ablation-report.json'))
stat = collections.defaultdict(collections.Counter)
for x in d['questions']:
    o, s = x.get('goldOverlap'), stat[x['capability']]
    if o is None: continue
    carried, total = o['carried'], o['total']
    if x['correct']: s['correct'] += 1; continue
    s['wrong'] += 1
    s['absent'] += carried == 0
    s['full'] += total > 0 and carried / total >= 0.99
    s['partial'] += 0 < carried and not (total > 0 and carried / total >= 0.99)
for cap, s in stat.items():
    print(cap, s['correct'] + s['wrong'], f"{s['correct']/(s['correct']+s['wrong']):.1%}", dict(s))
PY
```

**This closes the retrieval line of enquiry for the current failures.** A chunker, a reranker or a
wider window can only convert questions whose gold is outside the window, and there are none. The
11 `MR` questions whose gold is fully carried and which are still wrong are counting failures over
evidence the reader was given, and nothing upstream of the prompt can repair them.

## 5. The two candidate repairs, read off the failures

### `KU`: the same attribute at several dates, and the reader takes the earlier one

Five of the eight `KU` failures are one shape -- a value stated in one session and changed in a
later one, where the arm answers the earlier value:

| question | gold | arm |
| --- | --- | --- |
| What day do I take a cocktail-making class? | Friday | Thursday |
| Where did I go on my most recent family trip? | Paris | Hawaii |
| How many eggs do we have stocked up? | 20 | 30 dozen |
| What time do I usually go to the gym? | 6:00 pm | 7:00 pm on Mondays, Wednesdays, and Fridays |
| How many Instagram followers do I have now? | 1300 | 1250 |

The `knowledge-update` block already states the rule (`Use the evidence with the latest date ...`),
and the dates are in the text -- every delivered turn opens with `[2023/06/16 (Fri) 13:26]`. What is
missing is not the instruction and not the date: it is that retrieval orders by relevance, so the
later statement can sit **behind** the earlier one, and a reader that reads the block in delivery
order hits the stale value first. 7 of the 8 carry part of their gold and 1 carries all of it, so
none of them is a miss.

The registered candidate is therefore a **date-ordered delivery on the `knowledge-update` route
alone**, with the same multisets: the turns are a permutation, nothing is added and nothing is
dropped, which is the property that makes a movement attributable to order. That is the same
mechanism `turn-clock.ts` already implements for the temporal window, so the change is a route
reach and not a new parser.

### `MR`: counting over a list the reader composes and cannot audit

The 21 `MR` failures are 20 counting answers, most of them one member out:

| question | gold | arm |
| --- | --- | --- |
| How many projects have I led or am currently leading? | 2 | 1 |
| How many different doctors did I visit? | 3 | 2 |
| How many weddings have I attended this year? | 3 | 5 |
| How many times did I bake something in the past two weeks? | 4 | 5 |
| How much money did I raise for charity in total? | $3,750 | $8,750 |

Six instruction variants have been measured on this population (`enumerated`, `sweep`,
`aggregation`, `silent`, `operands`, `candidates`) and none moved it past 88, which is why the
registered next step is not a seventh wording. The vendor's difference is structural: its prompt
carries `[thing N]` groups, so each counted item has a stable identifier the reader can audit
against, and the count is of identifiers rather than of recollections. `tools/mr-failure-census.mjs`
already partitions these failures into `decline` / `off-by-one` / `aggregation`, and the
`off-by-one` class is the one a stable identifier is supposed to repair.

## 6. The budget ladder

Recorded so a dispatch is a choice and not a habit:

| configuration | questions x runs | projection | what it answers |
| --- | --- | --- | --- |
| smoke | 60 x 1 | 0.43 CNY | does the code run at all |
| screening | 200 x 2 | **2.85 CNY** | did this change move the arm |
| half | 500 x 2 | 7.13 CNY | the same, without the small-sample band |
| full | 500 x 4 | **14.26 CNY** | the pre-registered point estimate |

`--budget` defaults to 3.00 CNY, which is the screening row. A full pass is one flag away and is
now a decision someone types rather than the value the table happens to carry.

## 7. What this round did not do

- **Did not narrow the thinking reach.** It is the largest single line and the saving is plausible;
  it is also unmeasured, and a projection that priced it would be the estimate this document is
  arguing against. It is the first screening run after the two repairs below.
- **Did not change `limit`'s default.** `INPUTS` is the adopted configuration and
  `test_preregistration_config.py` compares it against §10.3; the screening size is a dispatch flag
  (`--screening`) rather than a quiet change to the registered table.
- **Did not add a judge verdict cache.** It is 0.15 CNY of a 14.26 CNY run -- 1% -- and a disk cache
  buys a correctness question about staleness for a saving that does not show up in the total.
- **Did not touch retrieval.** §4 measures that no current failure has its gold outside the window,
  so a retrieval change would be aimed at a population that does not exist on this artifact.
