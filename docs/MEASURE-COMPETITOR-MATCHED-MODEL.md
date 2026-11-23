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

## 12. Two runs came back, and the pre-registration's third row is the one that happened

### 12.1 Mem0 at n=30: the extraction bill, now measured on thirty questions instead of two

The 2-question Mem0 row in §11 is a coin. The same arm on the same sample as every other row:

| arm                 |   n | accuracy | ctx tok/q | own prompt tok/q | own ¥/q | calls/q |
| ------------------- | --: | -------: | --------: | ---------------: | ------: | ------: |
| `lexical-reference` |  30 |    70.0% |    34,974 |                0 |   0.070 |       0 |
| `cortex-session`    |  30 |    60.0% |    33,270 |                0 |   0.067 |       0 |
| `cortex/trim-2.8k`  |  30 |    53.3% |     2,799 |                0 |   0.006 |       0 |
| **mem0 `infer=1`**  |  30 |    63.3% |   **407** |      **544,477** |   1.295 |    47.9 |

The two numbers in bold are the finding, and they are one mechanism. Mem0 hands the reader **407 tokens per
question** and spends **544,477 of its own** producing them: 1,437 model calls over 30 questions, one per stored
session, each reading ~11.4k prompt tokens and writing ~537 completion tokens. Every one of those calls is an
`add`; Mem0's `search` calls no model at all. So the arm is not expensive because it is doing something hard —
it is expensive because **it pays a model to write the memory, once per session, whether or not any question
will ever need that session.**

Normalised, that is **1.16 points per million tokens** against `trim-2.8k`'s 190.43 and `cortex-session`'s 18.03.
To draw with `cortex-session` it would need 983% accuracy. On the paired test it is `+2/−1, p = 1.0000` against
`cortex-session` — indistinguishable, as a 30-question sample can only be.

### 12.2 Mastra at `messageTokens=3000`: §10's third row, and why

The pre-registered table in §10 had three rows and the run landed on the one with no fallback:

| prompt tokens per question | outcome                    | what it would establish                      |
| -------------------------: | -------------------------- | -------------------------------------------- |
|                   ≤ 40,000 | —                          | did not happen                               |
|                   ≤ 40,000 | —                          | did not happen                               |
|               **> 40,000** | **120,221 (from 125,296)** | **the trigger does not control the context** |

A tenfold lower trigger moved the prompt by **4.05%** and the accuracy by **−3.3 points** (70.0% → 66.7%, 21/30 → 20/30).
§9's verdict for Mastra — "copy the budget, not the mechanism" — is withdrawn: there is no budget to copy, because the
number the trigger controls is not the number that is large.

### 12.3 The mechanism is not untunable; it is aimed at a different protocol

The call log says exactly where the 120,221 tokens go, and the answer is not "an observation log that grew to the
size of the corpus" (which is what §9 inferred without a per-call record):

- **60 calls for 30 questions**: exactly two per question, alternating large then small.
- The 30 large calls are **all ≥ 100k** (max 118,781, min of that group 116,189). The 30 small calls are **all < 10k**
  (median ~2.1k).
- Under `mastra/answer` for both, because the driver stamps the label from a module variable and the answering phase
  is the phase during which the Observer fires. `mastra/observe` appears **zero** times: nothing observes during
  `ingest`, and `settled()` returns immediately because nothing is pending.

So the large call is the answering agent reading the whole transcript (~480 turns, ~117k tokens) and the small call is
the Observer compressing the unobserved window (≤ `messageTokens`, which is what the trigger actually bounds). The
large call comes **first**. An observation that runs after the answer it could have shortened cannot shorten it, and
with `mode: isolated` every question starts a fresh thread with one ingest and one answer — so the compressed form is
never read by anything. Lowering the trigger does not fail to help; under this protocol it **cannot** help.

That reframes the copy question rather than closing it. Mastra's observational memory is built for a conversation
that continues, where the observation is read by the next turn. LongMemEval's isolated protocol is the opposite shape.
The mechanism may well be worth having; this arm cannot show it, and no threshold will.

**The prediction that would confirm this reading**, registered before it is run: under `mode: shared` — one thread
across all thirty questions — questions 2..30 should cost materially less than question 1 for the same arm, because
each question's observation becomes input to the next. If that does not happen, the Observer is not running at all and
the 66.7% is a plain full-context arm wearing an observational-memory manifest.

