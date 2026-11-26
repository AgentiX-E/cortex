# The specification grammar reaches five of twelve, and reading the plans says three of them are accidents

**Status:** closed. Measured on `45754372668` (twelve questions, both vocabularies, zero model calls).
The dispatch `docs/PREREG-SPEC-CEILING-ADOPTED.md` priced is **not bought**: `reviewPass: 'spec'` is
closed as a direction rather than priced out.

## 0. In one paragraph

Three readings produced this verdict and only the third is the measurement: `45748211939` died on a
path, `45750764632` died on a type, and `45752498631` returned a ceiling with three of twelve
questions missing from its own denominator. `45754372668` is the first run whose numbers are all
present. It says the question vocabulary reaches **5 of the 11** questions the pass would run on,
against a bar of ten, and that **two of the five** hits are accidents — `sum("mak", "cup") → 1` for a
gold of four properties, `sum("free", "pro") → 100` for a gold of 100 points. The history vocabulary
reaches 10 of 11 and **every plan it reaches them with is a fragment**: `count("1920")`,
`sum("1603-1868", "hours")`, `count("000-")`, `sum("10m28s-20m4s", "%")`. A grammar whose only
predicate is `text contains` cannot name the set the gold counts, and a ceiling of ten made of
fragments is noise wearing the shape of a number.

## 1. The two readings

| | question vocabulary | history vocabulary |
| --- | --- | --- |
| questions with a numeric gold | 12 | 12 |
| copy ceiling (a row states the gold) | 10 | 10 |
| **grammar ceiling** | **5** | **10** |
| questions the pass would run on (`isTallyQuestion`) | 11 | 11 |
| **grammar, gated** | **5 / 11** | **10 / 11** |
| median plan share, gated | 0.00% | 0.08% |
| plans searched, per question | 207 – 616 | 12,561 – 23,000 |

The registration's bar is `grammarOfEligible >= 10` of 12, and it is judged on the **question**
vocabulary, because that is the vocabulary a specifier could reason from: a reader writing a plan sees
the question and the ledger's vocabulary, not every word the history ever used. On that reading the
ceiling is 5, which is below the six the paired floor certifies even at a hundred percent conversion.

## 2. The plans, read one by one — the criterion that decides this

`docs/PREREG-SPEC-CEILING-ADOPTED.md` 3 registered C2 before the run: a hit is only a hit if a reader
could plausibly have intended the plan, and coincidences are subtracted before C1 is judged. This is
the table that subtraction is performed on.

### Question vocabulary — 5 hits, 2 of them a reader could have written

| id | gold | plan | verdict |
| --- | --- | --- | --- |
| `gpt4_15e38248` | 4 | `count("pieces") → 4` | **plausible**: "pieces" is the unit the question's own inventory is counted in |
| `bf659f65` | 3 | `count("purchased") → 3` | **plausible**: the question asks what was bought, and the plan filters on the verb |
| `3a704032` | 3 | `sum("plants", "part") → 3` | doubt: `part` is a unit the ledger attached to a phrase, not a quantity the question names |
| `gpt4_7fce9456` | 4 | `sum("mak", "cup") → 1` | **accident**: two fragments of unrelated words sum to 1 |
| `9ee3ecd6` | 100 | `sum("free", "pro") → 100` | **accident**: the gold is 100 points and the plan adds something the question never mentions |

### History vocabulary — 10 hits, none of them a reader could have written

| id | gold | plan | verdict |
| --- | --- | --- | --- |
| `gpt4_15e38248` | 4 | `count("1920") → 4` | accident: a year |
| `gpt4_a56e767c` | 4 | `sum("1603-1868", "hours") → 4` | accident: an era and a duration |
| `bf659f65` | 3 | `sum("15-30", "mm") → 3` | accident: a range and a dimension |
| `gpt4_31ff4165` | 4 | `sum("3-year", "stars") → 4` | accident |
| `3a704032` | 3 | `sum("--stylize", "test") → 3` | accident |
| `gpt4_ab202e7f` | 5 | `sum("12-cup", "large") → 5` | accident |
| `gpt4_7fce9456` | 4 | `count("000-") → 1` | accident |
| `gpt4_2f8be40d` | 3 | `count("18th") → 3` | accident |
| `9ee3ecd6` | 100 | `sum("10m28s-20m4s", "%") → 100` | accident |
| `a1cc6108` | 11 | `count("aim") → 11` | accident, and the question is a derivation the pass never runs on |

