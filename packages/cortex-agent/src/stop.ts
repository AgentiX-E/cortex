/**
 * The stop rule, as one pure function.
 *
 * ## Why the order of the checks is the specification
 *
 * Several of these conditions can hold at once, and which one is reported is the difference
 * between a run whose failure can be diagnosed and one whose cannot. A reader that answers on its
 * last allowed call reports `answered`; reporting `step-limit` for it would say the budget ran out
 * when what happened is that the budget was exactly enough -- and the next reader of the artifact
 * would raise `maxSteps` for no reason.
 *
 * So the order is: the reader's own verdict first (it is a fact about the question), then the
 * loop's structural facts (an empty query, a full corpus), then the budgets, then the discovery
 * that the last step bought nothing. `no-new-evidence` sits last of all because it describes the
 * previous step's yield and only means something when no earlier reason applied.
 *
 * ## Why `no-new-evidence` is a stop rather than a retry
 *
 * A step that returns only ids already held means the query reached the same turns again. Asking
 * again costs a model call and cannot produce evidence, and the corpus does not change under it --
 * this loop reads a snapshot. The alternative considered was a corrective prompt ("you found
 * nothing new, try different words"), and it is a second call to fix the first: a reader whose
 * query repeats itself is not a reader one more sentence will repair, and the trace records the
 * repeated ids so the pattern is visible across a run.
 *
 * The rule does not apply to the seed. A seed that matched nothing is the state in which asking
 * the reader is most useful -- the question shares no term with the corpus, and a paraphrase is
 * exactly what a second query is for.
 */
import type { StopReason } from './types.js';

/** What the loop knows when it decides whether to take another step. */
export type StopInput = {
  /** Reader decisions taken so far -- model calls, not steps: the seed is free and not counted. */
  readonly calls: number;
  /** How many decisions the reader may make in total. `0` is a single retrieval with no call. */
  readonly maxSteps: number;
  /** What the step that just finished did. */
  readonly action: 'seed' | 'search' | 'session' | 'answer' | 'unparsed';
  /** The reader's query, `null` when the step was not a search. */
  readonly query: string | null;
  /** Ids the step added to the held set. */
  readonly added: number;
  /** Ids held after the step. */
  readonly held: number;
  readonly corpusTurns: number;
  /** Prompt characters issued across all steps. */
  readonly promptChars: number;
  readonly budgetChars: number;
  /** Why the step was `unparsed`, or `null`. */
  readonly note: string | null;
};

/**
 * `null` means take another step.
 *
 * `llm-error` is distinguished from `unparsed` by the note, which the loop sets to `llm: ...` when
 * the call threw: a provider outage and a model that answered prose are different operational
 * facts and the recovery differs -- one is retried next dispatch, the other needs the contract
 * changed.
 */
export function decideStop(input: StopInput): StopReason | null {
  if (input.action === 'answer') return 'answered';
  if (input.action === 'unparsed') {
    return input.note !== null && input.note.startsWith('llm:') ? 'llm-error' : 'unparsed';
  }
  if (input.action === 'search' && (input.query ?? '').trim() === '') return 'empty-query';
  if (input.corpusTurns > 0 && input.held >= input.corpusTurns) return 'corpus-exhausted';
  if (input.calls >= input.maxSteps) return 'step-limit';
  if (input.promptChars >= input.budgetChars) return 'budget';
  if (input.action !== 'seed' && input.added === 0) return 'no-new-evidence';
  return null;
}