Two things this does not say. It does not say Mastra's 94.87% is wrong — their harness, prompt and ingest order are
still unpublished. And it does not say Cortex should skip compression: it says the compression Cortex would need is one
that runs **before** the answer, over what the answer will read, which is what `cortex/trim-*` already is at the
character level and what a semantic compressor would have to be at the token level.

### 12.4 Two defects this round found in Cortex, and one that would have shipped

Writing down "the product arm should be the control" (§11.2) made it worth checking that the product arm is reachable
from the published entry. It was not.

`registered-arm.ts` exists because the product could publish a number for one configuration and ship another. It fixed
`promptContract` and `ask` by giving `assembleMemory` a default for each. The third field, `relevanceTopK = 256`, got a
constant and **no reader**: `assembleMemory` passed `options.index` through untouched, so `SearchIndex` resolved its own
module default of **64**. A bare `assembleMemory({ llm, storage })` — which is what `docs/USER-MANUAL.md` §6.6 tells a
user to write for "the arm that was measured" — therefore scored a quarter of the turns the 91.25% reading was taken
over, and the turns past the sixtieth position received the unscored floor.

Worse, it was **unobservable**. `SearchCensus` reported turns, terms, vectors, embed calls and queries, and none of
them changes with the width. An artifact at 64 and an artifact at 256 were identical in every field a reader could
see. So the repair is two lines and one field, and they belong together:

- `assembleMemory` resolves `index.k` from `REGISTERED_ARM.relevanceTopK` when the caller names none, on the rule the
  two instruction levers already follow: a composition root that declines to name an arm does not decline to have one.
- `SearchCensus.k` reports the width the retrieval actually resolved, so "this question ranked 256 turns" and "this
  question ranked 64" stop printing the same artifact.
- `registered-arm-width.test.ts` drives the three steps a user takes (assemble, `remember`, `askStored`) and reads the
  width off the census of the retrieval that ran, because a test of the option would agree with a caller that never
  reached the index.

What this changes in every number above: **nothing**, because those rows are `cortex-session` — a bare provider that
builds no index — and the competitor arms. What it changes is the number the product ships against: the `reader`
profile's documented 91.25% at 7,448 tokens was measured at 256 and until this commit was assembled at 64.

### 12.5 The table, with every row on one sample

| arm                 |   n | accuracy | ctx tok/q | own prompt tok/q | ¥/q   | pts / 1M tok |
| ------------------- | --: | -------: | --------: | ---------------: | ----- | -----------: |
| `cortex/trim-2.8k`  |  30 |    53.3% |     2,799 |                0 | 0.006 |   **190.43** |
| `lexical-reference` |  30 |    70.0% |    34,974 |                0 | 0.070 |        20.01 |
| `cortex-session`    |  30 |    60.0% |    33,270 |                0 | 0.067 |        18.03 |
| `mastra` @3k        |  30 |    66.7% |         0 |          120,221 | 0.261 |         5.55 |
| `mem0` `infer=1`    |  30 |    63.3% |       407 |          544,477 | 1.295 |         1.16 |
| `memcog`            |   2 |    50.0% |         — |      1,287,032\* | 3.480 |         0.19 |

Every row is one stratified sample of the same thirty questions, one judge, one model, `k=10`, `mode: isolated`. The
two self-answering systems are marked in `--reference` runs; `memcog` is still n=2 and its row is a coin, which the
`cannot` verdict makes survivable rather than decisive. \*MemCog's own figure is prompt plus completion per question,
from the §7 correction; its context column is `—` because `memcog` returns pages rather than contexts and the
character count was never taken on the two-question run.

The leader is still a Cortex arm that scores 53.3%, and that is the honest state of this comparison: **efficiency is
not the axis on which Cortex is behind**. The axis is accuracy at a matched budget, and the shipped arm's 91.25% at
7,448 tokens (500 questions, four passes) is the row that belongs in this table and is not in it yet — because it is
measured by `cortex-eval`'s arm and this table is produced by the competitor harness. §11.2 named that gap; §12.4
removed one of the two reasons it existed.

### 12.6 Where the shipped arm sits, on the same axes and from a different pipeline

