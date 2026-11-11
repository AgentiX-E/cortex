# Audit: how far each mechanism actually reaches

**What this is.** A reach audit, not a design. For each mechanism this repository shares
with Hindsight (arXiv 2512.12818), this file records the **furthest caller** — probe, ablation,
or the scoring path itself — because "implemented" and "reaches the score" turned out to be
three different states, and every argument about what to build next depends on which one a
mechanism is in.

**Why it was written.** Round 63 produced three successive wrong readings of the same four
mechanisms in one session: first "in production and switchable", then "implemented, zero
wiring", then the measurement below. Each correction moved in the same direction — towards
"further from the score than the previous answer". The instrument that would have settled it in
one call did not exist, so this file is that instrument applied once by hand.

---

## 1. The three states, and why "orphan" does not distinguish them

`tools/export-census.mjs` answers exactly one question: does a symbol have a **non-test
caller** anywhere in the workspace? It reports 463 orphans out of 1,119 exports. It is a good
instrument and it is not the instrument this question needs, because:

> A caller is not a chain. `tools/knowledge-probe.mjs` is a non-test caller, and nothing it
> calls can move a benchmark number.

So a symbol can be, at once, **not an orphan** by the census and **nowhere near the score** in
fact. Every row below was classified by reading the call sites, not by running the census.

| state                      | test                                                  | what it licenses                      |
| -------------------------- | ----------------------------------------------------- | ------------------------------------- |
| **S1 in the scoring path** | reached from the prompt the runner sends              | a change here can move a number       |
| **S2 in a harness**        | reached by an ablation or probe with its own fixture  | a change here can be measured offline |
| **S3 declared only**       | no non-test caller, or a caller that computes nothing | a change here changes nothing yet     |

---

## 2. The four mechanisms, and where each one really stops

| Hindsight's claim                                                                      | this repository's implementation                                                                                 | furthest caller                                                                                                                                                    | state                                                                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **RRF over independent channels**, not score merging                                   | `reciprocalRankFusion` in `cortex-eval/src/retrieval.ts`                                                         | `retrieveTopKByQueriesHybrid` fuses **dense + lexical** and is called by the memory arm                                                                            | **S1** — two channels of the four                                               |
| **Conflicting facts keep both states, with timestamps**                                | `cortex-memory/src/conflict.ts` (`conflictStatements` / `renderConflicts` / `insertRelatedStatements`)           | `CortexMemory` inserts the block between evidence and question when `conflicts === true` (`memory.ts`), with `conflict-reach.test.ts` asserting the prompt changes | **S1**, and it has a reach limit on record (`MEASURE-CONFLICT-SURFACING.md` §2) |
| **Token budget instead of top-K**                                                      | `fillBudget` in `cortex-core/src/retrieval/fuse.ts`, and the render-and-measure loop in `context/assemble.ts` §5 | `assemble()` — whose only production caller is `cortex-eval/src/assumption-ablation.ts`, a synthetic fixture                                                       | **S2**                                                                          |
| **Observations: evidence-backed beliefs, refined not overwritten, with a proof count** | `knowledge/revision.ts` (`confirmed` / `refuted`, `persistence`), `knowledge/assumption.ts`                      | `reviseAssumptions` has **no caller outside its own file and its tests**                                                                                           | **S3**                                                                          |
| **Typed entity-graph channel** (the `G` in TEMPR)                                      | `retrieval/typed.ts` (`expandTyped`, `renderBlocks`, 33 tests)                                                   | `tools/knowledge-probe.mjs` prints what it reaches; `assemble.ts` imports only `renderBlocks` and `tokenEstimate`                                                  | **S2 at best** — a probe is a reading, not a chain                              |

Two rows deserve their own sentences.

**The budget row is the one that surprised me.** `assemble.ts` §5 does not merely implement a
budget; it **refuses** `fillBudget` with a stated reason — `renderBlocks` states the frame once
per block and names a relation's other end by id, so a fact's marginal cost depends on what is
already in and adding one can make the block _shorter_. A cost that is not additive cannot be
summed into a fill, so the loop renders and measures instead, O(n²) over a set in single
digits. That is a better answer than the one Hindsight ships. **It is also in S2**, which means
the better answer has never been priced against the simpler one on the real corpus.

**The typed row is the one that changes the plan.** `expandTyped` is not competing with
nothing. `conflict.ts` already occupies the slot it would fill — "find the other statements
about this question and put them in the prompt, with their dates" — and it does so with
sentence-term overlap rather than typed edges, **on the scoring path, with a measured reach
limit**. Wiring `expandTyped` is therefore not filling a gap. It is **replacing a mechanism that
has readings**, and the burden of proof is correspondingly higher: a typed edge has to beat term
overlap on the same questions, not merely exist.

---

## 3. What the audit licenses, and what it forbids

**Licensed.** One change can price four things at once. `conflict.ts` is already switchable
(`conflicts: true | false`), which is a control arm that exists today. Routing the evidence block
through `assemble()` — ledger, window, uniqueness, budget, typed relations — and reading it
against the current untyped insertion gives **one 500 × 4 dispatch, one variable, four
mechanisms priced**. Four separate dispatches would cost four times as much and would each be a
different confound.

**Forbidden.** Two claims this file will not let anyone make again:

1. _"The budget is in production."_ It is in `assemble`, and `assemble` is in an ablation.
2. _"`expandTyped` is wired, it just defaults off."_ Nothing is wired. A probe is not a chain,
   and a default is a number a caller passes, not one a test passes.

**S3 is the honest number to watch.** `reviseAssumptions` — the module whose whole job is the
thing `KU` fails at — has no caller. If the next increment is aimed at `KU`'s stale-value
questions, this is the row it should move from S3 to S1, and that is a testable claim rather
than a design preference: the register already names six stable stale-value questions and their
ceiling.

---

## 4. What this audit does not say

1. It does not say the typed channel is worthless. It says the typed channel is **unproven**, and
   that the thing it must beat is a mechanism with readings rather than an absence.
2. It does not price anything. The 500 × 4 comparison in §3 has not been dispatched.
3. It does not re-derive the reach of mechanisms outside these four. `cortex-core` exports 114
   orphans by the census; how many of those are S3 rather than S2 is unmeasured, and this file
   would be wrong to guess.
