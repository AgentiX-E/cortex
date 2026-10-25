# MEASURE — Session Selection, and the Reading It Took to Find a Defect

## 0. One paragraph

The synthetic competition table read `recall@k 91.7%` and `all-gold 8.3%` for Cortex's own adapter. That gap
says the store held the evidence and the selection did not spend the budget on it. This document traces the
gap to its cause — a ranking key that is **constant** in the shipped configuration, so "highest-value session
first" was "first session first" — states the repair, and reports the movement: `all-gold` 8.3% → 100%,
`mrr` 0.296 → 1.000. It then argues that the new reading is **not** a SOTA claim, because the corpus that
produced it cannot separate two lexical systems for any reason other than their stopword lists.

## 1. What was measured

`node tools/competitor-harness.mjs`, synthetic set, 40 questions / 24 measurable, `k=10`, isolated ingest, no
reader, no judge, gold derived as "the context turns that state the expected answer".

| provider | build | recall@k | all-gold | mrr | found |
| --- | --- | --- | --- | --- | --- |
| `lexical-reference` | none | 100.0% | 100.0% | 0.630 | 24/24 |
| `cortex-session` | *embedding* | 91.7% | 8.3% | 0.296 | 22/24 |
| `cortex-session` (budget 8) | *embedding* | 87.5% | 4.2% | 0.291 | 21/24 |
| `null-floor` | none | 0.0% | 0.0% | 0.000 | 0/24 |

Two things in that table were wrong before the numbers were. `build` claimed `embedding` for a ranking that
used no model at all. And the adapter's own docstring said the session budget "ranks sessions by their best
turn's value, which is a function of recency and length".

## 2. The diagnosis, by measurement

`bestValue(session)` is `max(turn.value)`, and `turn.value` is `confidence * sourceTrust * (0.5 + 0.5 *
recency)`. Admission stamps `lastAccessedAt = createdAt = now`, so `recency = exp(0) = 1` for **every** turn of
one admission. With `sourceTrust` at its default `0.5` and no `confidenceFor`, the product is

```
value = 1 * 0.5 * (0.5 + 0.5 * 1) = 0.5
```

for every turn. A probe over one real question from the synthetic set:

```
admitted turns: 24
distinct values: [ 0.5 ]
bestValue: 0.5
```

So `bestValue` ties across all 24 sessions, the sort falls through to its tie-break `a.session.index -
b.session.index`, and the budget is spent in **arrival order**. Recency does not enter the ranking (it is
constant), and length enters only as the capacity check `used + size > budget`, never as an ordering.

**The previous round's sentence was therefore false.** It described a recency-and-length ranking that does not
exist. The number was right and the explanation was invented, which is the more dangerous of the two: a wrong
number gets re-measured, a wrong mechanism gets built on.

## 3. The repair, in three parts

### 3.1 A signal that reads the question — `cortex-memory/src/relevance.ts`

`lexicalRelevance(question, turn) → [0, 1]`: term coverage (`0.85`) plus adjacent-pair order (`0.15`). Both
terms are stated with the reading they support, and the weights are a decision rather than a fit, because a fit
would need a tuning corpus and a corpus is exactly what the signal must not encode.

`confidence.ts` records why this could not be `confidenceFor`: that callback is `(turn) => number`, with no
question in scope, and reaching outside its own interface would have made the mechanism unverified even if the
number moved. The question enters instead at the **session budget**, where ranking by session already happens
and the question is already a parameter of the enclosing call — so nothing closes over anything.

### 3.2 A ranking key, explicit rather than captured — `sessionize.ts`

`selectSessionBudget(sessions, budget, relevance?)` gains a third key: relevance descends first, `bestValue`
descends second, `session.index` ascends last. Three keys for three distinct claims — what was asked, what the
gate valued, what arrived first — and no weighted sum, because a sum would need a coefficient nobody measured.

When `relevance` is absent the first key is `bestValue`, so the two-key behaviour is byte-for-byte the one every
archived artifact was produced under. A `NaN` is rejected rather than tolerated: every comparison against it is
false, the sort keeps its input order, and the selection silently reverts to the arrival-order defect this
parameter exists to repair — while the artifact reports that a signal was in use.

