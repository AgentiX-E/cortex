# Racing three competitors on one model, and what the first attempts already refuted

**The instruction this answers.** Run Mastra, Mem0 and MemCog with the same LLM Cortex reads with, compare accuracy
and cost, and decide from the numbers which mechanism is worth copying. This file records the machinery that makes
that a configuration, the four facts it established before any score existed, the arithmetic that says what a full
run costs — and, once all three arms had run, what they actually cost.

**The answer, before the evidence.** None of the three beats Cortex's own window at the same context budget, and the
two that spend the most buy the least: MemCog builds a store for **¥3.48 a question** and 97% of that is the build,
Mem0 extracts facts for **¥1.37** and lost a question Cortex answered, Mastra reads the full 112k transcript for
**¥0.275** and gains 6.7 points that `p=0.73` cannot separate from noise. What is worth copying is not a mechanism
but a **shape**: MemCog's navigable pages plus two tools plus a bounded number of rounds, which is 2.8% of MemCog's
own bill. §7 has the measured table, §9 the verdicts.

## 1. "The same LLM" has to be a base URL, because three of the four positions are invisible

Cortex's reader and judge are DeepSeek. That is one position. The other three are inside the competitors:

| system | where a model is called                                           | published number depends on it               |
| ------ | ----------------------------------------------------------------- | -------------------------------------------- |
| Cortex | reader (one call per question)                                    | no — retrieval-only                          |
| Mem0   | extraction at ingest (`infer=1`), one call per turn               | **yes** — the 94.4 configuration uses it     |
| MemCog | store build (5 steps) **and** navigation (2–7 turns per question) | **yes** — 95.80 is the whole loop            |
| Mastra | answering agent, Observer, Reflector                              | **yes** — 84.23 vs 94.87 is the reader alone |

So a run that sets only `DEEPSEEK_MODEL` compares Cortex-with-DeepSeek against three systems on their own defaults,
which for Mastra is `'auto'` — a Google Gemini default when a Google key happens to be present. The fix is not a
promise in a README, it is `tools/competitor-sut/sut_llm_proxy.py`: every driver's `base_url` points at it, it
forwards to DeepSeek, and it reads `usage` out of the response.

Consequences, all of which are asserted in `tools/__tests__/test_sut_llm_proxy.py`:

- the request and the response are forwarded **byte for byte** — the system under test is parsing them;
- `prompt_tokens` comes from the parts, not from `total_tokens` plus a part, which is a double count;
- `X-Sut-Label` splits the bill by phase, so "MemCog cost 1.4M tokens" becomes "1.2M building the store, 0.2M
  answering";
- the counters are per model, so a silent fallback shows as two rows instead of one average;
- `stream: true` is **forwarded** and settled from the final frame — see §3 for why the first version was wrong.

## 2. MemCog's published repository cannot call a model

`src/core/llm_client.py` at `fff97b2d4190`:

```python
def _call_gpt(...):
    for _ in range(3):
        try:
            # TODO: 在此填入 OpenAI 兼容接口的调用逻辑
            # client = OpenAI(api_key=APPKEY, base_url=BASE_URL)
            # completion = client.chat.completions.create(**kwargs)
            response = {}
            return response
```

and `src/config/llm_config.py` is four empty strings. The README instructs the reader to uncomment the example.
**Every** reproduction of MemCog therefore supplies the transport, this one included. `memcog_driver.py` patches
`core.llm_client.call_llm` before anything imports it by name and keeps the patch to the authors' own six lines —
no retry ladder beyond theirs, no prompt change, no parsing.

That is not a defect in their paper; it is a fact about what a quoted number from that repository can mean. A
reproduction is MemCog's pipeline **plus a transport**, and the manifest says so in those words.

### 2.1 And it does not run on Python older than 3.12, which the repository does not say

The first real dispatch died on `manifest produced no response`. The driver's stderr had the reason:

