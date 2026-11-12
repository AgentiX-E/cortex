# The first row where a competitor answers our questions under our reader

Every "gap" this campaign has quoted was a difference between two **harnesses**: our arm's 91.25% against a
vendor's self-report produced by a different reader, a different judge and a different prompt. `PLAN-COMPETITOR-HARNESS.md`
§7 replaced that with the only arrangement that measures anything — fix the instrument, vary whose memory answers.

This file is the first reading from that arrangement. It cost two dispatches and about ninety minutes of runner
time, and it produced three results, of which **only one is decidable**:

1. **The T1 table has a row.** `mem0` 2.2.1 ran its own code on our 20 questions, our `con` reader, our judge, and
   `k = 10`, and answered **12 of 20**. The control arm answered 11.
2. **The accuracy difference is not decidable and must not be quoted.** The control arm moved **two questions
   between two identical runs**, which is twice the inter-arm difference.
3. **The cost difference is decidable and large.** 1,768 prompt tokens per question against 33,556: **19.0×**.

## 0. What ran

| | run A `43170314351` | run B `43178388235` |
| --- | --- | --- |
| questions | 20 (round-robin, `id`-sorted within capability) | same 20 |
| `sut` | `mem0`, `sut_infer=0` | same |
| read arms | `mem0,cortex-session` **→ mem0 absent** | `mem0,cortex-session` |
| read prompts | `con` | `con` |
| reader | `deepseek-chat` (Chain-of-Note, one request) | same |
| judge | `deepseek-chat`, `longmemeval-official-per-type` | same |
| `k` / scoring | 10 / `single` | same |
| dataset | LongMemEval-S cleaned | same |
| mem0 ingest | 972/972 sessions, 0 refused | 972/972, 0 refused |
| mem0 manifest | `2.2.1`, `build=embedding`, `infer=false`, `faiss`, `embedding-3` @1024d | same |

Run A did not read `mem0` at all: the reading stage is a second invocation and it never launched the competitor,
so `--read-arms mem0` matched nothing and the run finished green with the only A-grade arm absent from the table
it exists to fill. That is fixed in `.github/workflows/competitor-retrieval.yml` and pinned by
`tools/__tests__/test_sut_read_wiring.py` (§4).

## 1. The table (run B, `43178388235`)

| provider | build | recall@k | all-gold | MRR | **accuracy** | ~tok/question |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `cortex-session` | none | 85.0% | **80.0%** | 0.792 | **11/20 = 55.0%** | 33,556 |
| **`mem0` 2.2.1** | embedding | **100.0%** | 0.0% | **0.908** | **12/20 = 60.0%** | **1,768** |

Per capability, accuracy:

| capability | `cortex-session` | `mem0` |
| --- | ---: | ---: |
| `ABS` | 3/4 | 3/4 |
| `IE` | 1/4 | **2/4** |
| `KU` | 3/4 | **4/4** |
| `MR` | **3/4** | 2/4 |
| `TR` | 1/4 | 1/4 |

Both arms are read by one function with one prompt, so the only difference between the two rows is whose memory
produced the text. `TR` at 1/4 in both is the `con` prompt's known omission (no date, no arithmetic), not a
finding about either system.

## 2. The pairing, which is the evidence and the totals are not

| | `mem0` wrong | `mem0` right |
| --- | ---: | ---: |
| **`cortex-session` wrong** | 7 | **2** (`031748ae`, `07b6f563`) |
| **`cortex-session` right** | **1** (`00ca467f`) | 10 |

Two discordant pairs one way, one the other, ten ties: exact McNemar **p = 1.0**. The one-question net is
`2 − 1`, and three discordant questions out of twenty is a coin flip with a small sample, not a ranking.

`031748ae` is a `KU` question and `07b6f563` is `IE` — the two capabilities where `mem0`'s extraction is
supposed to help — and `00ca467f` is `MR`, where returning whole sessions instead of extracted facts is supposed
to help. One question each. **The mechanism story is available; the evidence for it is not, at this size.**

## 3. `H5` failed, and it is the most useful result here

The control arm was read twice, on the same 20 questions, through the same reader and the same judge:

| run | `cortex-session` correct | per-question agreement with the other run |
| --- | ---: | ---: |
| A `43170314351` | **13/20** | — |
| B `43178388235` | **11/20** | **16/20 = 80.0%** |