The table above cannot carry the `cortex-memory` row yet, and the reason is worth stating precisely: that reading is
produced by `cortex-eval`'s arm (`runBenchmark`, 500 questions × 4 passes, artifact `landscape.json`), while every row
above is produced by `tools/competitor-harness.mjs`. Two pipelines, two samplers, two cost ledgers. Putting the number
in the table would be the same defect this section is about, one level up.

What can be said without merging them is where it points. The shipped arm reads **91.25% at 7,448 prompt tokens per
question**; normalised on the same denominator, that is **122.50 points per million tokens**.

| arm              |      accuracy | prompt tok/q | pts / 1M tok | vs the shipped arm           |
| ---------------- | ------------: | -----------: | -----------: | ---------------------------- |
| `cortex-memory`  | **91.25%** \* |    **7,448** |   **122.50** | —                            |
| `mastra` @3k     |         66.7% |      120,221 |         5.55 | −24.6 points, 16× the tokens |
| `mem0` `infer=1` |         63.3% |      544,884 |         1.16 | −27.9 points, 73× the tokens |

\*500 questions × 4 passes, `S16`, run 44017278305; not the 30-question sample the rows below it were taken on.

Two conclusions follow, and they are what the "copy or do not copy" question actually needed:

1. **Neither competitor wins on either axis.** Mastra buys 24.6 fewer points with 16× the tokens; Mem0 buys 27.9 fewer
   with 73×. There is no cell of this comparison in which copying either mechanism is a shortcut to a better ratio —
   the ratio is already better by an order of magnitude.
2. **The remaining gap is not against these two.** It is against the published 95.6% at 7.4K (Maximem Synap, §11.3) and
   the 96–98% tier in `SOTA-BASELINE.md`, all of which sit above the shipped arm at a comparable or smaller bill. That
   is a gap in _what the token buys_, not in how many tokens are spent — which is why the next mechanism worth building
   is a semantic compressor that runs before the answer (§12.3), not an Observer that runs after it.

The one thing this comparison still cannot say is whether `cortex-memory` would score 91.25% on the thirty questions
these rows were taken on. At 30 questions the sampling error is ±9 points, and the shipped arm's advantage over
`cortex-session` is 28. That is large enough to survive the resampling, but it is an inference, not a measurement, and
§11.2's repair — one harness, one ledger, one sample — is still the way to turn it into one.

### 12.7 The control that was wrong is now one `--product` away

§11.2 and §12.6 both end at the same gap: the row that matters — the assembled product at 91.25% and 7,448 tokens
— is produced by `cortex-eval`'s arm, while every row in the table is produced by `tools/competitor-harness.mjs`.
Two pipelines, two samplers, two cost ledgers, and an inference in between.

That gap was structural, not a missing dispatch. The competitor harness measures a system through `MemoryProvider`:
`ingest`, `search`, one answer per question. The product is a library whose assembly _is_ the thing being
measured, so a process-boundary driver (the `--sut` path) would have had to re-implement `assembleMemory` — and a
re-implementation is the defect this whole comparator exists to avoid.

So the product arrives as one more in-process provider:

```
node tools/competitor-harness.mjs --data data/longmemeval_s_cleaned.json \
  --questions 30 --limit 10 --read --product cortex-product
```

Three decisions are visible in that row and none of them is a default:

1. **`answerer: self`.** The product's retrieval and its answer are one act. `search` returns nothing, and the
   artifact says so; Mastra's and MemCog's rows have the same shape for the same reason. A shared reader on this
   arm would either skip the product's rendering or bill it twice.
2. **Chat through the metering proxy, embedding straight to the provider.** The proxy relays chat completions and
   nothing else, so the token column is the proxy's count with `X-Sut-Label: cortex-product/answer`, and the
   embedding bill stays where the product already reports it — `indexCost()` / `selfIndex` in the arm's own
   census. One channel per line, rather than a sum that hides which half was billed.
3. **One reading stage, not three.** The product writes its own answer, so the reader prompt the dispatch and
   dispatch2 stages administer cannot reach it. Running it in all three would spend the same money three times to
   print one number three times — the duplicate-ingest defect of run 45011905117, one layer up.

Two things the wiring refuses to do, and both are tested rather than documented:

| Refusal               | Why it is not a warning                                                       | Test                                    |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| No `SUT_LLM_BASE_URL` | the arm would call the vendor directly and its cost column would read zero    | `test_competitor_product.py`            |
| No `ZHIPU_API_KEY`    | the assembly would be lexical and would print under the registered arm's name | same, plus `test_product_arm_wiring.py` |