```
File ".../store_build/sources.py", line 75
SyntaxError: f-string expression part cannot include a backslash
```

PEP 701 legalised backslashes inside f-string replacement fields in Python **3.12**. The runner has 3.11.18. So the
module does not import, the failure happens before `main()`, and the parent reports it as a dead driver rather than
as a version assumption nobody checked — the README names no minimum version.

Two consequences, and they matter beyond this file:

- a competitor's runtime requirement is **part of its configuration**, and a driver that discovers it late has
  already spent a dispatch. `memcog_driver.py` now re-execs into `MEMCOG_PYTHON` when it is younger than 3.12, and
  otherwise exits with one sentence naming the version, the file and the PEP;
- the interpreter is installed **beside** the job's 3.11 rather than replacing it, because every other step in this
  comparison runs on 3.11 and swapping it would be a second variable inside the experiment.

## 3. Mastra's `agent.generate` runs over the streaming path, and refusing it was my bug

The proxy refused `stream: true` on the argument that usage is only complete in the final chunk and a proxy that
summed deltas would report a number it did not measure. The argument was right about the summing and wrong about the
conclusion: Mastra sends `stream: true` with `stream_options.include_usage` on **every** generate, so the refusal did
not protect the measurement — it made one of the three systems unrunnable, and it failed as a `400` per question
whose visible symptom was an **empty answer**, i.e. a shape that reads as a memory failure.

The fix: forwards SSE chunk for chunk, reads `usage` from the frame that carries it (assigning, not accumulating),
counts one `calls` per conversation rather than per frame, and logs `stream_frames` so a stream that ended without a
usage frame is visible instead of silently zero.

## 4. Two systems have no retrieval endpoint, so the protocol grew one optional operation

`MemoryProvider.answer?` — optional in the type, optional in the manifest, and its presence is a claim about the
architecture. Harness consequences:

- the shared reader does **not** run for a `self` provider, asserted with a reader that throws rather than one that
  records (a harness that called both would still produce a plausible answer from the shared side);
- the judge **does** run, so accuracy stays comparable;
- `ProviderScore.answerer` records `shared` / `self` / `none`, and the table prints `—` for a `self` row's recall
  columns instead of `0.0%` (it has no ranked list, so a zero would be a false claim);
- `ProviderScore.usage` carries the system's own spend; `null` is "not measured", not free.

The reason this matters numerically is Mastra's own ablation: **84.23 → 94.87** for the same memory with a different
reader. A table that put a `self` row beside a `shared` row and let a reader subtract them would be inviting exactly
that 10.64-point error.

## 5. What a full run costs, before it is dispatched

Measured on the local stand-in, not on the corpus: a 120-turn transcript (≈36k tokens) produced **9 model calls** in
one question — 8 observation/reflection cycles plus the answer — and took **4m10s**. LongMemEval-S is ~550 turns per
question, so the naive extrapolation is 5–15 minutes per question for Mastra alone.

| arm                     |      calls per question | tokens per question (estimated) | 100 questions | 500 questions |
| ----------------------- | ----------------------: | ------------------------------: | ------------: | ------------: |
| Cortex (retrieval only) |      1 reader + 1 judge |           ~7.4k context + judge |        ≈ 1.5M |        ≈ 7.5M |
| Mem0 `infer=1`          |     ~550 extraction + 2 |                           ~1.6M |        ≈ 165M |        ≈ 820M |
| MemCog                  | ~50 build + ~4 navigate |                           ~200k |         ≈ 20M |        ≈ 100M |
| Mastra OM               |   ~8 observe + 1 answer |                            ~36k |        ≈ 3.6M |         ≈ 18M |

At DeepSeek list prices (¥2/M prompt cache-miss, ¥8/M completion) the 500-question column is roughly **¥1,900** for
Mem0, **¥250** for MemCog and **¥60** for Mastra, plus the shared reader and judge. Mem0 at `infer=1` is the only
arm whose bill is large enough to change the plan, which is why it has its own input (`sut_infer`) and why `infer=0`
remains the default: a run at `infer=0` is a **different system**, and the manifest says which one ran.

