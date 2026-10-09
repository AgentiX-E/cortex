/**
 * cortex-memory: composes `cortex-core`'s value gates into a runnable,
 * conformance-passing `MemorySystem`.
 *
 * The package exists because `decideWrite`, `decideRetrieval`, `consolidate`
 * and `resolveContradiction` had zero production callers — see
 * `docs/AUDIT-CODE-VS-DOCS.md` §6.1. It is the composition layer between the
 * pure algorithms and whatever backs them.
 */

// types
export type { GateOptions, CortexMemoryOptions } from './types.js';

// admission
export {
  admitTurns,
  clockAwareValueFunction,
  admissionOptionsFrom,
  type AdmittedTurn,
  type AdmissionOptions,
} from './admission.js';

// confidence
// `confidenceFromLength` is the signal the arm supplies; the saturation constant
// beside it is asserted by `__tests__` and deliberately not re-exported, since a
// barrel entry with no consumer is an orphan the census gate reports.
export { confidenceFromLength } from './confidence.js';

// sessionize
export { admitSessions, selectSessionBudget, type AdmittedSession } from './sessionize.js';

// prompt
export {
  buildPrompt,
  buildSessionPrompt,
  formatEvidence,
  truncateCodePointSafe,
  DEFAULT_MAX_PROMPT_CHARS,
  // `PROMPT_CONTRACTS` and `DEFAULT_PROMPT_CONTRACT` are exported so the measurement arm
  // can validate a dispatch-supplied name against the same list the product layer
  // implements. A second copy in `cortex-eval` is the drift the arm's own comment on
  // `DEFAULT_SOURCE_TRUST` warns about, inverted: there the risk was a default moving with
  // the product and breaking historical comparability, here it is a list that accepts a
  // name `buildPrompt` does not implement, which would publish config for a run that used
  // a different prompt.
  PROMPT_CONTRACTS,
  DEFAULT_PROMPT_CONTRACT,
  // `ASK_ROUTES` exists for the same reason as the list above and is exported for the
  // same consumer: the arm reports which routes an ask actually reached, and it cannot
  // read that from the product without this. §13's headline prediction is about MR,
  // which the extractive ask does NOT change, so the reach is the difference between a
  // readable result and a misleading one.
  ASK_ROUTES,
  type EvidenceAsk,
  type PromptContract,
  type PromptOptions,
} from './prompt.js';

// parse
export { parseAnswer, isAbstention, ABSTAIN_TOKEN } from './parse.js';

// composition
export { CortexMemory } from './memory.js';
