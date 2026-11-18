# Measuring retrieval without a model

A retrieval change -- a different `k1`, a stemmer, a field weight, a phrase window -- moves *which
turns reach the prompt*. That is a property of deterministic code over a deterministic corpus, so it
can be measured without a reader, a judge or an embedding provider, and it costs nothing to measure.

This document describes the instrument that does it, how to run it, and what it refuses to be read
as.

## Why the cheap measurement is the product's own path

The obvious economy is a second implementation: rebuild the index in a script, rank, cut to the room,
count the gold turns that survived. It is also the wrong one. The delivered evidence is what
`CortexMemory` **handed** the reader -- `lastRetrievedContext()` -- and a parallel implementation
would measure the drift between itself and the product before it measured anything else. The first
number such a tool produces is "how different am I from `CortexMemory`", and every number after it
inherits that error.

So the instrument is the product with one component replaced:

| component | instrument | why |
| --- | --- | --- |
| retrieval, fusion, room, truncation, rendering | the shipped code | the thing under test |
| reader | a constant (`"offline instrument"`) | it costs money and contributes nothing to retrieval |
| judge | a constant (`incorrect`) | same, and a constant `correct` would make every accuracy 100% |

Everything else -- the arm's option parser, the room table, the turn caps, the role filters, the
route dispatch -- is the same code the benchmark runs. The configuration is therefore not
*reproduced*, it is *the same*, which is the property that makes the reading comparable with an
archived run.

## Running it

```bash
CORTEX_ARM_OFFLINE=1 \
CORTEX_MEMORY=1 \
CORTEX_MEMORY_RELEVANCE=self-index \
CORTEX_MEMORY_INDEX_EMBEDDING=none \
LONGMEMEVAL_PATH=data/longmemeval_s_cleaned.json \
pnpm --filter @agentix-e/cortex-memory bench
```

`.github/workflows/lexical-recall.yml` is the same invocation with the registered `S14`
configuration transcribed into it, and it is dispatch-only: it exists to answer one question per
round, not to gate a commit.

The run writes `offline-instrument.json` beside the report. That file is the run's own statement of
what it was, and reading a result without it is reading a constant's accuracy as a measurement.

## What it measures

| field | meaning |
| --- | --- |
| `questions[].goldOverlap` | per gold turn, whether it reached the final prompt (`goldDelivered`), plus `carried` / `total` |
| `questions[].turns` | the delivered turns, in delivery order -- the evidence itself, not a count of it |
| `questions[].evidenceChars`, `deliveredPromptChars` | the room the corpus occupied and the room the prompt spent |
| `memoryArmConfig.selfIndex` | indexes built, terms, turns: the record that the index ran |

## What it refuses to be read as

Accuracy, per-capability accuracy, the paired delta and the cost per question are all properties of
two constants in an offline run. `tools/lexical-recall-calibrate.py` refuses to compare a report that
has no `offline-instrument.json` beside it, and the Arm's artifact reader
(`tools/readout-arm-run.py`) is written against the real benchmark's artifacts.

## The calibration gate

A cheap measurement is worth nothing unless it is the *same* measurement, and "the same" is not a
property the code can be read for. `tools/lexical-recall-calibrate.py` compares a fresh instrument
report against `tools/lexical-recall-reference.json` -- the per-question gold account of the archived
`S14` run `43829744532` -- on three fields that fail differently:

| field | what a mismatch means |
| --- | --- |
| `total` | the two runs read different instances under one id: a dataset fault, not a scoring one |
| `carried` | the delivered set differs, so every candidate priced afterwards is priced against another baseline |
| `deliveredDigest` | the counts agree and the turns do not: another corpus slice, another room, or a rendering that moved |