Three of those four estimates were wrong, in both directions, and §7 is the correction: MemCog came in at
**1,287,032 tokens and ¥3.48 a question** (6.4× its estimate — the table guessed ~50 build calls and the build actually
takes 665), Mastra at 125,296 and ¥0.275 (3.5× its estimate), Mem0 at 576,772 and ¥1.37 (a third of its estimate,
because the haystack is ~52 sessions per question rather than 550 extracted turns). At measured prices the
500-question column is ≈¥1,740 for MemCog, ≈¥685 for Mem0 and ≈¥138 for Mastra. The estimates stay in this section
rather than being replaced by the measurements: a pre-registered number that turned out wrong is the only evidence
that the measurement did any work.

The wall-clock column is the binding constraint, not the money: 500 Mastra questions at 5 minutes each is 41 hours,
so the first dispatch is 100 questions and the 500-question arm needs sharding.

## 6. What the first dispatch is, and what it will decide

`workflow_dispatch` with `sut=memcog`, `read_questions=100`, `sut_llm` empty (so the systems inherit the reader's
model id). Then the same with `sut=mastra`, then `sut=mem0&sut_infer=1`.

The question each number answers is narrow on purpose. It is **not** "is Cortex better than MemCog". It is:

- MemCog at 100 questions on DeepSeek against Cortex at the same 100 questions and the same judge — if the
  navigation loop is worth 3+ points, the mechanism to copy is _navigable structure with tool calls_, and
  `DESIGN-MULTI-STEP-RETRIEVAL.md` already has the registration for it;
- Mastra at the same — if observational memory at 30k thresholds beats Cortex, the mechanism is _compression instead
  of retrieval_, which this repository has never tested (`[thing 3]` in the ledger is its nearest relative);
- Mem0 at `infer=1` against Mem0 at `infer=0` — the extraction ablation is free once the arm exists, and it is the
  one measurement that says whether fact extraction buys anything at all on this corpus.

None of the three has been run at 100 questions yet. What has run is 30 / 2 / 2 (§7), which is enough to price the
arms and to eliminate one hypothesis per arm, and not enough to separate any of them from Cortex on accuracy. The
dispatch that matters — 100 questions, sharded at 700 (`--offset`) so a paired test has power — is the next one.

A competitor that loses still answers a question, and that is the point of running their code rather than reading
their table: the four facts in §2–§3 above were all obtained before a single question was scored.

## 7. What the arms measured, and what all three cost

Three dispatches produced numbers under the same judge and the same model, on the same sampled questions. All are
small — 30 questions for Mastra, 2 each for Mem0's and MemCog's passes — and every figure below carries its `n`,
because a 30-question difference of two questions is a coin.

| arm                              |   n |          accuracy |            calls/q | prompt tok/q | ¥/q (list) | what its context is                          |
| -------------------------------- | --: | ----------------: | -----------------: | -----------: | ---------: | -------------------------------------------- |
| `mastra` (self-answering)        |  30 | **70.0%** (21/30) |                2.0 |      125,296 |      0.275 | its own generator, observations + transcript |
| `cortex-session` (shared reader) |  30 |     63.3% (19/30) | 1 reader + 1 judge |       33,270 |      0.067 | whole sessions, budget 8 turns               |
| `lexical-reference` (shared)     |  30 |     63.3% (19/30) |              1 + 1 |       34,974 |      0.070 | lexical top-k over the same sessions         |
| `cortex/trim-2.8k` (shared)      |  30 |     56.7% (17/30) |              1 + 1 |        2,799 |      0.006 | a 2.8k-character window                      |
| `mem0` `infer=1` (shared)        |   2 |       50.0% (1/2) |               51.5 |      576,772 |       1.37 | extracted facts, vector top-k                |
| `memcog` (self-answering)        |   2 |       50.0% (1/2) |                667 |    1,287,032 |       3.48 | pages written by the model, read back by it  |