The second test is the one that makes the metering claim checkable without a model: a stand-in for both endpoints
records every request, and the assertions are that each chat call carries the label header, that the corpus was
embedded at all, and that the answer is the product's parse (`Answer: Porto` → `Porto`) rather than the raw
completion.

What this changes about the table: the product row is now measurable **in the same invocation** as the competitors,
on the same sample, with the same judge and one ledger. It does not make the number 91.25% — that reading is 500
questions × four passes, and this row will be thirty questions until a dispatch says otherwise. What it removes is
the reason the two could not be compared at all.

### 12.8 The product arm's first dispatch found two defects before it found a number

Run `45089801550` is the receipt, and both failures belonged to the wiring rather than to the arm.

**The proxy was gated on `sut`.** The metering proxy's step ran only when a system under test was named, so a
dispatch with `product=cortex-product` and no competitor skipped it while `SUT_LLM_BASE_URL` still pointed at its
port. The product row's chat calls therefore went to a socket nobody was listening on. The proxy is not a
competitor's convenience — it is where the product row's cost column comes from — so `product != ''` joins the
condition.

**The progress wrapper inherited instead of delegating.** `withProgress` built its wrapper with
`Object.create(provider, {...})`: the wrapper's prototype is the instance, so `this` inside a forwarded method is
the _wrapper_, and JavaScript checks private-field access against the receiver. `reset()` therefore threw
`Receiver must be an instance of class CortexProductProvider` on the first question — **after** the corpus had
been embedded and one question paid for. The trick was correct for exactly as long as every wrapped provider was
a plain object, which is what the drivers are and what the product is not.

The wrapper now lives in `tools/progress-wrap.mjs` and delegates: it holds the provider and forwards, so `this`
is the real object. Its two value-carrying members are getters rather than copies, because `usage` read at
construction reports the corpus build and none of the answers — the direction that makes an arm look cheap.

`test_progress_wrap.py` is the guard, and it is written against the shape rather than the symptom: a provider
with `#private` state is driven through `ingest`, `answer`, two `reset`s and a `search`, and the assertions are
that the counter is live after it moves, that `search` still exists on a self-answering arm, and that no driver
manifest was invented for an in-process provider. The failure is reproducible in one line — `Object.create` a
product provider and call `reset` — which is what makes the guard a test rather than a comment.

Two things follow for how this campaign reads a failed dispatch. The dispatch spent an embedding pass and one
question's model call before it died, and the artifact said so: the progress lines carried the question number,
which is the reporting repair `45002769709` bought. And neither defect would have been visible in a score — the
first would have printed a cost of zero, the second would have printed nothing at all.

### 12.9 The arm was reading every question through one route, and the table did not say so

Run `45090697310` was the first dispatch to return a number for the shipped arm: **76.7% (23/30)** against
`lexical-reference`'s 70.0%, paired +6/−4, `p = 0.7539`. Two other numbers in the same artifact said the row was
not the registered arm.

| reading | `45090697310` | the registered arm | what the difference means |
| --- | ---: | ---: | --- |
| own prompt tokens per question | **10,780** | 7,448 | every question spent the widest room in the product |
| `ABS` | **3/6** | 6/6 on every prior reading | the abstention contract was not applied |

Both are one fact. `CortexProductProvider.answer` called `askStored`, which delegates to `answerSessions` — the
multi-session route, 48,460 characters wide against the other routes' 24,000. That is the right call for a stored
corpus asked a generic question. It is the wrong call for a benchmark: the registered arm's readings are taken
through `benchmark.ts`'s dispatch, which sends `MR` to `answerSessions`, `TR` to `answerTemporal`, `ABS` to
`answerAbstention`, `single-session-assistant` to `answerAssistant`, `knowledge-update` to `answerKnowledgeUpdate`
and everything else down the flat path. Two thirds of that row was a different system wearing the registered arm's
name, and no score could have said so — a percentage is the same whether it was bought from one room or six.

The two dispatch keys now travel with the question (`capability`, `questionType` on `SearchOptions` and
`ProviderSearchOptions`), and the arm restates the six-row table in the same order because the order is
load-bearing: an `ABS` question can carry `single-session-assistant`, and the abstention branch has to win. The
table cannot be imported — `benchmark.ts` lives in `cortex-eval`, which depends on `cortex-memory` and not the
reverse — so it is restated and pinned: `lastRoute()` reports which branch the product entered, and
`product-provider-route.test.ts` asserts all six plus the two absences.

