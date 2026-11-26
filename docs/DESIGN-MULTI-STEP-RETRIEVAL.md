# Design: multi-step retrieval (`@agentix-e/cortex-ai/agent`)

**Status:** built, unit-measured, and the probe **has been dispatched and read back** (`44867629266`:
`gainedQuestions` 105 of 121). The judged ablation is **not scheduled**, and §6.1 is why: the ceiling of
the whole evidence axis has since been measured, and this mechanism lives inside it. This document used
to say "not yet dispatched"; that sentence was true when it was written and stopped being true at §149.

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
   question ───▶ │  cortex-ai/agent          │
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
3. **The subpath depends on nothing but `cortex-core`.** `LLM` is `cortex-core`'s interface; the
   application constructs `OpenAICompatibleLLM`, a local model or its own implementation. Plan
   §14.98.3 listed an adapter package as a dependency and that was the first deviation; the renderer
   was the second. The loop now takes a `Renderer<Config>` seam, so it imports neither a provider nor
   a renderer.

Dependency direction: `cortex-ai/agent → cortex-core`, and nothing else. The corpus and the renderer
are interfaces the caller fills, which is why `cortex-ai` gains no edge to `cortex-memory` and
`cortex-memory` gains none to the loop. The seam is not a style preference: it is what keeps the
equivalence "this selection, through the registered renderer, is the registered prompt" a statement
about the object a caller passes rather than about a package name.