Each row's cost is **one arm's own spend per question**, read from that arm's `usage` after the job's baseline under
the same label is subtracted (§8.3). MemCog's row is the only one that had to be recovered from the job ledger rather
than taken from its artifact, and the difference between the two is a factor of four — see §7.3.

The paired test is in the artifact, so the comparison is question by question rather than rate against rate:

```
cortex-session   -> mastra   n=30  +5/-3  delta +6.7%   p=0.7266  not significant
cortex/trim-2.8k -> mastra   n=30  +8/-4  delta +13.3%  p=0.3877  not significant
```

### 7.1 Mastra's observational memory did not compress, at its own default threshold

The mechanism this arm was dispatched to test is compression instead of retrieval: the Observer folds old messages
into observations, the Reflector merges them, and the agent answers from the observation log plus a recent window.
`messageTokens` was left at Mastra's default of 30,000 on a haystack of about 115,000 tokens.

The ledger says what actually reached the model. 90 answers produced **180 calls — two per answer**, and the two are
not symmetric:

|                                   |                       prompt tokens per call |
| --------------------------------- | -------------------------------------------: |
| the small call (90 of the 180)    |                         p25 7,765, min 5,884 |
| the answering call (the other 90) | median **112,144**, p75 116,635, max 118,781 |

So the answering call carried the transcript, not a compressed log: a median of 112k tokens against a 115k haystack
is compaction of nothing. The arm's 70% is a **full-context read** with a memory wrapper around it, and it should be
read beside `cortex-session`'s 33k and `cortex/trim-2.8k`'s 2.8k rather than beside Cortex's own budget arms as if
the context were the same.

That reading changes what is worth copying. "Compression instead of retrieval" is not what produced the +6.7 points;
**context volume** is, and Cortex already has a dial for that (`maxPromptCharsByRoute`). What Mastra demonstrates is
the size of the prize: at 3.8× the context, +6.7 points, not significant at n=30.

### 7.2 Mem0's extraction is the most expensive context in the table, and it lost both questions

`infer=1` pays one model call per session at ingest — 103 calls for a two-question haystack — and the extraction
prompt carries the conversations, so the bill is **576,772 prompt tokens per question**: 5.0× the whole 115k-token
haystack, 17× `cortex-session`'s 33k and 206× the 2.8k window. It answered 1 of 2. Every Cortex arm answered both, on the same two questions in the same run.

The part that is not a sample-size story: the answer did not move **across three reader prompts**. The same
`mem0` context scored 1/2 under `con`, under `dispatch` and under `dispatch2`, while `cortex-session` moved 2/2 →
1/2 → 1/2 and `cortex/trim-2.8k` stayed 2/2. When a prompt that inserts a per-capability clause changes nothing for
one arm and changes something for another, the difference is in what the two arms put in front of the reader.

Recall@k for this arm is 0.0%, and that number is a statement about the metric, not about Mem0: a hit is counted when
its text contains a gold _turn_, and an extracted fact is not a turn. The metric cannot see an extraction system at
all. Its accuracy column is the only one that can be read.

### 7.3 MemCog: 1.29M prompt tokens and ¥3.48 a question, 97% of it before the question is asked

MemCog is the only arm whose cost had to be reconstructed rather than read: its artifact said `¥13.91` and
`2,799,803` tokens per question, and both numbers described **two** arms (§8.3). The job ledger is the primary
source, and it segments cleanly at each return to `q1` because the four arms ran one after another:

| arm in the job       | calls | prompt tokens |     ¥ | ¥/question |
| -------------------- | ----: | ------------: | ----: | ---------: |
| retrieval step       | 1,312 |     2,471,285 |  6.71 |       3.36 |
| reading, `con`       | 1,363 |     2,677,061 |  7.19 |       3.60 |
| reading, `dispatch`  | 1,336 |     2,600,276 |  7.01 |       3.51 |
| reading, `dispatch2` | 1,328 |     2,547,637 |  6.90 |       3.45 |
| **job total**        | 5,339 |    10,296,259 | 27.82 |       3.48 |