Run `45096017960` is the same thirty questions after that fix.

| arm | accuracy | own spend per question | calls |
| --- | ---: | ---: | ---: |
| `lexical-reference` | 66.7% (20/30) | — (no model) | 0 |
| `cortex-product` | **80.0% (24/30)** | **6,110 prompt** / 6,180 with completion | 30 |

| capability | `lexical-reference` | `cortex-product` |
| --- | ---: | ---: |
| `ABS` | 6/6 | **6/6** (was 3/6) |
| `IE` | 2/6 | 4/6 |
| `KU` | 5/6 | 5/6 |
| `MR` | 4/6 | 4/6 |
| `TR` | 3/6 | 5/6 |

Three criteria were registered before the dispatch. Two pass and one does not, and the one that does not is about
sample size rather than about the arm:

| # | criterion | threshold | reading | verdict |
| --- | --- | --- | --- | --- |
| 1 | own prompt tokens per question | 5.2k–9.7k (7,448 ± 30%) | 6,110 | **pass** |
| 2 | accuracy | ≥ 75% (91.25 − 2σ at n=30) | 80.0% | **pass** |
| 3 | paired against `lexical-reference` | `p < 0.05` | `p = 0.2188` (+5/−1) | **fail** |

Criterion 3 cannot pass at n=30 and that was predictable: six discordant pairs is the most a thirty-question sample
can produce, and five-to-one is `p = 0.22`. At n=100 the same rates give roughly 17 to 3, which is `p ≈ 0.003`, so
the next dispatch is a hundred questions rather than a different mechanism.

**A cost caveat, because the first version of this paragraph got it wrong.** It said the hundred questions cost only
the product arm's calls, "because the other arm in the pair declares `build=none` and spends nothing". `build=none`
says that arm builds no index; it does not say it is free. `lexical-reference` is `answerer: shared`, so the shared
reader answered its hundred questions and the judge graded them — two more model calls per question that this
dispatch paid for and whose spend is **not** in the artifact, because the metering proxy only sees the product arm's
labelled calls (`sut-llm-calls.jsonl` holds exactly 100 rows, all `cortex-product/answer`) and the workflow's
`Cost and accuracy` step was skipped. What can be priced from the artifact is the arm's own calls: 614,684 prompt
plus 7,229 completion tokens, which at the rate the thirty-question run's ledger implies (¥0.235 for 323,393 tokens,
≈¥0.73/M blended) is **≈¥0.45**. The reader's and judge's share is unmeasured here rather than zero, which is the
same distinction `usage: null` makes in the table.

**What the two thirty-question runs also show is that n=30 cannot resolve five points even for a model-free arm.**
`lexical-reference` is deterministic: no model, no judge, a fixed sample. It read 21/30 on the first dispatch and
20/30 on the second, and the two artifacts agree on which question moved (`0bc8ad92`, `TR`), with `found = true` in
both — so the arm retrieved the same evidence twice and the *reader* graded it differently. Reading is where the
churn is, at temperature 0, one question in thirty. That is the floor under every paired comparison in this
campaign, and it is why a threshold written on accuracy alone at small n would be a coin with a decimal point.

#### 12.9.1 Four cells in the table were about a run that did not happen

The same artifact printed, under its own table:

```
provider            build  recall@k  all-gold  mrr     acc      by    llm/q   ~tok    unmeasurable
cortex-product      embedding—         —         —       79.0% (79/100)self  6219    0       0

ABS   0/6 a6/6    IE   0/6 a4/6    KU   0/6 a5/6    MR   0/6 a4/6    TR   0/6 a5/6
configuration: k=10, mode=isolated, reader/judge=none
comparability(identical): A
```

Four claims, none of them true of the run that produced it. The three columns to the right of `acc` in the row are
`—`, `6219`, `0`; the two to the left are already dashes, which is what makes the fourth one visible as an
omission rather than as a decision.

**`0/6`** is `found/measured`, and `found` is zero by construction for a system with no ranked-list endpoint: the
product's `search` returns `[]` because its retrieval *is* its navigation. The cell therefore said "found nothing"
five times about an arm that answered 24 of 30. The table thirty lines above already refuses this for its own
recall columns — `score.answerer === 'self' ? '—' : pct(score.recallAtK)` — with the reason written beside it; the
capability block was added later and the argument did not travel with it.