**Why this is a subpath and not its own package.** It was one
(`@agentix-e/cortex-agent`). The merge was decided by a measurement rather than a taste: in the 11
commits that touched either tree, **zero** touched both, so the two packages had no shared change
surface -- while the one edge that did exist (renderer) was structural and got removed instead of
being housed. A subpath keeps that separation visible to a reader (`cortex-ai`'s root is still "how to
reach a model") without paying a package's worth of manifests for 1,159 lines that depend on one
interface.

### 2.1 The entry that did not exist, and the probe that measured a different index

`PREREGISTRATION-MULTI-STEP.md` §2 named one product change as the precondition for measuring this
mechanism: a public method on `CortexMemory` that answers "the turns this memory would show for a
query". It was not built. The loop was, the probe was, the ablation arm was not — and every probe run
therefore built a `new SearchIndex()` over the same turns inside
`packages/cortex-memory/bench/probe-multi-step.ts`.

That is a measurement of a **different object**, and the difference is not cosmetic: the arm ranks
with `self-index`, whose channel set is lexical **and** vector, while the probe's index is lexical
only. §6.1's reading — 118 of 121 questions where the reader's action added evidence — is therefore a
reading about a lexical retriever, and this document said so in the probe's own docstring ("adding one
here would make the probe's numbers a property of an embedder") without saying the consequence: the
numbers are a property of a **weaker** retriever instead.

`CortexMemory.search(query, context, { k })` now exists. It spends `rankedCandidates` — the comparator
`selectByRelevance` spends the room on — reads the write gate, returns `context` positions rather than
filtered ones, and folds its index build into `indexCost()` while leaving the per-question census slots
to whichever answer owns them. `search.test.ts` pins the order, the ids, the refusal cases, and the
import that keeps one comparator rather than two.

Three things follow, and none of them is a re-reading of §6.1:

1. **The 118/121 stands as what it is** — a lexical-retriever reading, taken before the entry existed.
   It is not retracted and it is not the product's number.
2. **The next probe run should pass `memory.search`** through `indexRetrieval`'s structural seam, with
   the arm's own `index` configured. Staying lexical survives as an explicit choice rather than as the
   only one available, which is the difference between a declared deviation and a missing capability.
3. **The judged ablation is still not scheduled**, for the reason §6.1 gives: 18 of 22 stable `MR`
   failures already had their numeric gold in the prompt, so more gold is more enumeration. The entry
   was a precondition for measuring the mechanism honestly, not evidence that measuring it would win.

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
inputs, and an artifact that carries the corpus digest beside the reading.

That workflow deliberately does **not** re-run the test suite, and the two dispatches it cost to learn
that are recorded in the file. The suite needs pytest and a checkout of the sibling `cortex-docs`
repository, both of which `verify.yml` provides and a measuring job reproduces wrongly; each omission
killed a dispatch before the probe started. `Verify` runs on every push, so the commit being measured
already has a verdict -- and `tools/dispatch-multi-step-probe.py` reads it and refuses to dispatch
unless it is `success`. Provenance belongs at the point where money is spent, not inside the job that
spends it: a refusal there is free, and a duplicated suite is a second thing that can be wrong.

### 6.1 The reading, and what it did not license

| reading (`maxSteps 1`, `MR`, 121 questions, DeepSeek reader) | value |
| --- | ---: |
| decision calls / questions that wrote a query | 121 / 106 |
| questions where the reader's action added evidence | 118 |
| gold turns the seed retrieval did not have (`newGold`) | **586 turns / 105 questions** |
| gold in the prompt, seed → selected → carried | 862 → 1448 → 1377 |
| selected then dropped by the room (`foundNotCarried`) | 71 |
| decision prompt, actual cost | 4,141 chars/question, ≈0.28 CNY |

The cancel condition (`gainedQuestions ≤ 2`) is dead: the seed retrieval does miss gold, and the prompt
that reaches the reader carries 1.68× more of it. **That is the whole of what the probe bought**, and it
is less than the table above §6 originally promised, for three reasons that are separate facts:

1. **`newGold` is not the gold the failing answers needed.** `AUDIT-MR-ENUMERATION.md` §3 measured the
   complementary quantity: of 22 stable `MR` failures, **18 already had their numeric gold in the
   prompt**, median best rank 0, and 22/22 answers equalled the row count of step 1. More gold in a
   prompt whose reader already fails to enumerate it is more enumeration. The two readings are about
   different quantities and cannot corroborate each other -- §149.3.1 says so in the same words.
2. **A new set is not a filtered set.** 586 added gold turns arrive with their non-gold neighbours, and
   "more evidence = more noise" is the only risk this arm carries. That is precisely why it would need a
   paired judged reading rather than the probe.
3. **The evidence axis has a measured ceiling, and it is one point.** The oracle-evidence condition --
   same reader, judge, prompt, protocol, 500 questions, four repetitions, run twice with 491/500
   agreement -- reads **92.90%** against the registered configuration's **91.90%**. `C − S = 5
   questions = 1.00 point`, exact McNemar `p = 0.44`. Every mechanism that changes *which turns are in
   the prompt* is bounded by the state where the prompt holds the gold evidence. That state has been
   measured, and it is worth one point. The `MR` cell is 121 of 500 questions, so the pre-registration's
   own success threshold (+3 questions on `MR`) is **+0.6 points on the headline** -- against a 4.35-point
   gap that sits inside a ±3.21-point judge band. **No outcome of this ablation, including full success,
   moves the SOTA verdict.** That is the reason it is not scheduled, and it is a stronger reason than
   cost: 14 CNY would buy a confirmation of a bound, not a decision.

What would revive it, stated so the decision can be reversed by evidence rather than by mood: (a) an
oracle re-measurement that reads materially above 92.90%, which moves the bound; (b) the `MR` cell
becoming the target on its own terms rather than as a contribution to the headline; (c) a product
requirement for this subpath that a 121-question reading would satisfy -- and in that case the wiring,
not the money, is the prerequisite: `multiStep` is still absent from `cortex-eval`'s arm, and `S18` is no
longer a free id (query expansion took it).

## 7. What is not here

- **No answering.** The loop decides what to read; the answer prompt is composed afterwards. A loop
  that wrote its own prompt would be a second rendering path.
- **No oracle.** Gold turns are used by the probe to read the result, never by the loop. Nothing in
  `loop.ts`'s import closure can reach `goldTurns`.
- **No provider adapter, no vector channel, no cross-encoder.** All three are injections the caller
  owns; the loop is the same code with or without them.
