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

// sessionize
export { admitSessions, selectSessionBudget, type AdmittedSession } from './sessionize.js';

// prompt
export {
  buildPrompt,
  buildSessionPrompt,
  formatEvidence,
  truncateCodePointSafe,
  DEFAULT_MAX_PROMPT_CHARS,
  type PromptContract,
  type PromptOptions,
} from './prompt.js';

// parse
export { parseAnswer, isAbstention, ABSTAIN_TOKEN } from './parse.js';

// composition
export { CortexMemory } from './memory.js';
