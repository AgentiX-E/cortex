/**
 * `@agentix-e/cortex-ai/agent` -- retrieval that the reader drives.
 *
 * ## The gap this closes
 *
 * Every reading in this campaign so far selects evidence **once**, before the model is consulted,
 * and then hands the model a fixed list. §14.97.8 measured what that costs when the list is
 * supposed to be enumerated: the reference pipeline's aggregation contract, transplanted onto this
 * repository's window, read 78.72% against the reference arm's 84.09% inside one artifact -- minus
 * 3.75 questions after the anchor's drift is removed. The conclusion was an interaction, not a
 * winner: the contract and the selection that feeds it are one mechanism, and a reader enumerating
 * a list it did not build enumerates it worse.
 *
 * This subpath lets the reader build the list. Its searches are the selection; `answer` is its
 * verdict; `composeAgentPrompt` prints the result through the renderer the caller passes, so the
 * mechanism is measurable against every number already taken.
 *
 * ## Why this lives under `cortex-ai` rather than as its own package
 *
 * It began as `@agentix-e/cortex-agent`. The measurement that decided the merge: in the 11 commits
 * that touched either tree, **zero** touched both -- the provider adapters change for reasons the
 * loop never sees and the loop changes for reasons no adapter sees, so nothing was being paid for
 * by keeping them apart. The seam that did matter was the renderer, and that one is now a type
 * parameter (`Renderer<Config>`), which is why this module imports only `cortex-core`.
 *
 * A subpath rather than the root export, because `cortex-ai`'s root is "how to reach a model" and
 * a caller that only wants an embedding should not acquire a retrieval loop in the same barrel.
 *
 * ## Why the surface is eight names
 *
 * `retrieveStepwise` and `composeAgentPrompt` are the two calls an application makes;
 * `indexRetrieval` builds the tools over an index it already has; `carriedIds` reads the delivered
 * set back out of a rendered prompt; `probeMultiStep` is the instrument that prices a dispatch
 * before it happens; and the types are the vocabulary. Anything more would be a second way to do
 * one of those, and this repository's export census treats a symbol with no caller as a defect
 * precisely because a public surface that offers four ways to do one thing cannot say which of
 * them was measured.
 *
 * ## Cost
 *
 * A step costs one call whose prompt is the question plus a **digest** of the evidence, not the
 * evidence. `AgentTrace.promptChars` is the exact size of what was issued, and `calls` is the exact
 * number of model calls, so the bill of a multi-step run is arithmetic over the artifact rather
 * than an estimate. `maxSteps: 0` is the same code path with no call at all.
 */
export { composeAgentPrompt, carriedIds } from './compose.js';
export { retrieveStepwise } from './loop.js';
export {
  probeMultiStep,
  type ProbeCase,
  type ProbeCaseResult,
  type ProbeOptions,
  type ProbeReport,
} from './probe.js';
export { indexRetrieval } from './tools.js';
export type {
  AgentResult,
  AgentStep,
  AgentTrace,
  Decision,
  RenderedPrompt,
  Renderer,
  Retrieval,
  SearchHit,
  StepwiseOptions,
  StopReason,
} from './types.js';
