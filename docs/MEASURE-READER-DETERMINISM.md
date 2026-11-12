# The reader was never pinned, and that is what H5 was measuring

`MEASURE-COMPETITOR-READING.md` closed on a failure: the same control arm read twice on the same twenty
questions moved **13 → 11**, a per-question agreement of **80.0%** against `H5`'s 90% threshold, so no
ranking could be taken from a twenty-question pass. That file treated the movement as a property of the
arm. It was a property of the workflow.

## 1. The finding

`competitor-retrieval.yml` forwarded **no `TEMPERATURE`** to the harness. `createLlmFromEnv` reads the
field through `readTemperature`, which returns `null` when the variable is absent, and `null` reaches
`OpenAICompatibleLLM` as "send no sampling field at all". Every other workflow in this repository that
answers a question pins it:

| workflow | temperature | where |
| --- | --- | --- |
| `benchmark.yml` | `${{ github.event.inputs.temperature \|\| '0' }}` | step env |
| `benchmark-cortex-memory.yml` | `'0'` | step env |
| `restore-counterfactual.yml` | `'0'` | step env |
| **`competitor-retrieval.yml`** | **absent** | — |

So the product table (T2) was read at temperature 0 and every harness row (T1) at the provider's default.
That is two facts at once: the T1 numbers were not reproducible, and **T1 and T2 were never the same
reader**, which is the one thing §7.1 of `PLAN-COMPETITOR-HARNESS.md` claims they are.

Nothing in any artifact said so. The reader was named by an inline template literal,
`deepseek-chat (chain-of-note/con, one request)`, which is byte-identical for a run at 0 and a run at 1.0.
`comparability()` compares exactly that string, so it graded the two as the same experiment.

This is the third occurrence of one defect shape in this campaign, and `reader-temperature.ts` already
documents the first two: §13.114 (the workflow declared a temperature input that no code path read) and
§13.118 (the dispersion it cost, 16 questions on the roster from four repetitions of one configuration).
The third is the same defect one layer out — a *second* workflow that answers questions and was never
brought under the same rule.

## 2. The repair

Two changes, and the second is the general one.

**The dispatch pins it.** `competitor-retrieval.yml` gains a `temperature` input defaulting to `'0'`,
forwarded through the job environment so a fourth reading stage inherits it by existing rather than by
being remembered. The `default` sentinel stays reachable, because a run that means to sample should have
to say so.

**The name carries it.** The reader and judge identities move to `tools/reader-identity.mjs`: three pure
functions mapping `(model, mode, temperature)` to the string `comparability()` compares. The mapping is
the whole point — `temperature: null` renders `temp=default` and `temperature: 0` renders `temp=0`, so two
runs whose requests differed by a sampling field now fail comparability instead of passing it. A template
literal at a call site cannot be tested without a key and a dataset, which is why this one survived.

| artifact field | before | after |
| --- | --- | --- |
| `config.reader` | `deepseek-chat (chain-of-note/con, one request)` | `deepseek-chat (chain-of-note/con, temp=0, one request)` |
| `config.judge` | `deepseek-chat (official per-type templates)` | `deepseek-chat (official per-type templates, temp=0)` |
| unread stage | `none (retrieval only)` | `none (retrieval only)` |

## 3. The reading that closes it

Two dispatches, identical inputs, `sut` empty so the competitor's 50-minute ingest is not paid twice:

```
43197264759   questions=20 read_questions=20 read_arms=cortex-session
              read_prompts=con limit=10 temperature=0 sut=''
43198214714   identical
```

| run | reader identity | `cortex-session` | per-question agreement with the other |
| --- | --- | ---: | ---: |
| `43197264759` | `temp=0` | **13 / 20 = 65.0%** | — (artifact digest `e27e242f`) |
| `43198214714` | `temp=0` | **13 / 20 = 65.0%** | **20/20 = 100.0%** (same digest) |
| `43170314351` | `temp=default` | 13 / 20 | 16/20 = 80.0% |
| `43178388235` | `temp=default` | 11 / 20 | (the comparison above) |

