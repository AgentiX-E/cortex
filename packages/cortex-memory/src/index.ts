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
export type {
  GateOptions,
  CortexMemoryOptions,
  ReviewPass,
  TurnCapRoute,
  // §13.153: the arm constructs both readers from `cortex-eval`'s turn clock and window
  // resolver, and the type has to be nameable at that boundary or the arm would restate it.
  WindowOrdering,
} from './types.js';
// The vocabulary as a value, so a caller can name every route without restating the six names --
// and so `test_ask_table_parity.py` has one product-side list to compare against the arm's copy.
export { TURN_CAP_ROUTES } from './types.js';

// disclosure
// The composition root of the boundary: write side, card queue, proposal layer and read side, in the
// one order that makes "they said it" become "a colleague can read it".
export {
  DisclosureSession,
  type DisclosureSessionOptions,
  type SayResult,
} from './disclosure/session.js';

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

// relevance
// The signal session selection ranks by. Exported because `CortexSessionProvider`
// below and the measurement arm both supply it; `confidence.ts` records why the
// alternative -- widening `confidenceFor` -- was refused.
export { lexicalRelevance } from './relevance.js';

// sessionize
export {
  admitSessions,
  selectSessionBudget,
  selectTurnsWithinBudget,
  type AdmittedSession,
  type SessionRelevance,
  type TurnBudgetOptions,
  type TurnBudgetPlan,
  type TurnCost,
  type TurnRelevance,
} from './sessionize.js';

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
  type EvidenceOrdering,
  type PromptContract,
  type PromptOptions,
} from './prompt.js';

// parse
export { parseAnswer, isAbstention, ABSTAIN_TOKEN } from './parse.js';
/**
 * The two readings a question can call for, and the test that decides between them.
 *
 * Exported because the reach of an ask is a property of the **dataset**, not only of the dispatcher:
 * `ask: 'operands'` changes the block on derivation-shaped questions, so a run that cannot count its
 * own population cannot state what it treated. `tools/mr-failure-census.mjs` reads this function to
 * print that population rather than re-deriving it, which is the rule §13.141.6 states for every
 * treatment from here.
 */
export { classifyQuestionShape, type QuestionShape } from './question-shape.js';
export {
  asksForCount,
  buildRecoveryPrompt,
  DECLINE_TOKEN,
  declinedItems,
  planAbstentionRecovery,
  type RecoveryPlan,
} from './abstention-recovery.js';

// composition
export { CortexMemory } from './memory.js';

export {
  CortexSessionProvider,
  type CortexSessionProviderOptions,
  type ProviderHit,
  type ProviderIngestReport,
  type ProviderSearchOptions,
  type ProviderSession,
  type ProviderTurn,
} from './provider.js';