Four questions flipped: `0100672e`, `031748ae`, `031748ae_abs` (right → wrong) and `09ba9854_abs`
(wrong → right). `H5`'s threshold is 90%, so by the criterion written before the dispatch:

> **at n = 20 this arm's run-to-run movement (2 questions) is twice the inter-arm difference (1 question), so no
> ranking of two systems may be taken from a single 20-question pass.**

This is the same defect class the campaign already found once in this instrument — two invocations of one
harness disagreed by five questions per arm, which is why `--json-out` exists. It now has a number on the
accuracy column rather than on the table's provenance.

**Nothing about run A is a mistake.** It is the same configuration measuring the same thing, and the difference
is the instrument's repeatability at this population. Quoting either number as "our retrieval scores 55%" or
"65%" would be quoting noise; quoting the pair as a 10-point regression would be worse.

## 4. The defect run A found, and the guard on it

Run A's reading table carried no `mem0` row while its retrieval table carried `mem0` at 100.0% recall. Cause: the
three reading stages are separate processes, `--read-arms` selects providers **by name**, and a process that never
launched the competitor has no provider by that name. The filter matched nothing, silently.

The repair forwards `SUT`, `MEM0_INFER` and `ZHIPU_API_KEY` into all three reading stages and passes `--sut` when
the input is non-empty (`--sut ""` is an error rather than "none", so the flag is built by a shell test). The
guard, `tools/__tests__/test_sut_read_wiring.py`, **derives** the reading stages from the workflow — any step that
invokes `competitor-harness.mjs` with `--read` must be able to host a system under test — so a fourth prompt added
later is covered the moment it exists. Verified both ways: three of its five assertions fail against the previous
workflow, all five pass against this one.

## 5. What this licenses

- **A statement about cost:** at indistinguishable accuracy on this population, `mem0` reads **1,768** prompt
  tokens per question against **33,556** — a 19.0× difference, and the direction has a mechanism: it returns
  extracted memory entries rather than turns, and its `all-gold` is **0.0%** against 80.0%. It finds *one*
  annotated evidence item every time and *all* of them never.
- **A statement about the harness:** the T1 pipeline now runs end to end with a competitor's own code, its own
  process, its own vector store, and our reader and judge. Two dispatches, `comparability()` grade **A**.
- **A statement about the population:** n = 20 is too small for this instrument. That is measured, not assumed.

## 6. What it does not license

- **No ranking.** p = 1.0 and an 80% repeatability at n = 20.
- **No comparison with 91.25%.** That is T2 — the product's own reader and routes. This is T1. Subtracting across
  the two is what `comparability()` grades `B`, and the campaign has already made that mistake twenty times.
- **No claim about `mem0`'s published 94.4%.** `infer=false` is a different system from the one that number
  describes, and the manifest says so beside the row.
- **No claim about `MR`/`TR`.** Both arms are at 1/4 on `TR`, and the reader is the reason.

## 7. What a decision costs

| step | questions | ingest wall clock | reader+judge calls | decides |
| --- | ---: | ---: | ---: | --- |
| smoke (this) | 20 | 50 min | 40 | that the pipeline runs |
| **decision** | **100** | **~4 h 10 m** | **200** | a ranking, if `H5` clears at n = 100 |
| full row | 500 | ~21 h | 1,000 | a quotable row beside the product table |

The ingest is 55× the answering cost: the SUT stage spent **49m42s** ingesting and the reading stage spent
**54s** reading and grading the same 20 questions. That is why `03` §14.130 registers a content-addressed embedder
cache — with the criterion that with and without the cache the arms must produce **identical answers**, not equal
accuracy — and why the queue's second row (`letta`) is worth running before the third, since its ingest is the
same shape.

## 8. Reproduction

```sh
# run B, the one with both rows
gh workflow run competitor-retrieval.yml \
  -f questions=5 -f read_questions=20 \
  -f sut=mem0 -f sut_infer=0 \
  -f read_arms=mem0,cortex-session -f read_prompts=con -f limit=10

# the two artifacts this file reads
#   art-43170314351/competitor-read.txt   run A: cortex-session 13/20, no mem0 row
#   art-43178388235/competitor-read.txt   run B: cortex-session 11/20, mem0 12/20
```