**`g_semantic` is 2, at most 3.** The bar is 10. The gap is not a matter of degree.

The history column is the more useful of the two even though it is not the criterion: it shows what a
ceiling of 10 out of 11 *means* when the grammar is `text contains`. Ten of eleven questions are
reachable by a string match on some fragment of the history, which is another way of saying the
ceiling measure of a `contains` grammar over a long history approaches the population size as the
vocabulary grows. A number that rises with the search budget is not a property of the mechanism.

## 3. What the two failures before this one changed

| run | failure | what it taught |
| --- | --- | --- |
| `45748211939` | `ENOENT: tools/spec-ceiling-population.json` | a relative path resolves against the package directory, because `pnpm --filter` runs the script there |
| `45750764632` | `gold.matchAll is not a function` | the corpus states a count question's gold as a number, and the type said `string` |
| `45752498631` | denominator of 9 where the population is 12 | three golds are **spelled out** (`I attended four movie festivals`) and the parser read only digits |
| `45754372668` | — | the reading above |

All three are repaired and each has a test that fails without the repair: the process-level test that
runs the command from the package directory, the synthetic corpus whose two answers are a number and a
string, and the wordlist case. The third one is worth naming as a class: the audit transcribed three
golds as digits because a table reads better that way, the corpus spells them, and a ceiling computed
over nine questions would have been reported as a ceiling over twelve.

## 4. The verdict, and what it does not close

`reviewPass: 'spec'` is **closed**. Not deferred, not priced out: the third row of the registration's
outcome table — *"the grammar cannot reach the floor even at 100% conversion"* — with the evidence
above rather than an inference from a count.

What remains is not a wider grammar. `AUDIT-NUMERIC-MEMBERSHIP.md` 1 reads all twelve replies and
finds **ten of them decided before any arithmetic**: six dropped a member the gold keeps, four kept
one the gold drops. A plan language whose predicates are `text contains` and `unit-is` cannot express
"these two rows are one object" or "an amount the event raised is not an amount the user raised".
Those are adjudications over identity, and the next increment is that adjudicator — with a ceiling of
10 of 121 = 8.26 points against a floor of 4.96, i.e. six of ten conversions, which is the only
remaining target whose population is larger than its floor.

Two of the twelve (`gpt4_731e37d7`, `d851d5ba`) are unreachable by **both** vocabularies and are not a
grammar problem: one is a period bound the axis has already spent (`PREREG-CLOCK-AXIS.md`), and one is
an attribution error the executor faithfully reproduces. They are recorded as outside the next
increment rather than folded into it.

## 5. Cost

| item | cost |
| --- | --- |
| four dispatches of this workflow | runner minutes, **¥0** |
| model calls | **0** |
| the `spec` dispatch this measurement existed to price | **not bought** |

The measurement cost four dispatches instead of one because three of them found defects — a path, a
type, and a denominator — and each of those would have cost a paid run to discover after the fact.
That is the argument for measuring offline first, made at the price it actually costs.

## 6. Where the numbers live

- Readings: `tools/readings/spec-ceiling-adopted-{question,history}.json` and the two `.log` files
  beside them, archived from run `45754372668`'s artifact.
- Corpus digest: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Population: `tools/spec-ceiling-population.json`, unchanged since it was frozen — the result lives
  here and not in the population file, because a registered population that carries its own reading is
  a population that can be edited to match it.
- Criteria: `docs/PREREG-SPEC-CEILING-ADOPTED.md` 3.
- Predecessor: `docs/MEASURE-SPEC-CEILING.md`, which measured the control arm's failing set and is
  superseded for the adopted arm by this note.