Two questions per arm, 103 sessions and 1,037 turns of haystack. So one question costs **1,287,032 prompt tokens,
667 calls and sixteen minutes** — and the split says where it goes:

| phase    | calls | prompt tokens | share |
| -------- | ----: | ------------: | ----: |
| build    | 5,319 |    10,005,968 | 97.2% |
| navigate |    20 |       290,291 |  2.8% |

That is the whole finding. **97% of what MemCog spends buys the store, and 2.8% buys the reasoning that could be
copied.** Per session the build costs about 24,300 prompt tokens; per turn about 2,400. Navigation — two to seven
model calls over pages the build wrote — is the part `DESIGN-MULTI-STEP-RETRIEVAL.md` describes, and at 20 calls for
two questions it is also the cheapest thing in the table.

Why the numbers move so much: MemCog scores 1 of 2, the same as `mem0`, and `n=2` cannot separate it from any arm
here. Within its own run the pairing is `lexical-reference -> memcog  +0/-1  delta -50.0%  p=1.0000` and
`cortex-session -> memcog  0/0  0.0%`: one question, in both directions, which is what n=2 is worth. Its `recall@k`
is 0.0% for the same reason Mem0's is — a hit is counted when its text contains a gold _turn_, and a generated page
is not a turn — so the accuracy column is the only one with content.

One cross-check did come out of those arm pairs. A self-answering system never sees the reader prompt, so its score
must be **invariant** across `con`, `dispatch` and `dispatch2`, and it was: `0/0 no change` for both transitions,
while `cortex-session` moved one question between the second pair. The three reader arms are therefore not a variable
that leaks into an arm that does not read. What the two questions do
establish is the price: **621× `cortex/trim-2.8k`'s 2.8k read (¥0.0056), 52× `cortex-session` (¥0.067), 12.7×
Mastra (¥0.275)** — and a shared arm's `¥/q` is its reader input only, so every one of those ratios is a lower bound
on the gap.

## 8. Four defects the dispatching found, and what they had in common

None is about a competitor. All four are about a run that reports something it did not measure — or pays for
something it does not report.

### 8.1 A crashed harness was a green step with an empty file

Nine measurement steps piped `node ... | tee artifact`,
and a pipeline reports the exit status of its last command. Run 45011910491 therefore finished _successfully_ with a
zero-byte reading table and a cost report reading `the reading stage wrote no json`. The harness had died at import,
before its first line of output. `set -o pipefail` is now on every one of those steps; the same class of failure on a
later dispatch shows up as a red X instead of a silent success, which is how the second defect below was found.

### 8.2 A store path whose parent no step created

`MASTRA_STORE` named `<workspace>/.cache/mastra/store.db` in the three
reading steps and in neither of the steps that ingest. The ingest therefore used the driver's `/tmp` default, no step
created `.cache/mastra/`, and libsql answered the reading stages with
`ConnectionFailed("Unable to open connection to local database ...: 14")` — SQLITE_CANTOPEN, which reads like a
permissions or corruption problem and is neither. The variables that address the model, the proxy and the two stores
now live in the job's `env` rather than in per-step copies, the driver creates the parent of the path it is handed,
and the live round-trip test passes it a path whose parent does not exist.

A second, smaller one belongs here for the same reason: Mem0's DeepSeek factory builds an `OpenAI` client whether or
not the model is reachable, and the retrieval stage does not carry `DEEPSEEK_API_KEY`, so the driver handed it `""`
and died with `Missing credentials`. Nothing on that path reads the client's credential — the proxy replaces
`Authorization` with its own upstream key. A loopback base URL now gets an explicit `proxied` placeholder, the
manifest records which placeholder was used, and any other URL still gets nothing.

