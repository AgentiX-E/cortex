# Design: multi-step retrieval (`@agentix-e/cortex-agent`)

**Status:** built, unit-measured, **not yet dispatched**. The mechanism is in the published package
and documented in the user manual (§6.14); what is missing is one dispatch, and it is deliberately
behind a cheaper reading (§6 below).

---

## 1. The problem this exists for

Every reading this campaign has taken retrieves **once**. A ranking is produced from the question, a
window is filled from that ranking, and the model reads a fixed list. `AUDIT-MR-ENUMERATION.md` records
what that costs on the multi-session population:

| reading | value | what it says |
| --- | --- | --- |
| wrong answers whose gold is already in the prompt | **22 of 22** in the first census, median best rank **0** | retrieval is not what fails |
| gold turns surfaced on the repaired order | **1,832 of 1,832**, none missing | the window does not starve the reader |
| the reference pipeline's aggregation contract, transplanted onto this window (`44835820692`) | **−3.75 questions** after removing anchor drift | the contract works where the pipeline that writes it also *chooses* the evidence |

The third row is the one this package is built on. The conclusion drawn there was an **interaction**,
not a winner: a contract and the selection that feeds it are one mechanism, and a reader enumerating a
list it did not build enumerates it worse. So the increment is not another sentence in the prompt. It
is to let the reader build the list.

## 2. Architecture

```
                 ┌───────────────────────────┐
   question ───▶ │  cortex-agent             │
                 │                           │
                 │  loop.ts ──▶ prompt.ts    │   one decision per step:
                 │    │        parse.ts      │   search / session / answer
                 │    ▼                      │
                 │  tools.ts ──▶ Retrieval   │────┐
                 │    stop.ts   trace.ts     │    │ delegates, never re-ranks
                 └───────────┬───────────────┘    │
                             │                    ▼
                    selected turn ids      cortex-memory: SearchIndex
                             │
                             ▼
                 ┌───────────────────────────┐
                 │  compose.ts               │
                 │  → cortex-memory          │   the registered renderer,
                 │    buildPrompt            │   the registered contract,
                 └───────────────────────────┘   the registered room
```

Three properties of that picture carry the design:

1. **The loop owns no corpus and no ranking.** It asks `Retrieval` for ids and hands ids back.
   Deduplication, the lexical and vector channels, rank fusion and the reranker all stay in
   `cortex-memory`'s `SearchIndex`, which is the code the registered arm runs. A loop with its own
   ranking would be a second implementation of the object every number is about.
2. **The prompt is not written here.** `composeAgentPrompt` converts the reader's order into the
   `relevanceFor` signal `buildPrompt` already understands, so the printed bytes come from the one
   renderer. Anything a dispatch measures is therefore attributable to *which* turns were chosen.
3. **The package does not depend on a provider.** `LLM` is `cortex-core`'s interface; the application
   constructs `OpenAICompatibleLLM`, a local model or its own implementation. Plan §14.98.3 listed
   `cortex-ai` as a dependency and this is the deviation: a dependency on an adapter package is a
   dependency on a provider list.

Dependency direction, unchanged at the bottom: `cortex-agent → {cortex-core, cortex-memory}`;
`cortex-memory ↛ cortex-agent`. No cycle exists, which is what makes the agent an *addition* rather
than a rewrite of the measured path.

## 3. The protocol

One call per decision. The reader is shown the question and a **digest** — one line per held turn, an
id and a prefix — and answers with exactly one JSON object:

| action | meaning | what the loop does |
| --- | --- | --- |
| `{"action":"search","query":"…"}` | look for more | `Retrieval.search`, `k` bounded |
| `{"action":"session","turn":N}` | open the conversation around a turn | `Retrieval.session(N)` |
| `{"action":"answer"}` | the evidence is enough | stop |

The schema is forwarded as `response_format: json_object` in the request body and is never pasted into
the prompt, so `AgentTrace.promptChars` is exactly what the provider received. Temperature is zero:
the output is a decision, and two dispatches should differ because the questions differ.

## 4. Cost model

A step costs one call whose prompt is the question plus the digest, not the evidence. Defaults:
`k = 16`, `digestChars = 200`, `digestTurns = 32`, `budgetChars = 40,000`, `decisionTokens = 512`.

`maxSteps` counts **model calls**, not steps: the seed retrieval is free, so `maxSteps: 0` is a single
retrieval with no call at all. That is not a degenerate case — it is the control, and it is why
`AUDIT-MR-ENUMERATION.md` can compare "the mechanism on" against "the mechanism off" on one code path.

Termination is not a hope about the reader. Each iteration adds at least one character to
`promptChars`, `promptChars` is compared against a finite budget, and `calls` against `maxSteps`;
`corpus-exhausted` and `no-new-evidence` end it earlier when they apply.

## 5. Failure policy

| what went wrong | the trace says | why that is a distinct fact |
| --- | --- | --- |
| provider threw | `llm-error`, note `llm: …` | retried next dispatch; the contract is fine |
| reply was prose, a fence, or truncated | `unparsed`, note `not-json` | the contract needs changing |
| the reader wrote a blank query | `empty-query` | nothing was sent to the index |
| search returned only held ids | `no-new-evidence` | a corrective prompt would be a second call to fix the first |
| every turn is held | `corpus-exhausted` | the corpus, not the reader |

None of these throws. A run that loses one question to an unreadable reply is a reading; a run that
loses the dispatch is a morning. The evidence gathered before the failure is kept and composed.

## 6. Before spending anything: the probe

`probeMultiStep` answers the question that decides whether a two-step dispatch is worth 14 CNY:
**does a reader's own query surface gold turns the static retrieval missed?** It runs the loop over a
labelled population, composes each prompt through the registered renderer, and reports:

| reading | meaning | consequence |
| --- | --- | --- |
| `newGold = 0` | the reader found nothing the seed did not have | **cancel** the dispatch; go to a different axis |
| `newGold > 0`, `foundNotCarried > 0` | found, then dropped by the room | **widen the room first**; this is a budget question |
| `newGold > 0` and `gainedQuestions` large | the mechanism has something to buy | dispatch, per the pre-registration |

The probe calls no judge, because the question is about *where the gold is* and the dataset already
says. That is what makes it cheap rather than merely smaller: 121 decisions at roughly 1.5k prompt
characters each is about **0.09 CNY**, against the 14 CNY a judged two-step dispatch costs.

Cheap in tokens is not the same as runnable locally, and the first draft of this section conflated the
two. The probe reads a 100+ MB corpus served from a moving branch and authenticates against a model
whose key lives on a runner, so the arm that exists is `.github/workflows/probe-multi-step.yml`: four
inputs, `pnpm check` before the measurement, and an artifact that carries the corpus digest beside the
reading. `tools/dispatch-multi-step-probe.py` holds the registered configuration and prints the
projection before it spends anything. The pair exists because a pre-registration with no execution path
is an intention, which is the defect that kept this probe unrun for a round.

## 7. What is not here

- **No answering.** The loop decides what to read; the answer prompt is composed afterwards. A loop
  that wrote its own prompt would be a second rendering path.
- **No oracle.** Gold turns are used by the probe to read the result, never by the loop. Nothing in
  `loop.ts`'s import closure can reach `goldTurns`.
- **No provider adapter, no vector channel, no cross-encoder.** All three are injections the caller
  owns; the loop is the same code with or without them.
