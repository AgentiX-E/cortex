# Measuring false-share: every publication, read

```bash
# 1. rebuild the corpus from artifacts the project already published
python3 tools/extract-user-turns.py \
  --glob '/workspace/run-*/longmemeval-s-report/benchmark-cortex-memory-ablation-report.json' \
  --out /tmp/turns.json

# 2. run the gate — the exit code is the criterion
node tools/triage-publish-census.mjs --corpus /tmp/turns.json \
  --verdicts tools/triage-publications-adjudicated.json
```

## The number

|                   |         publications | errors | false-share | Wilson 95% upper |
| ----------------- | -------------------: | -----: | ----------: | ---------------: |
| before the repair | 211 / 47,927 (0.44%) |     20 |       9.48% |       **14.19%** |
| **after**         | 189 / 47,927 (0.39%) |  **0** |       0.00% |        **1.99%** |

## Why this instrument, and not the corpus under it

The gate asks for a ≤5% bound on false-share, and for two years of this document set nobody had a
denominator that could carry one:

| corpus                      | reading                   | why it cannot bound a rate                                                  |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| 60 hand-labelled utterances | 0/12, upper 24.2%         | twelve private rows; one in four is compatible with zero                    |
| 1,467 persona facts         | 0/1,467, **NOT MEASURED** | the publishing rule never fired — a bound over a mechanism that did not run |
| 3,000 identifier rows       | leak 1/3,000              | the denominator is _facts_, not _publications_, and the rule fired once     |

A publication is the only route by which anything leaves the device, so the rate that matters is
conditional on publishing. The corpus that can pay for it was already on disk: 363,191 turns across
six benchmark artifacts, **47,927 distinct user utterances** after keeping the user's side only and
deduplicating exact text. That is the distribution in which "sprint", "the board", "the project",
"we decided" and "our team" occur in all their senses — including the ones nobody writes down when
they write a test.

## The 20 errors, and what the repair was allowed to be

| class         |   n | example                                               | missed                                                                                                 |
| ------------- | --: | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| health        |  15 | "I'm training for a sprint triathlon on November 1st" | `sprint` matched as a software cadence; exercise is a private class with no sport vocabulary behind it |
| third-party   |   3 | "…a gift card to Starbucks for our team lead, Rachel" | `team lead` absent from the role list; `our` not a determiner                                          |
| family        |   1 | "…a little jam session with my siblings"              | `siblings` absent                                                                                      |
| career-status |   1 | "…explore more about my career growth"                | the rule knew only _changes_ of employment, not progression                                            |

Two properties keep this from being steered. Every verdict carries a **policy class**, so a
disagreement is an argument about the policy. And the repair may only **add private rules** — which
can move a row out of the publishing set, never into it. Loosening the publishing rule would have made
the number worthless.

The price was first read as a coverage *gain*: 60-row coverage **31.7% → 33.3%**, persona coverage
**29.2% → 30.0%**. It was not. The one extra row was a supplier's sentence about "a climbing or
bouldering gym needs", labelled shared, caught by the `gym` the repair had just added; `bike` was the
same defect (nouns and purchases — "bike trails", "bike shops", "I spent 300 dollars on a bike"). Both
are removed, and the readings are **19/60 = 31.7%** and **29.5% (27.2–31.9)** — the values they had
before the census.

| reading                    | with `gym`/`bike` | removed | delta |
| -------------------------- | ----------------: | ------: | ----: |
| 60-row coverage            |  20 (33.3%)       | **19 (31.7%)** |  −1 |
| persona coverage           |  30.0%            | **29.5%**      | −0.5 pp |
| publications over 47,927   |  189              | **189**        | **0** |
| false-share upper bound    |  1.99%            | **1.99%**      | 0 |

So this census bought no coverage at all; it bought the denominator. A coverage number that rises when
a rule starts calling a supplier's business a health fact is not a metric, which is why the assertion
in `triage-rules.test.ts` sits beside private recall, false-share and false-private rather than alone.

## What it does not say

- **Not a second reader.** One reader, one pass, sentence plus policy. Every row is committed; a
  second reader would _replace_ this rate, not confirm it. Inter-annotator agreement is unmeasured.
- **Not workplace email.** Personal-assistant conversation, not a random sample of an office.
- **Not every private thing.** Four published rows carry something personal the policy names no class
  for (legal matter, building project, immigration status, motivation). They are recorded as shared
  with that reason. They are the boundary of the number, not a part of it, and naming a new class
  would raise the rate rather than lower it.

## The A4 ablation, on a corpus that has deferrals

`defer` landing shared instead of private is one predicate. On the 60 labelled rows it now moves
nothing — the rules decide all twelve private rows — so `p05` asserts that precondition rather than
requiring a leak. On the corpus it does move something:

```bash
node tools/triage-publish-census.mjs --corpus /tmp/turns.json --defer-shared
# published             40822 of 47927 (85.18%)
```

| policy                    | publications |  share |
| ------------------------- | -----------: | -----: |
| shipped                   |          189 | 0.39% |
| `defer` → shared (A4)     |   **40,822** | **85.18%** |

216× as many rows leave the device, from one predicate. The tool prints no rate for the ablation and
exits 0 by construction: most of those 40,822 rows have never been read, and a rate over an unread
denominator is exactly what this instrument refuses to publish. Read the count, not the ratio.

## The gate is the exit code

`tools/triage-publish-census.mjs` returns 0 only when the upper bound is ≤5% **and** every
publication has been read. It returns 1 when a rate is too high, and it returns 1 with
`NOT MEASURED` when any publication is unread — because a bound over rows nobody read is not a
bound, which is the lesson the persona corpus taught and this tool now enforces.
