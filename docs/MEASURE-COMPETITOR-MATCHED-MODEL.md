# Racing three competitors on one model, and what the first attempts already refuted

**The instruction this answers.** Run Mastra, Mem0 and MemCog with the same LLM Cortex reads with, compare accuracy
and cost, and decide from the numbers which mechanism is worth copying. This file records the machinery that makes
that a configuration, the four facts it established before any score existed, and the arithmetic that says what a
full run costs.

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

A competitor that loses still answers a question, and that is the point of running their code rather than reading
their table: the four facts in §2–§3 above were all obtained before a single question was scored.

## 7. What the arms measured, and what two of them cost

Two dispatches produced numbers under the same judge and the same model, on the same sampled questions. Both are
small — 30 questions for Mastra, 2 for Mem0's first pass — and every figure below carries its `n`, because a 30-question
difference of two questions is a coin.

| arm                              |   n |          accuracy |            calls/q | prompt tok/q | ¥/q (list) | what its context is                          |
| -------------------------------- | --: | ----------------: | -----------------: | -----------: | ---------: | -------------------------------------------- |
| `mastra` (self-answering)        |  30 | **70.0%** (21/30) |                2.0 |      125,104 |      0.273 | its own generator, observations + transcript |
| `cortex-session` (shared reader) |  30 |     63.3% (19/30) | 1 reader + 1 judge |       33,270 |      0.067 | whole sessions, budget 8 turns               |
| `lexical-reference` (shared)     |  30 |     63.3% (19/30) |              1 + 1 |       34,974 |      0.070 | lexical top-k over the same sessions         |
| `cortex/trim-2.8k` (shared)      |  30 |     56.7% (17/30) |              1 + 1 |        2,799 |      0.006 | a 2.8k-character window                      |
| `mem0` `infer=1` (shared)        |   2 |       50.0% (1/2) |               51.5 |      576,772 |       1.37 | extracted facts, vector top-k                |

Per-stage cost is read from the artifacts rather than from a counter: `usage` in each `competitor-read*.json` is the
proxy's cumulative total at the moment that stage ended, so the difference between two consecutive files is that
stage's own spend, and the SUT step's spend is the remainder. That is why the same number can be quoted as a bill per
question without a second instrumentation channel to keep in agreement with the first.

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

## 8. Two defects the dispatching found, and what they had in common

Neither is about a competitor. Both are about a run that reports something it did not measure.

**A crashed harness was a green step with an empty file.** Nine measurement steps piped `node ... | tee artifact`,
and a pipeline reports the exit status of its last command. Run 45011910491 therefore finished _successfully_ with a
zero-byte reading table and a cost report reading `the reading stage wrote no json`. The harness had died at import,
before its first line of output. `set -o pipefail` is now on every one of those steps; the same class of failure on a
later dispatch shows up as a red X instead of a silent success, which is how the second defect below was found.

**A store path whose parent no step created.** `MASTRA_STORE` named `<workspace>/.cache/mastra/store.db` in the three
reading steps and in neither of the steps that ingest. The ingest therefore used the driver's `/tmp` default, no step
created `.cache/mastra/`, and libsql answered the reading stages with
`ConnectionFailed("Unable to open connection to local database ...: 14")` — SQLITE_CANTOPEN, which reads like a
permissions or corruption problem and is neither. The variables that address the model, the proxy and the two stores
now live in the job's `env` rather than in per-step copies, the driver creates the parent of the path it is handed,
and the live round-trip test passes it a path whose parent does not exist.

A third, smaller one belongs here for the same reason: Mem0's DeepSeek factory builds an `OpenAI` client whether or
not the model is reachable, and the retrieval stage does not carry `DEEPSEEK_API_KEY`, so the driver handed it `""`
and died with `Missing credentials`. Nothing on that path reads the client's credential — the proxy replaces
`Authorization` with its own upstream key. A loopback base URL now gets an explicit `proxied` placeholder, the
manifest records which placeholder was used, and any other URL still gets nothing.

## 9. What this says to copy, and what it says not to

| system         | what it actually does, as measured here                                                                                          | verdict for Cortex                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mastra OM      | 2 calls/question, the answering one at 112k median tokens: full context with an observation log attached                         | **Copy the budget, not the mechanism.** The +6.7 points are context volume; `maxPromptCharsByRoute` is the cheaper lever, and the experiment to run is a window sweep, not an Observer                                                                                                                                                                                            |
| Mem0 `infer=1` | 51.5 calls and 577k prompt tokens per question — five times the haystack — to turn sessions into facts, then lose both questions | **Do not copy the extraction.** It is the most expensive context in the table by two orders of magnitude; the `infer=0` ablation is the cheap control that says whether extraction itself or only its price is the problem                                                                                                                                                        |
| MemCog         | a store built by the model — 1,198 calls and 2.15M prompt tokens in 36 minutes, ending with no answer at all                     | **Copy the interface, not the build.** Navigable pages plus two tools plus a bounded number of rounds is a smaller change than it looks (`DESIGN-MULTI-STEP-RETRIEVAL.md`); what its build costs per question is being measured with per-question labels, because the first ledger had one label for the whole 36 minutes and could not say whether that was one question or five |

The one thing none of the three demonstrates is a mechanism that beats Cortex's own window _at the same context
budget_. That is the experiment the next round should run: fix the reader input at 33k tokens for every arm, and see
whether observations, facts or navigation beat verbatim sessions **inside** the same envelope.