### 8.3 A cost column that was the job's, not the arm's

The metering proxy is started once per job and kept alive across the retrieval step and the three reading arms,
because it is also what meters the reading. Its `/stats` counter is therefore **job-scoped**, and every driver in
`DRIVERS` reports that counter verbatim — correct for a driver to report, wrong to attribute to one row.

MemCog is the first arm where it mattered, and the arithmetic closed to the token rather than to an argument:

| quantity                             | value                     | where it comes from                      |
| ------------------------------------ | ------------------------- | ---------------------------------------- |
| what the row recorded                | `5,148,346` prompt tokens | `usage` in its `competitor-read.json`    |
| the retrieval arm plus the `con` arm | `5,148,346` prompt tokens | `2,471,285 + 2,677,061` from the ledger  |
| what one arm of two questions spent  | `2,574,173` prompt tokens | ledger, segmented at each return to `q1` |
| what the row printed per question    | `¥13.91`                  | `usage ÷ 2 questions`                    |
| what one question cost               | `¥3.48`                   | `¥27.82 ÷ 8 (four arms × two questions)` |

The other two rows were arm-local **by accident**, and the accident is worth naming: Mastra's ingest is storage-only
(`0 call(s)` in its own progress line) and Mem0's retrieval step died on the credentials defect in 8.2, so neither
label had spend in it when the `con` arm started. MemCog's retrieval step builds its store with the model, so it is
the only one of the three where an earlier arm had already spent under the label the reading arm would report.