**`~tok` = `0`** is the same omission one column over. The field is `meanContextChars / 4`, derived from the hits an
arm returns, and a self-answering arm returns none — so it computed zero. But `null-floor` also computes zero, and
*that* zero is the measurement: it searched and found nothing. The two had the same rendering, one column apart from
a `llm/q` of 6,219 that says the arm did deliver a context, to itself, and paid for it.

**`reader/judge=none`** was a literal. The run's own JSON says `reader: deepseek-chat (chain-of-note/con, temp=0,
one request)` and the same for the judge, because reading is what the stage does. A reader quoting that footer
would describe a retrieval-only table.

**`comparability(identical): A`** came from `comparability(config, config)`. A value compared with itself cannot
differ, so the grade could only ever be `A`: a guard whose failure branch is unreachable, printed as a measurement.

All four are now one module with a seam (`tools/report-render.mjs`) and ten assertions
(`test_report_render.py`), because a printer that can only be exercised by a paid run is a printer nobody checks.
The footer states the reader and judge that ran, and what the reading stage adds over a retrieval-only run of the
same arms (`reader, judge, judgePolicy`) — a fact about two configurations rather than a value compared with itself.

The lesson is the one this campaign keeps relearning in a new costume: **the score was accurate and the table was
not.** A row that reads 79% while its detail block reads `0/6`, with a delivered context of zero beside a bill of
6,219 tokens, is a table a careful reader distrusts and a careless one quotes.

#### 12.9.2 The hundred-question dispatch: the third criterion, and the one family that is now the weakest

Run `45097142584` is the same pipeline at n=100, `con` prompt only, dispatched for the power the third criterion
needed. The `calls` column below is the product arm's own — the only channel the metering proxy sees — and the
shared reader and judge were paid per question as well (see the cost caveat above: their share is unmeasured here,
not zero).

| arm | accuracy | prompt/q | total/q | calls |
| --- | ---: | ---: | ---: | ---: |
| `lexical-reference` | 66.0% (66/100) | — (no model) | — | 0 |
| `cortex-product` | **79.0% (79/100)** | **6,147** | 6,219 | 100 |

| capability | `lexical-reference` | `cortex-product` | Δ |
| --- | ---: | ---: | ---: |
| `ABS` | 19/20 | **20/20** | +1 |
| `IE` | 9/20 | **14/20** | +5 |
| `KU` | 17/20 | **19/20** | +2 |
| `MR` | 12/20 | **14/20** | +2 |
| `TR` | 9/20 | **12/20** | +3 |

Paired, the two arms disagree on 27 of 100 questions and the product wins twenty of them:

```
baseline->treatment                 n     +     -     delta    p         verdict
lexical-reference->cortex-product   100   20    7     13.0%    0.0192    improved
```

All three pre-registered criteria now pass, and the third only passed because the sample grew:

| # | criterion | threshold | n=30 | n=100 | verdict |
| --- | --- | --- | ---: | ---: | --- |
| 1 | own prompt tokens per question | 5.2k–9.7k | 6,110 | **6,147** | pass |
| 2 | accuracy | ≥ 75% | 80.0% | **79.0%** | pass |
| 3 | paired against `lexical-reference` | `p < 0.05` | 0.2188 | **0.0192** | pass |

**The row that moved is `TR`.** At n=30 the product read `TR` 5/6 and `lexical-reference` 3/6; at n=100 it is 12/20
against 9/20 — the smallest margin of any family, and 60% is now the product's weakest reading while `ABS` is perfect.
That is the opposite of the shape the 500-question registered arm reports (`TR` 115+/127, `ABS` 30/30), so the first
hypothesis is sampling rather than regression: twenty questions per family, one question of reader churn, and the
sample is stratified rather than drawn. The registered arm's per-capability numbers on 500 questions are the ones to
compare against, and the honest statement here is that this sample is too small to place `TR` — not that `TR` moved.

What this does not say: that the product arm beats the registered arm, or that 79% is a SOTA number. The registered
arm's 91.25% is 500 questions with four repeats; this is 100 questions, one repeat, and the arm it beats is a
model-free floor whose purpose is to establish that the pipeline can score at all. What it does say is the thing
that was unmeasured until this round: **the shipped arm, answering through its own six routes, is 13.0 points above
that floor with `p = 0.0192`, and it spends 6,147 prompt tokens per question against the registered arm's 7,448.**

### 12.10 The turn window: five criteria read, one criterion falsified, and an instrument that lied

Run `45100881559` is the `turnWindow: 'match'` dispatch `PREREGISTRATION-TURN-WINDOW-MATCH.md` §7 registered:
500 questions × 4 repetitions, `cortex_memory_max_turn_chars = 400::match` the only departure, **14.26 CNY**
projected. Two hours of wall clock, 15,649 calls, **zero retries and zero `429`s** — the quota latch never had to
fire, so this is the first 500×4 run since the Zhipu exhaustion that finished on the mechanism rather than on the
provider.

#### 12.10.1 The six criteria, read against what was written before the dispatch

| # | criterion | threshold | reading | verdict |
| --- | --- | --- | --- | --- |
| B1 | the window reached the routes it claims | every `MR`/`TR` prompt digest differs | **121/121 and 127/127 differ** | **pass** |
| B2 | it did not cross into `IE`/`KU`/`ABS` | unchanged | 2 of 252 differ (see 12.10.3) | **fail, 2 questions** |
| B3 | `MR` gold turns cut falls | 13.4% → **< 5%** | **13.10%** under a valid definition | **fail** |
| B4 | `MR` accuracy | mean ≥ 105.25 and question-level `up − down ≥ +4` | 106.5; **+4** (9 up, 5 down) | **pass, at the threshold** |
| B5 | `TR` not worse | mean ≥ 118.25 | **119.8** | **pass** |
| B6 | cost | ≤ 7,822 prompt tokens per question | **7,456.7** | **pass** |

| arm | accuracy, all runs | accuracy, first repetition | prompt tokens per question |
| --- | ---: | ---: | ---: |
| `44017278305` (`turnWindow: 'head'`) | 91.25% | 91.20% | 7,447.8 |
| `45100881559` (`turnWindow: 'match'`) | **91.90%** (min 91.40, max 92.40) | **92.00%** | **7,456.7** |

Paired on the first repetition: 15 bought, 11 sold, net **+4 of 500**, `p = 0.557`. Overall the arm is **+0.65
points** on all-runs and **+0.80** on the first repetition — both at or under the **0.70-point cross-dispatch
floor** §3 states, which is why the criteria were written per capability and not on the total.

#### 12.10.2 B3 fails, and the 5.95% that looked like a near miss was the instrument

The first read of B3 came from `--goldcut` as it was written, which classified a gold turn as `cut` when the
prompt still held its **beginning** and not its tail:

| | `head` | `match` | reading |
| --- | ---: | ---: | --- |
| `MR` whole | 1,557 | 1,559 | **+2 gold turns delivered whole** |
| `MR` "cut" | 245 | **109** | ↓ 13.37% → **5.95%** |
| `MR` absent | 30 | **164** | ↑ 5.5× |

`5.95%` is under the threshold of a looser reading and above 5%, but the honest reading of that row is not "near
miss". `whole` moved by **two turns**. The rate fell because 134 truncated turns stopped having a head: the
`match` window keeps the slice **around the question's match** and drops both ends, so a prefix test scores them
`absent` — the bucket reserved for turns the prompt never carried, which is a *selection* result. The classifier
changed which bucket a turn fell into; the prompt did not deliver more of anything.

That is the same defect class as §12.9.1's four table cells, one level down: **a measurement whose answer depends
on a property the treatment deliberately changes**. The fix is not a threshold. `--goldcut` now asks the question
that does not depend on *where* the kept slice is — is a 120-character stretch present anywhere, by an exact
n·gram set rather than a probe at three offsets — and reports three states:

| capability | gold turns | whole | partial | absent | whole% | whole%, `head` | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `MR` | 1,832 | **1,559** | 240 | 33 | **85.10%** | 84.99% | **+0.11** |
| `TR` | 1,615 | **1,147** | 245 | 223 | **71.02%** | 70.22% | **+0.80** |
| `IE` | 1,709 | 998 | 11 | 700 | 58.40% | 58.34% | +0.06 |
| `KU` | 1,688 | 845 | 19 | 824 | 50.06% | 50.06% | 0.00 |
| `ABS` | 672 | 239 | 4 | 429 | 35.57% | 35.57% | 0.00 |
| **total** | 7,516 | **4,788** | 519 | 2,209 | **63.70%** | 63.49% | **+0.21** |

Under the definition that can see a middle slice, the baseline's own number is **unchanged** (13.37% → 13.10% is
the treatment's movement, not the fix's): the fix restores the baseline rather than moving the threshold to meet
the code, which is the rule `ACCEPTANCE-MATRIX.md` §6 states. **B3 as registered therefore fails at 13.10%
against `< 5%`, and it does not fail narrowly.** The window recovers **16 gold turns out of 7,516** — 0.21%.

#### 12.10.3 P1 is falsified, and that is the more useful result

§4 predicted that a real effect would **concentrate on the questions that are wrong every time**, rather than
spread over the rest. The paired baseline's always-wrong population is 33 questions of 500 (wrong in all four
repetitions); the baseline gets 44 wrong on its first repetition, so 75% of any uniform movement over
first-repetition-wrong questions should land in the 33.

| | count |
| --- | ---: |
| questions bought (wrong → right) | 15 |
| of those, on an always-wrong question | **9 (60%)** |
| of those, on a question the baseline sometimes got | 6 (40%) |
| questions sold (right → wrong) | 11 |
| of those, on an always-wrong question | **0** |

60% against a 75% base rate is not concentration; it is mild dilution. **P1 is falsified**, and the carriage
reading says the same thing from the other side. Holding the population fixed at the paired baseline's 33
always-wrong questions -- *not* at each run's own set, which differs because the treatment moves questions into
and out of it -- the +16 gold turns split **+1 there and +15 among the other 467**:

| population (fixed at `44017278305`) | questions | `whole`, `head` | `whole`, `match` | Δ turns |
| --- | ---: | ---: | ---: | ---: |
| always wrong (0/4) | 33 | 324/555 = 58.38% | **325/555 = 58.56%** | **+1** |
| everything else | 467 | 4,448/6,961 = 63.90% | **4,463/6,961 = 64.11%** | **+15** |

That table is also a correction of this section's own first draft, which compared each run's own always-wrong
group and read the treatment as having made things worse (58.38% → 57.32%). The two groups are not the same
population -- the `match` run has 28 always-wrong questions, not 33 -- so that comparison was between two
different sets wearing one label, which is the error `--goldcut`'s outcome table exists to prevent one level up.

So the three readings agree with each other and disagree with the mechanism's story: the window changes every
prompt on the two routes it reaches, delivers **+16 gold turns** in total, moves accuracy by **+4 of 500**
(`p = 0.557`), and does **not** concentrate where the hypothesis said it would. What it demonstrably does is
change *which* part of a long turn is visible — which helps some questions and hurts others at roughly the same
rate.

#### 12.10.4 What §3.1 says to do, and what was done

The consequence table is unambiguous: **B3 fails → the run is void, fix the implementation, and do not interpret
the accuracy.** No default was flipped. `turnWindow` stays absent, which is `'head'`, which is the arm every
published number was taken under. The 91.90% is recorded here as a reading and **not** adopted as a registration.

Three things the next dispatch should carry, in the order the evidence supports them:

1. **`MR`'s remaining 14.5 wrong per run (121 − 106.5) are not a truncation problem.** The window delivered
   **one** gold turn to the 33 always-wrong questions, so the next hypothesis about them cannot be "the evidence
   was cut". The measured shape — 121 questions, 33 wrong in all four repetitions — is the population
   `MEASURE-MR-CEILING.md` calls membership failures, and the aggregation candidates remain the only untested
   family there.
2. **`TR` is where the window actually delivered** (+13 gold turns, 70.22% → 71.02%, accuracy 120 → 121 of 127 on
   the first repetition, mean 119.8). If the window is to be pursued at all, it is as a `temporal`-only reach,
   which the preregistration's own last row already allows for — and that needs a route axis on `turnWindow`,
   which does not exist yet and would be a new mechanism with its own registration.
3. **The two control-route prompts that changed** (`0862e8bf_abs` on `abstention`, `ac031881` on `assistant`,
   −214 and +295 characters, identical turn counts and identical routes) cannot be the window: `buildSessionPrompt`
   is reached only from `answerSessions`. The next run should say what they are before B2 is read again, because
   a reach criterion that fails for an unexplained reason is not a criterion.