### 3.3 Hits in ranked order — `provider.ts`

The product re-sorts selected sessions into arrival order before writing a prompt, because a prompt that lists a
later session first makes relative-time questions unanswerable. A **retrieval** interface is read for rank: the
harness computes MRR from the position of the first hit. Presenting chronologically there reported a rank the
selection never assigned, which is why `mrr` sat at 0.296 while the correct session was often present.

## 4. The reading after the repair

| provider | build | recall@k | all-gold | mrr | found |
| --- | --- | --- | --- | --- | --- |
| `lexical-reference` | none | 100.0% | 100.0% | 0.630 | 24/24 |
| `cortex-session` | **none** | 100.0% | **100.0%** | **1.000** | 24/24 |
| `cortex-session` (budget 8) | **none** | 100.0% | 50.0% | 1.000 | 24/24 |
| `null-floor` | none | 0.0% | 0.0% | 0.000 | 0/24 |

`all-gold` at budget 8 is 50% and that is arithmetic, not a defect: the budget is spent in turns, each synthetic
session is one turn, so 8 of 24 sessions fit, and a question whose gold spans 3–4 same-attribute turns cannot be
fully covered. The unbounded row is the recall ceiling of the selection; the bounded row is what a reader with a
tight prompt would see.

## 5. Why this is not a SOTA claim

The synthetic generator writes each fact as `name attribute=value`:

```
question:  What is alice's city?
gold turn: alice city=new york
```

The question's two content terms appear verbatim and adjacently in the gold turn, so any term-overlap signal
scores it `1.0` **by construction**. `mrr 1.000` means the gold always ranks first, and there is no corpus left
in which it could rank otherwise.

The remaining gap to `lexical-reference` (0.630) is also not quality: that provider tokenises to words of three
characters or more with no stopword list, so `what` enters its denominator and every score is diluted. Two
lexical systems differing in a stopword list is not a result about memory.

What the table can support:

1. the signal is **wired** — selection and ordering both read the query, and a test fails if either stops;
2. the adapter **equals the product functions applied by hand**, including the relevance key;
3. the defect is **gone**, with five tests that go red when the key is removed (verified by removing it).

What it cannot support: any statement about accuracy on real language, and any comparison with a competent
system. That needs a corpus from outside this repository.

## 6. Limitations, stated as limitations

| limitation | effect | why it is not fixed here |
| --- | --- | --- |
| no stemming | `move` does not match `moved`, so tense-disagreeing evidence scores `0` | a stemmer changes every number this signal produces; it is an A/B, not an edit |
| no IDF | two questions each matching one of three terms in different sessions score identically, and `session.index` decides | requires corpus statistics, which makes the signal stateful and no longer a pure function of two strings |
| coverage normalised on the question | a long turn mentioning everything out-scores a short turn stating the answer, which the order term only partly offsets | a length prior would be a second unmeasured weight |
| English-only tokenisation | `[^a-z0-9]` splitting drops non-Latin scripts entirely | LongMemEval is English; a multilingual tokeniser is a separate registration |

Each of these is asserted in `__tests__/relevance.test.ts` or `__tests__/provider.test.ts` rather than left to be
rediscovered. A limitation with a test is a known boundary; a limitation with a comment is a rumour.

## 7. What this changes for the plan

The `P0` item "extract the relevance ordering from `buildSessionPrompt` into a pure function the adapter and the
prompt share" is **done, in a different shape than planned**. The plan expected the ordering to be pulled out of
`buildSessionPrompt`; it turned out `buildSessionPrompt` already takes `relevanceFor` as an injected signal and
had no ordering of its own to extract. The missing step was never inside the prompt builder — it was that
**nothing supplied a signal to the session budget**, which is a different module and a different question.

That is worth recording as a planning lesson: the item was written from a symptom (`all-gold` low) and a guess
about the module, and the guess was wrong. The measurement was right both times.

The next item is unchanged and now unambiguous: put `cortex-session` on a corpus this repository does not
generate. `docs/PLAN-COMPETITOR-HARNESS.md` H1.
