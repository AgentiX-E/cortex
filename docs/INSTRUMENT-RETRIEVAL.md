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
"expectedMoved": { "<question id>": "the section that moved it, and why" }
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
correct reading of a change like the room's floor (`§13.379`), where the configuration is identical.

Two verdicts exist besides the delta, and they are the ones that keep "no change" from being read as "no
effect": a report whose gold account is identical **and** whose delivery moved is reported as a different
delivery rather than as a null result, and an incomparable report fails. Neither says anything about
accuracy: the reader is a constant, so a candidate's table is a statement about which turns reached a
prompt, not about which answers were right.

### What a delivery is, and the clip that hid inside it

A row compares three things, and the third was added because the first two could not see the change that was
being measured:

| field | reads | blind to |
| --- | --- | --- |
| `carried` | how many of the question's **gold** turns were delivered | a delivered turn that is not gold |
| `deliveredDigest` | a hash over the delivered turn **texts** | text that is not a whole turn |
| `deliveredChars` | `promptChars`, the delivered evidence length | nothing about which turns |

The first two are whole-turn shaped, so a delivery that is a **clip of one turn** is `carried: 0` and the
digest of an empty list -- byte-identical to a run that delivered nothing at all. A candidate for the room's
floor was dispatched, printed `0 question(s) delivered different turn texts`, and that line was published as
a refutation of the repair before anyone checked what the gate compared (`§13.380`). It had compared the one
part of the delivery a clip cannot change. The same code, read by the third column, reports the repair on the
question it was written for:

```
b86304ba   deliveredChars 0 -> 23,503   carried 0 -> 0   (run 44239553110)
```

so the gate fails until the movement is declared, and the declaration is what makes the next run check it in
both directions. The character count is now in the reference (regenerated from the same `S14` artifact,
whose buckets are unchanged) and in both verdicts, and a candidate names the shape:

```
characters moved  : 1 question(s) delivered a different number of characters (1 of them clipped: turns and digest agree, length does not)
  CLIP b86304ba 0->1200
```

`CLIP` means the turn account stood still and the delivered length moved; `CHARS` means the delivery moved in
both. A calibration treats an undeclared move in either as a failure, and a declaration covers
`deliveredChars` too -- a declared clip has no other field to move, so a check that ignored it would fail a
correctly declared repair and teach the next person to delete the declaration.

### The prediction a candidate owes before it runs

A candidate now has to state **which axis of the delivery it intends to move**, and the flag is required
rather than optional:

```bash
python3 tools/lexical-recall-calibrate.py --report report.json \
  --candidate idf --expects-change turns,chars
```

| value | the statement |
| --- | --- |
| `turns` | the whole-turn account moves: `carried`, the delivered texts, or both |
| `chars` | the delivered length moves (`deliveredChars`) |
| `turns,chars` | both, and the delta is attributed to whichever the change names |
| `none` | the delivery stands still -- a testable hypothesis, not an absent flag |
| `any` | no prediction was made, and the log says so |

The prediction is a contract in both directions, exactly as `expectedMoved` is for the reference:

1. **A movement the candidate did not name fails the run.** It has a cause the candidate did not name,
   and a delta with an unnamed cause is not a measurement of the mechanism on the label.
2. **A predicted movement that did not happen fails the run.** The mechanism either did not run or
   changed nothing; §13.380 published the first case as "the branch never fires" and this is the check
   that would have refused that sentence on the spot.

`none` and `any` are different values on purpose. `none` is a prediction that can be refuted -- the
room's floor is refuted by it in one run -- and `any` is the honest statement that an exploratory run
has not named an axis, printed as `none (any axis may move, so this delta is attributed by hand)` so a
later reader cannot mistake it for a prediction that held.

The first real reading under this rule is the `idf` candidate itself. Declared as `--expects-change
turns` it **fails**:

```
predicts         : turns
observed         : turns,chars
  FAIL the delivery moved chars and the candidate declared turns: chars is not in the prediction, so this
       delta has a cause the candidate did not name.
```

Which is the correct verdict and a fact about the mechanism: re-pricing terms reorders turns, so the
delivered length moves on 235 questions without anyone intending it. The declaration that fits is
`turns,chars`, and the value of the flag is that the log now says which of the two axes a candidate
meant before its numbers are read.

### The account is per capability too, because a criterion can be about a subset

`capability` was carried in every reference row and never read. It is now summed into one line, because
`PREREGISTRATION-LEXICAL-RECALL.md` registers a criterion on the thirty abstention questions and a
whole-corpus total cannot answer it:

```
by capability    : ABS 128->157 (up 29) | IE 589->686 (up 97) | KU 532->596 (up 64) | MR 1616->1616 | TR 1434->1434
```

That line is the most consequential thing the `idf` candidate printed, and it is the shape a whole-corpus
total hides: **+190 gold turns overall, +29 of them on the abstention questions**. For the other four
capabilities a delivered gold turn is the goal; for `ABS` the goal is to refuse, and the evidence that
makes a reader answer is the evidence that costs accuracy there. A summary that says "more gold turns"
about the whole roster reads as an improvement on a subset where the sign is inverted underneath it.

### A subset criterion is a subtraction, so the tool performs it

A criterion of the form "no more questions got worse than got better" is not a bar on conversions and
not a statement about the questions the control answers every time — it is a **net over one subset**.
`arm-verdict.mjs --bar` therefore takes a third clause, `net=<integer>`, evaluated as
`questions up - questions down >= net`:

```
node tools/arm-verdict.mjs --control s16-flat.json --arm idf.json --capability ABS \
  --bar conversions=0,falsifier=4,net=0
```

Three decisions are inside that clause and each has a reason:

- **Questions, not cells.** The criterion is about what a reader does with a question, and the two
  aggregates can point in opposite directions: one question gaining four repetitions and two losing
  one each is `+2` cells and `-1` questions. A test holds that pair to both readings
  (`counts questions rather than cells, and the two can point in opposite directions`).
- **Equality holds.** `net=0` passes a tie, because the registered criterion is `d_worse ≤ d_better`
  and not `<`. A clause stricter than the registration is the same defect as a looser one.
- **Not asked is not met.** Without the clause the result is `null`, not `true`, so a two-clause bar
  prints exactly the line it printed before this existed — the record of an older verdict is not
  rewritten by an instrument that grew a field.

The counts the clause is computed from are printed with it (`net up 5 - down 5 = 0 met=true`),
because a reader checking a subtraction the tool already did is a reader who will eventually do it
wrong; and `questions up/down` is now printed on its own line for the same reason a p-value alone is
not enough — five against five and one against one share a p-value of 1.

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