Two things changed so the next run needs no archaeology: the adapter reads `/stats?prefix=<name>` **before** the
driver can spend anything and subtracts that baseline from every reading, failing the arm if the counter cannot be
read (a job-scoped counter with no baseline prices the job, not the arm) or if the driver reports fewer calls than
the baseline (its counter is not the proxy's, so the arm cannot be attributed at all); and the report's money column
is `own ¥/q` rather than `own ¥`, because it sits beside `own tok/q` and a total under a per-question heading is a
30× error at n=30. `tools/competitor-sut.mjs usage-scope` is the three-case self-test, and the progress line now
prints `since launch` rather than `cumulative` for the same reason one layer up.

### 8.4 A stage that built a store nothing would read

The workflow runs a retrieval-only stage against the system under test and then three reading stages, and **every one
of them launches the driver and ingests again**: the protocol runs `mode: isolated`, which resets the store before
each question, so there is no state for a later stage to inherit. That repetition is not a measurement of anything
the reading stage does not already report — its row for the system under test carries `recallAtK`, `recallAllAtK` and
`mrr` at the same top-k, because `--budget-tokens` trims only this repository's own arms. So the first stage was
buying a second copy of a table one column over: run 45011905117 spent **¥6.71 and 39 minutes** on it for two
questions, and the `con` arm rebuilt the same two stores immediately afterwards.

It is now skipped whenever a reading stage will measure the same system, and the artifact says so in a line of its
own rather than by leaving a requested system's row quietly absent. Two cases still run it: a retrieval-only
dispatch (`read_questions=0`), and a dispatch whose explicit arm list names systems other than this one — which is
the only way the reading stage would not carry its row. That second skip is worth more than it looks: at Mem0's
measured 4.7 s per extraction call, thirty questions ingest in about two hours, and the duplicate put the dispatch
against the job's 300-minute ceiling with no margin.

Inside the stage there is a second skip, for a different reason. When the stage does run — a retrieval-only dispatch
— a self-answering system has nothing to contribute to it: `search` on Mastra and MemCog returns `hits: []` by
construction, because their context is assembled while they answer, so the only recall they can print is 0.0%, which
is a statement about the instrument. The stage is skipped for them on `answers: true` in the manifest, keyed on the
declaration rather than on a workflow input: a flag is one more thing a dispatch can get wrong, and the declaration
of the architecture is already being read to decide whether `answer` may be called at all. Mem0, Letta and the
reference driver still get it, because a ranked list is something their recall column can measure.

The accounting consequence is worth stating before it is discovered in the next bill: a self-answering arm's
per-question cost **includes a store build per question**, and that is not a distortion — it is what the system costs
to answer one isolated question, which is the protocol every other arm is held to. What it does mean is that
`read_prompts` multiplies that cost by the number of arms, so a three-prompt sweep rebuilds the same stores three
times, and a MemCog comparison of reader prompts is a ¥10-per-question experiment rather than a ¥3.48 one.

## 9. What this says to copy, and what it says not to

| system         | what it actually does, as measured here                                                                                          | verdict for Cortex                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mastra OM      | 2 calls/question, the answering one at 112k median tokens: full context with an observation log attached                         | **Copy the budget, not the mechanism.** The +6.7 points are context volume; `maxPromptCharsByRoute` is the cheaper lever, and the experiment to run is a window sweep, not an Observer                                                                                                                                                                                                       |
| Mem0 `infer=1` | 51.5 calls and 577k prompt tokens per question — five times the haystack — to turn sessions into facts, then lose both questions | **Do not copy the extraction.** It is the most expensive context in the table by two orders of magnitude; the `infer=0` ablation is the cheap control that says whether extraction itself or only its price is the problem                                                                                                                                                                   |
| MemCog         | 1.29M prompt tokens, 667 calls and ¥3.48 per question — 97.2% of it building the store, 2.8% navigating it — and 1 of 2 answered | **Copy the interface, not the build.** Navigable pages plus two tools plus a bounded number of rounds is a smaller change than it looks (`DESIGN-MULTI-STEP-RETRIEVAL.md`), and it is the 2.8% of this bill: 20 calls and 290k prompt tokens for two questions. The build is what makes the arm 52× `cortex-session` and it bought an answer the judge could not separate from a coin at n=2 |

The one thing none of the three demonstrates is a mechanism that beats Cortex's own window _at the same context
budget_. That is the experiment the next round should run: fix the reader input at 33k tokens for every arm, and see
whether observations, facts or navigation beat verbatim sessions **inside** the same envelope.

## 10. The next dispatch, registered before it runs

Cortex's own arms cannot be moved to Mastra's envelope — 112k tokens per question is 3.8× anything in the reading
table — but Mastra's **can be moved to Cortex's**. `messageTokens` is the trigger that decides how often the Observer
compresses, and at the vendor default of 30,000 nothing is compressed enough to matter: the answering call read the
corpus _plus_ an observation log that had grown to the size of the corpus. Lowering the trigger is one number, and it
turns the comparison into the one the table cannot currently make — the same mechanism inside a 33k prompt budget,
against `cortex-session` on the same questions, same judge, same model, same sample.

So the dispatch is `sut=mastra`, `sut_mastra_message_tokens=3000`, `questions=30`, `read_questions=30`,
`read_prompts=con`, `offset=0`. The control is not a new arm: it is the 30-question Mastra row already in §7, read on
the same sample, so the pairing is within-question and the only thing that moved is the trigger.

| prompt tokens per question | accuracy against `cortex-session`'s 63.3% | what it would establish                                                                                                           |
| -------------------------: | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
|                   ≤ 40,000 | ≥ 63.3%                                   | compression fits the envelope and beats verbatim sessions inside it — **build the compressor**, the mechanism transfers           |
|                   ≤ 40,000 | < 63.3%                                   | compression loses when it has to fit — copy the budget knob only, and the Observer stays out of Cortex                            |
|                   > 40,000 | any                                       | the trigger does not control the context, because the observation log dominates it — Mastra's cost is structural, not a threshold |

The third row is the one with no fallback: if a 10× lower trigger leaves the prompt above 40k, then nothing about this
system's price is tunable, and the "copy the budget" verdict in §9 upgrades from an inference to a measurement.

Two things this experiment cannot settle, stated now so they are not read into the result. It is n=30, so a difference
of two questions is still a coin — a 63.3%-versus-63.3% outcome is "indistinguishable", not "equal". And it moves one
number inside a vendor's own configuration: it answers "can this mechanism live in a 33k envelope", not "is an
Observer better than a good window", which is a question only an implementation inside Cortex can answer.

## 11. What the normalised column establishes, and three corrections to the obvious reading

`tools/sut-cost-report.mjs` now prints the column this comparison was missing: **points per million prompt tokens the
system caused to be read**, with `--reference <arm>` pricing every other row against one named arm. The denominator is
the system total — what the reader read plus what the system spent producing it — and that choice is the whole
argument, because the two halves differ by three orders of magnitude for an extraction system.

On the 30-question run:

| arm                 | prompt tok/q (system) | accuracy | pts / 1M tok | to draw with `cortex-session` |
| ------------------- | --------------------: | -------: | -----------: | ----------------------------- |
| `cortex/trim-2.8k`  |                 2,799 |    56.7% |       202.57 | at 5.3%                       |
| `cortex-session`    |                33,270 |    63.3% |        19.03 | — (the reference)             |
| `lexical-reference` |                34,974 |    63.3% |        18.10 | at 66.5%                      |
| `mastra`            |               125,296 |    70.0% |         5.59 | **cannot (238%)**             |

The same command on the two 2-question runs reads `mem0 cannot (1745%)` and `memcog cannot (3892%)`. Those rows are
one coin of accuracy each, and the verdict does not care: a row that needs more than 100% accuracy cannot draw with
the reference whatever its accuracy turns out to be, so **the ordering is independent of the sample size**. That is a
stronger statement than the paired test can make at n=30, and it is the one the copy decision should rest on.

### 11.1 The denominator is the finding

Built from the reader's context alone — which is the number a vendor publishes as "context per question" — the same
command ranks **Mem0 first at 1,392.76 points per million tokens**, 39× the leader it actually is, because it hands the
reader 359 tokens per question and spends 603,503 of its own turning sessions into facts. A tool that reports the
small denominator without the large one does not merely flatter extraction: it inverts the ranking. That is why the
column is named after what the system _caused to be read_ rather than after what the reader saw.

### 11.2 The arm this compares against is not the shipped arm

`cortex-session` is a baseline. The shipped configuration — `cortex-memory`, six-route room map,
`relevanceTopK=256` — reads **91.25% at 7,448 tokens per question** over 500 questions and four passes
(`landscape.json`, run 44017278305), and the supersede arm reads 91.35% at 9,241. So the honest form of the previous
section's conclusion is: _no measured competitor draws with Cortex's **baseline** arm_, and the shipped arm is both
28 points higher and 3.6× cheaper per question than that baseline. The comparison is therefore asked of the wrong
control, and the repair is not a new dispatch — it is putting the product arm on the same harness, so that "should
Cortex copy this mechanism" is asked against what Cortex ships.

### 11.3 Synap is not "above and out of reach"

95.6% (478/500) at **7.4K tokens per question**, answered by Gemini 3.8 Flash and judged by gpt-4o. Against Cortex's
91.25% at 7.4K that is +4.3 points, and this repository has measured that swapping a judge moves its own 467 recorded
answers by **−3.21 points, 13 down and 0 up**. A 4.3-point gap inside a 3.2-point instrument band, with a different
reader class on each side, is **not decidable**, in either direction.

"Closed source" also does not put it out of reach of copying. Their repository publishes every per-question record —
retrieved memories, written answer, judge verdict — plus the answering prompt, two run manifests and the `bench/`
harness. An **answer-level re-grade** is available and cheap: no ingest, no reader, no dispatch, one pass of our judge
over their 500 records. That is a stronger instrument than a race, because it removes the reader from the comparison
entirely. Closed source blocks running their system; it does not block reading their mechanism or re-grading their
verdicts.
