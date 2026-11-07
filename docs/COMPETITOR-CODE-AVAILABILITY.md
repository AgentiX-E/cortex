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

## 6. The 2026-11-07 re-check: four new systems, none of them raceable, and one dataset that is

The week's papers were re-checked for a repository field the same way the rows above were, and the
answer is the same shape: the score is published, the code is not.

| system | claim | repository field | verdict |
| --- | --- | --- | --- |
| `Reglos` (`arXiv:2611.06049`, 2026-11-04) | LongMemEval-S **87.2%** (GPT-5.6 Luna reader) / 84.0% (Qwen3.8-27B); PersonaMem-v2 **61.3%** | a project website, **no repository** | read; the highest *same-backbone* LME-S number on our axis |
| `TrackMem` (`arXiv:2611.02001`, 2026-11-01) | `FinLoCoMo` 73.9% macro vs 69.4% best baseline; revised-figure questions 86.5% vs 73.4% | none | read; **its dataset is the usable part** |
| `AppMem` (`arXiv:2611.00191`, 2026-11-03) | `MemU-Bench` SPL 15.7% → **66.9%** on GPT-5.5 | "code released" claimed on the index page, not resolvable on 2026-11-07 | read; the **metric** is the usable part |
| `MemCompile` (`arXiv:2610.23313`) | LoCoMo 80.52% judge accuracy | none | read (already in §1.49.4) |

Two of those four contribute something better than a number:

1. **`FinLoCoMo` is a dataset, and datasets do not need a repository field to be usable.** 15 long-horizon
   investment conversations, 765 questions, two splits (LoCoMo categories, and four failure modes), with
   "revised figures" broken out as its own class. That class is our `knowledge-update` capability, and a
   benchmark that isolates it turns our `KU` delta from a line in a table into a price. Registered as the
   **third external set** behind `letta`'s arm, because a set that prices one capability is worth less than
   an arm that can be compared to a published number.
2. **`SPL` is a metric, and metrics travel.** `MemU-Bench` reports success *weighted by path length* so that an
   agent which succeeds by exhaustively searching is distinguishable from one that remembers. Our browser
   axis has no path-length term at all, which means it currently cannot tell those two apart — the same defect
   `LME-V2`'s `LAFS` exposed on the latency axis (§1.49.7). Registered: the browser axis's first gate is
   `(success rate, SPL)`, not success rate alone.

**The one number that changes a table.** `Reglos`'s `87.2%` is measured with the *same backbone writing memory
for every system*, so "you must have used a stronger reader" does not dissolve it the way it dissolves a
vendor table. It is below our `91.95%` and above our `89.80%`, i.e. it sits **inside the band our two cost
configurations bracket**. That is the most useful placement a competitor can have: it means our cost arm is
the one that needs to move, and it is the arm §13.302 already measured at 0.754x.

**Why none of them is dispatched this round.** The queue is ordered by what a reading would settle, and
`letta` settles more than any of these: it is the only system with a published number *on this benchmark at a
matched reader* (`438/500`), so it calibrates the whole competitor path. A `Reglos` reproduction would
reproduce a protocol we do not share (their `S` split, their reader, their prompt), which is the definition of
a number that cannot be compared.
