# Who can actually be raced, and who can only be read

**Why this file exists.** The standing instruction is that a competitor's number is worth quoting
only if we ran their code with our reader on our data. Every round has said so and one competitor has
actually been through the protocol (`tools/competitor-sut/mem0_driver.py`). This is the inventory that
turns "we should race them" into a list with a licence and a URL per row, checked against the GitHub
API on 2026-11-07, and it states plainly which of the systems on the leaderboard **cannot** be raced
at all.

## 1. Rows that can be raced: code, permissive licence, and a live repository

All eight are reachable and all are `Apache-2.0` or `MIT`, which matters because the protocol runs the
system's own code in its own interpreter and ships nothing.

| repository | licence | stars | last push | what it is for this campaign |
| --- | --- | ---: | --- | --- |
| `mem0ai/mem0` | Apache-2.0 | 68,553 | 2026-11-06 | already wired (`tools/competitor-sut/mem0_driver.py`); the field's reference baseline |
| `letta-ai/letta` | Apache-2.0 | 25,376 | 2026-10-18 | **the one MemStrata ran at a matched reader**: `438/500 = 87.6%` against its own packet's `463/500` |
| `MemTensor/MemOS` | Apache-2.0 | 12,312 | 2026-11-04 | vendor-reported `89.20` on the board; measured `89.20 → 89.20` under OmniMemEval's independent harness |
| `getzep/zep` | Apache-2.0 | 5,000 | 2026-11-04 | the cost leader we quote (`~4,400` tokens/question) |
| `memodb-io/memobase` | Apache-2.0 | 2,950 | 2026-01-11 | **stale**: ten months without a push, so a number from it is a number about a 2026-01 build |
| `langchain-ai/langmem` | MIT | 1,751 | 2026-11-03 | the `3.26M` token arm MRAgent compares against |
| `xiaowu0162/LongMemEval` | MIT | 1,201 | 2026-05-11 | the **harness** we already run: `evaluate_qa.py` is the reference-only protocol this repository reproduces |
| `xiaowu0162/LongMemEval-V2` | Apache-2.0 | 203 | 2026-08-09 | a **second track with official baselines** — see §3 |

Two of the eight change what the board means, and both are worth their own paragraph.

## 2. The harness has a version, and the version is not the paper

`longmemeval-cleaned` (September 2025) **replaces** the original release: noisy history sessions that
could interfere with answer correctness were removed. The dataset card says so directly, and it says
the consequence too — *reported paper results and any reproduction on the cleaned files are not
automatically the same experimental artifact.*

We run the cleaned file (`500 instances in file, 500 graded after sampling`, fingerprint
`sha256:d6f21ea9…`). So every published number we quote was produced on a file we do not have, and
every number we produce is produced on a file its author did not have. That does not invalidate a
comparison, but it makes "same 500 questions" a claim that has to be checked rather than assumed, and
it is the reason §16.2 of `SOTA-LANDSCAPE.md` compares against MemStrata's 463/500 and not against
the paper's own table.

## 3. `LongMemEval-V2` is a different benchmark that happens to share a name

Every SOTA claim on this board is a claim about V1's 500 questions. V2 is not a harder version of the
same thing:

| | V1 | V2 |
| --- | --- | --- |
| questions | 500 | **451**, hand-curated |
| unit of history | a chat transcript, ~115k tokens at S | a **web-agent trajectory**, up to 115M tokens |
| abilities | IE, MR, KU, TR, ABS | static state recall, dynamic state tracking, workflow knowledge, environment gotchas, **premise awareness** |
| baselines shipped | retrieval scripts | **five memory modules**: `no_retrieval`, `rag_query_to_slice`, `rag_query_to_slice_notes`, `agentrunbook_r`, `codex`, `agentrunbook_c` |
| reference reader | the paper's models | `Qwen3.5-9B` fixed, `Qwen3-Embedding-8B` for embedding arms |

The reason it belongs in this campaign and not in a footnote: it ships **official baselines with a
fixed reader**, which is exactly the "run their code on our data" arrangement, except the harness is
theirs and the reader is pinned. Racing `rag_query_to_slice` against our arm on V2's small tier would
be the first comparison in this project where neither side brought its own judge.

It is also 115M tokens at the top tier, which is a cost this project has never paid, so it is a
sequenced item rather than a next-round item.

## 4. Rows that cannot be raced: the board's top four have no code

| system | reported | code | what we can do |
| --- | ---: | --- | --- |
| Recallium | 98.4% | **none found** | read the paper; reproduce the mechanism only |
| ContextStream | 96.8% | **none found** | read the paper; reproduce the mechanism only |
| Agent Zero Memory (`arXiv:2608.29606`) | 95.60% | **none found** | read the paper; its eight-backbone study is quotable as a bound (§16.3) |
| MemStrata (`arXiv:2610.05343`) | 92.6% / 95.0% | **none found** | read the paper; its arms are single-variable and reproducible in our harness |

**A name collision worth recording, because it nearly cost a round.** A search for "Agent Zero Memory
open source" returns `frdel/agent-zero` and `agent0ai/agent-zero` — a general-purpose agentic
framework with a persistent-memory feature, 176 commits, MIT. It is **not** the system that reports
95.60% on LongMemEval, and cloning it would have produced a number attributed to the wrong system,
which is the failure `tools/competitor-sut.mjs` refuses by requiring `name`, `build` and `version` in
the manifest before the first call. The paper (`arXiv:2608.29606`) publishes no repository field.

So the honest split is **4 raceable claims and 4 readable ones**, and the four readable ones include
the top three of the headline board. That is not an excuse to stop looking; it is the reason the
per-axis table in `SOTA-LANDSCAPE.md` §16.4 marks three of its seven cells as comparisons that do not
exist rather than as gaps.

## 5. What this licenses, in order

1. **`letta` first.** It is the only competitor with a *published matched-reader number on this exact
   benchmark* (`438/500` at MemStrata's reader). Reproducing `438` with our reader in our harness
   would validate the whole competitor-SUT path end to end — including the manifest, the per-question
   failure accounting and the "found nothing vs refused" split — on a system whose answer is known.
2. **`mem0` second**, because the driver already exists and it is the field's default baseline.
3. **`MemOS` third**, because its vendor `89.20` was independently measured at `89.20` and a
   reproduction that agrees with two other harnesses is a calibration, not a comparison.
4. **`zep` fourth**, because `~4,400` tokens/question is the number `C1` is chasing and it should be
   read off their code rather than quoted from a table.
5. **`LongMemEval-V2` last**, because it is a second track with its own reader and its own cost class,
   and a track added before the first one is calibrated is two ways to be uncertain.

`memobase` is skipped: ten months without a push means a result that describes a build nobody runs.