**Zero flips — and the two artifacts are byte-identical.** Not "the same verdicts": the whole
`competitor-read.json` of the two runs has one sha256.

```
e27e242f8ac15dadc28091cbf575077f64fb4ed656e60e2bde3ceb2da9199cf5  43197264759
e27e242f8ac15dadc28091cbf575077f64fb4ed656e60e2bde3ceb2da9199cf5  43198214714
```

That covers the run's configuration, its 20 per-question records with the retrieved window and the
answer, and every verdict — so there is nothing left in the artifact that a second run could disagree
with and nothing this file had to select before comparing. `H5` requires 90%; the pinned instrument
returns 100% on twenty questions, and the two runs spent 3m07s and 4m42s of runner time respectively.

The comparison is a stronger statement than the gate it was written against, and that is worth being
explicit about: `H5` would have passed on 19 of 20 matching verdicts, which would have left room for one
undetected non-determinism in the answer text under a matching verdict. The digest leaves none.

The two `default` rows are the control for the mechanism: the same arm, the same questions, the same
judge, the same prompt, differing only in whether a sampling field was on the request — and it moved two
questions. §13.127 states the residual that survives pinning, measured on the product axis: **19 of 379
verdicts still move on byte-identical prompts (5.0%)**, because the judge's own verdict is a model call.
A 20-question arm carries 20 of those, so 1 flip is the expected floor and 4 was the unpinned rate.

## 4. What this invalidates

| claim | status |
| --- | --- |
| `mem0` **12/20 = 60.0%** against `cortex-session` **11/20 = 55.0%** (`43178388235`) | **withdrawn** — read at `temp=default`, and the control arm's own two readings differed by more than the inter-arm difference. Re-read under `43199357450` |
| "the first T1 row exists" | **stands as a plumbing fact, not as a number.** A competitor's own code answered our questions under our judge; what the answers scored is being re-read |
| "arm-internal noise is 2 questions at n = 20" | **falsified.** With the field pinned it is 0; the 2 questions were the sampler |
| "n = 20 cannot rank anyone" | **no longer established by H5.** It may still be true for power reasons, but the 90% agreement gate now passes, so the objection has to be made with an interval rather than with a failed gate |

The last row matters for the queue: it was the stated reason `C-sut-embed-cache` had to be sequenced
before n = 100. The reason survives (ingest is 55× the answering cost) but the *ordering constraint* from
`H5` does not.

## 5. Why this is the right round and not a detour

`PLAN-COMPETITOR-HARNESS.md` §7.1 lists the fixed half of the experiment as a table a script could check.
Every row of that table was checked except one — the reader's sampling field — and it was the one that
failed. A campaign that quotes a competitor comparison has to be able to say the two arms were the same
experiment; before this round, nothing in the artifact could.

The guard is the part that generalises. `test_sut_read_wiring.py` derives the reading stages from the
workflow rather than listing them, so a fourth prompt added tomorrow is covered the moment it exists; it
now asserts that each stage either inherits the job's temperature or declares the same expression, and
that no stage may shadow it. `test_reader_identity.py` runs the modules through node and asserts the
mapping, including that `null` and `0` never collapse. Both were verified the other way round: deleting
the environment key turns two assertions red.

## 6. Reproducing

```bash
python3 -m pytest tools/__tests__/test_reader_identity.py tools/__tests__/test_sut_read_wiring.py -q
# 20 passed

node -e "import('./tools/reader-identity.mjs').then(m =>
  console.log(m.describeReaderIdentity({ model: 'deepseek-chat', mode: 'con', temperature: 0 })))"
# deepseek-chat (chain-of-note/con, temp=0, one request)
```

Dispatch, from the workflow's own inputs:

```
questions=20 read_questions=20 read_arms=cortex-session read_prompts=con
limit=10 temperature=0 sut=''
```
