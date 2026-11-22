# Racing three competitors on one model, and what the first attempts already refuted

**The instruction this answers.** Run Mastra, Mem0 and MemCog with the same LLM Cortex reads with, compare accuracy
and cost, and decide from the numbers which mechanism is worth copying. This file records the machinery that makes
that a configuration, the four facts it established before any score existed, and the arithmetic that says what a
full run costs.

## 1. "The same LLM" has to be a base URL, because three of the four positions are invisible

Cortex's reader and judge are DeepSeek. That is one position. The other three are inside the competitors:

| system | where a model is called | published number depends on it |
| --- | --- | --- |
| Cortex | reader (one call per question) | no — retrieval-only |
| Mem0 | extraction at ingest (`infer=1`), one call per turn | **yes** — the 94.4 configuration uses it |
| MemCog | store build (5 steps) **and** navigation (2–7 turns per question) | **yes** — 95.80 is the whole loop |
| Mastra | answering agent, Observer, Reflector | **yes** — 84.23 vs 94.87 is the reader alone |

So a run that sets only `DEEPSEEK_MODEL` compares Cortex-with-DeepSeek against three systems on their own defaults,
which for Mastra is `'auto'` — a Google Gemini default when a Google key happens to be present. The fix is not a
promise in a README, it is `tools/competitor-sut/sut_llm_proxy.py`: every driver's `base_url` points at it, it
forwards to DeepSeek, and it reads `usage` out of the response.

Consequences, all of which are asserted in `tools/__tests__/test_sut_llm_proxy.py`:

* the request and the response are forwarded **byte for byte** — the system under test is parsing them;
* `prompt_tokens` comes from the parts, not from `total_tokens` plus a part, which is a double count;
* `X-Sut-Label` splits the bill by phase, so "MemCog cost 1.4M tokens" becomes "1.2M building the store, 0.2M
  answering";
* the counters are per model, so a silent fallback shows as two rows instead of one average;
* `stream: true` is **forwarded** and settled from the final frame — see §3 for why the first version was wrong.

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

* the shared reader does **not** run for a `self` provider, asserted with a reader that throws rather than one that
  records (a harness that called both would still produce a plausible answer from the shared side);
* the judge **does** run, so accuracy stays comparable;
* `ProviderScore.answerer` records `shared` / `self` / `none`, and the table prints `—` for a `self` row's recall
  columns instead of `0.0%` (it has no ranked list, so a zero would be a false claim);
* `ProviderScore.usage` carries the system's own spend; `null` is "not measured", not free.

The reason this matters numerically is Mastra's own ablation: **84.23 → 94.87** for the same memory with a different
reader. A table that put a `self` row beside a `shared` row and let a reader subtract them would be inviting exactly
that 10.64-point error.

## 5. What a full run costs, before it is dispatched

Measured on the local stand-in, not on the corpus: a 120-turn transcript (≈36k tokens) produced **9 model calls** in
one question — 8 observation/reflection cycles plus the answer — and took **4m10s**. LongMemEval-S is ~550 turns per
question, so the naive extrapolation is 5–15 minutes per question for Mastra alone.

| arm | calls per question | tokens per question (estimated) | 100 questions | 500 questions |
| --- | ---: | ---: | ---: | ---: |
| Cortex (retrieval only) | 1 reader + 1 judge | ~7.4k context + judge | ≈ 1.5M | ≈ 7.5M |
| Mem0 `infer=1` | ~550 extraction + 2 | ~1.6M | ≈ 165M | ≈ 820M |
| MemCog | ~50 build + ~4 navigate | ~200k | ≈ 20M | ≈ 100M |
| Mastra OM | ~8 observe + 1 answer | ~36k | ≈ 3.6M | ≈ 18M |

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

* MemCog at 100 questions on DeepSeek against Cortex at the same 100 questions and the same judge — if the
  navigation loop is worth 3+ points, the mechanism to copy is *navigable structure with tool calls*, and
  `DESIGN-MULTI-STEP-RETRIEVAL.md` already has the registration for it;
* Mastra at the same — if observational memory at 30k thresholds beats Cortex, the mechanism is *compression instead
  of retrieval*, which this repository has never tested (`[thing 3]` in the ledger is its nearest relative);
* Mem0 at `infer=1` against Mem0 at `infer=0` — the extraction ablation is free once the arm exists, and it is the
  one measurement that says whether fact extraction buys anything at all on this corpus.

A competitor that loses still answers a question, and that is the point of running their code rather than reading
their table: the four facts in §2–§3 above were all obtained before a single question was scored.