The gate has already earned its keep. A dispatch that omitted `CORTEX_MEMORY_MAX_PROMPT_CHARS`
assembled prompts under the product's default room -- 48,000 characters on every route -- where the
archived run used a table (24,000 on `flat`, 48,460 on `multi-session`, 48,000 on `temporal`). The
instrument then delivered 44,838 characters on a question the archived run delivered 21,850 for,
carried more gold turns on 134 questions, and read a **lower** zero-recall count (11 against 21).
Without the gate that looks like a 10-question improvement in lexical recall; with it, the reading
is what it was -- a different configuration. Note that `maxPromptChars=default` in the run's log is
not evidence of agreement: it names the absence of the *scalar*, and the archived table arrived
through the same variable in its per-route shape.

The reference is regenerable rather than hand-maintained:

```bash
python3 tools/lexical-recall-calibrate.py \
  --report artifact.json --write-reference --row S14 --run <run-id>
```

Diffing the regenerated file against the committed one is the check that the reference still describes
the run it names.

A repair to the product can move a delivery the reference recorded, and the reference may **not** be
rewritten to agree with new code — it is a record of a dispatched run. The middle term is a declaration:

```json
"expectedMoved": { "b86304ba": "the room's floor (§13.379.3): the room now buys the best turn clipped" }
```

The gate checks it in both directions. An undeclared movement fails, and so does a declared one that
stopped happening — a gate that outlives its cause is no longer checking it. The declaration cannot cover
`total`, because the gold annotation is the dataset's rather than any product change's. Regenerating the
reference keeps the block, since the artifact being read knows nothing about why the code now differs.

## Reading a candidate rather than a calibration

The gate above asks one question -- *is this the same path?* -- and a candidate asks the opposite one: *what
did changing this move?* Both are asked of the same artifact, and answering them with one mode would either
refuse every candidate or accept every drift, so `--candidate <label>` switches the verdict:

```bash
# The gate: exits nonzero when the account disagrees on one question.
python3 tools/lexical-recall-calibrate.py --report report.json

# A candidate: reports the delta, names the configuration fields that moved, and never prints the
# gate's equality verdict.
python3 tools/lexical-recall-calibrate.py --report report.json --candidate idf
```

A candidate still has to be **comparable**, and the two ways of being incomparable are checked exactly as
they are in the gate: another corpus fingerprint, or another roster. What it adds is attribution. The
reference records the run's whole configuration (its censuses excluded, because those are counts taken after
the questions were answered), so a candidate prints every field it changed:

```
configuration    : 2 field(s) changed
  lexicalWeighting: "flat" -> "idf"
  maxTurnChars: "<absent>" -> 400
```

A candidate that moved two settings is not a candidate for either mechanism, and the run's own log is the
only place that can be visible before someone attributes the delta to the wrong one. When nothing moved, the
tool says so -- `unchanged -- this candidate's difference is in code, not in a setting` -- which is the
correct reading of a change like the room's floor (`§13.379`), where the configuration is identical and the
delivery is not.

Two verdicts exist besides the delta, and they are the ones that keep "no change" from being read as "no
effect": a report whose gold account is identical **and** whose delivered texts moved is reported as a
different delivery rather than as a null result, and an incomparable report fails. Neither says anything
about accuracy: the reader is a constant, so a candidate's table is a statement about which turns reached a
prompt, not about which answers were right.

## What the product must do for this to hold

Two properties of `CortexMemory`, both pinned in
`packages/cortex-memory/src/__tests__/offline-instrument-neutrality.test.ts`:

1. **The delivered evidence does not depend on the reply.** Two different replies over one corpus
   produce byte-identical `lastRetrievedContext()`. Retrieval is decided before the reader is called,
   and no mechanism may rebuild the window from what the reply said.
2. **The instrument's own reply trips nothing.** It parses as an answer rather than a decline, so
   `reviewBareDecline` and `reviewPass: 'recover'` do not spend a second call on five hundred
   questions.

The dispatched run asserts the third version of the same property on the artifact:
`assertOfflineInstrumentReached` requires exactly one index per question per run, and refuses the
report otherwise -- a second index means some mechanism re-retrieved, and the delivered evidence
would be that mechanism's.
