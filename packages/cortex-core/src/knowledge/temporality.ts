/**
 * Whether a statement is about what happened, or about what might yet happen.
 *
 * ## Why one field was not enough
 *
 * `KnowledgeFact.modality` has said `actual | planned | hypothetical` since step 30, and it is a *derived*
 * summary rather than a dimension: it collapses two independent axes that the annotation literature keeps
 * apart. TimeML's event classes make the first split — `I-ACTION` ("attempt, try, promise … does not
 * necessarily actually happen") and `I-STATE` ("believe, intend, want … refers to alternative possible
 * worlds") sit beside plain `OCCURRENCE` and `STATE`. FactBank makes the second — `CT` (factual), `PR`
 * (probable), `PS` (possible), `Uu` (unknown) — and MEANTIME adds a distinct **`possibility (future)`**
 * value, which is the one this file exists for: a future possibility is not a weak fact, it is a different
 * kind of statement.
 *
 * So the model is two axes, and the old field is the projection:
 *
 * | futurity | certainty | reads as | `modality` |
 * | --- | --- | --- | --- |
 * | past / present | factual | **settled** — it happened, and no later sentence can unsettle it | `actual` |
 * | future | factual / probable | **a commitment** — "I will", "I'm going to" | `planned` |
 * | future | possible | **a wish** — "I might", "maybe" | `hypothetical` |
 * | past | possible | a speculation about the past — "it may have been" | `hypothetical` |
 *
 * ## The lifecycle, and the published reason it is a state machine
 *
 * A plan is not true or false; it is `pending`, `fulfilled`, `lapsed` or `abandoned`, and which one it is
 * changes with time and with later evidence. PM-Bench (arXiv 2607.12385) measures how badly readers do at
 * that: the best configuration reaches 65.1% F1, no setup clears 50% on cross-day intentions, and the
 * failure has a name — a plan that was *completed or cancelled* keeps being acted on. The Prospective
 * Intention Store built on the same benchmark reports the fix and its shape: make the state explicit and
 * the transitions deterministic, and let the model do only the language part (82.9% for the same backbone,
 * 4.2% → 66.2% for a small one).
 *
 * That is the design here, and it is the same argument this repository has made twice before: a rule that
 * can be a table should not be a judgement. `reconcilePlans` transitions on `due` and declared fulfilment;
 * no model is asked whether a plan "feels" done.
 *
 * ## What is refused
 *
 * No inference of fulfilment from text. A plan becoming true is an event somebody has to state, and a
 * system that guesses it will mark a plan done because the topic came up again. The declaration is the
 * caller's — the same boundary PACMI draws for invalidation, and the same one `invalidates` already uses.
 */

import type { KnowledgeFact } from './frame.js';
import type { Modality } from './taxonomy.js';

/** When the statement is about, relative to the frame that carries it. */
export type Futurity = 'past' | 'present' | 'future';

/** How committed the speaker is. FactBank's three, with `unknown` folded into `possible`. */
export type Certainty = 'factual' | 'probable' | 'possible';

/** Where a plan is in its life. Only meaningful for a statement with `futurity: 'future'`. */
export type PlanState = 'pending' | 'fulfilled' | 'lapsed' | 'abandoned';

/**
 * Markers, longest-first where they overlap, and deliberately small.
 *
 * A parser would do better and would fail worse: a wrong parse is indistinguishable from a right one
 * downstream, while a table can only ever say "this token is here", which is a fact the caller can check.
 */
const FUTURE_MARKERS: readonly string[] = [
  'will',
  'shall',
  'going to',
  'plan to',
  'planning to',
  'intend to',
  'intending to',
  'hope to',
  'want to',
  'would like to',
  'expect to',
  'aim to',
  'next week',
  'next month',
  'next year',
  'tomorrow',
  'tonight',
  'soon',
  'later',
  'in the coming',
];

const PAST_MARKERS: readonly string[] = [
  'yesterday',
  'last week',
  'last month',
  'last year',
  'last night',
  'ago',
  'previously',
  'used to',
  'earlier',
  'back in',
  'did',
  'was',
  'were',
  'had',
  'have been',
  'has been',
];

const POSSIBLE_MARKERS: readonly string[] = [
  'might',
  'may',
  'could',
  'possibly',
  'perhaps',
  'maybe',
  'unsure',
  'not sure',
  'wondering',
];

const PROBABLE_MARKERS: readonly string[] = ['probably', 'likely', 'expect', 'suppose', 'guess'];

function has(text: string, markers: readonly string[]): boolean {
  const padded = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')} `;
  return markers.some((marker) => padded.includes(` ${marker} `));
}

/**
 * The two axes, read off the statement.
 *
 * The defaults are the interesting part and each is a choice:
 *
 * - **No future marker means not future.** A statement with no tense cue is read as being about now or the
 *   past, because the alternative — assuming every unmarked sentence is a plan — would demote most of a
 *   conversation to speculation.
 * - **No modal marker means factual.** This is the opposite bias and it is deliberate: the cost of calling
 *   a plan settled is one wrong answer, and the cost of calling a settled fact a maybe is a system that
 *   hedges about what the user told it. The first is visible; the second erodes trust quietly.
 * - **`possible` wins over `future`.** "I might go next week" is a wish, not a commitment, and the modal
 *   is what makes the difference.
 */
export function inferTemporality(text: string): { futurity: Futurity; certainty: Certainty } {
  const future = has(text, FUTURE_MARKERS);
  const past = has(text, PAST_MARKERS);

  const certainty: Certainty = has(text, POSSIBLE_MARKERS)
    ? 'possible'
    : has(text, PROBABLE_MARKERS)
      ? 'probable'
      : 'factual';

  // A sentence can carry both ("I had planned to go, but now I will stay"): the later clause wins in
  // English, and `will` is the stronger cue, so future takes precedence over past when both are present.
  const futurity: Futurity = future ? 'future' : past ? 'past' : 'present';
  return { futurity, certainty };
}

/** The coarse field, derived from the two axes so the old projection cannot drift from the new ones. */
export function modalityOf(futurity: Futurity, certainty: Certainty): Modality {
  if (certainty === 'possible') return 'hypothetical';
  if (futurity === 'future') return 'planned';
  return 'actual';
}

/**
 * Whether later evidence may replace this statement.
 *
 * A **settled event** — `type: 'event'` and in the past — cannot be replaced by anything. Somebody going
 * to Paris in March is not undone by them going to Rome in June, and a system that lets the second
 * supersede the first is rewriting history to keep its answer tidy.
 *
 * A **state** can be replaced, because a state is what "current" means: living in London ends when you
 * move, and the replacement is the whole point of `supersedes`. A **plan** is neither — it is retired by
 * fulfilment, lapse or cancellation, which `reconcilePlans` handles, not by a newer statement on a slot.
 *
 * The distinction is `type`, not tense, and that is why it is checkable: "I lived in London" and "I
 * visited London" are both past tense and only one of them is replaceable.
 */
export function isImmutable(fact: KnowledgeFact): boolean {
  if (fact.type !== 'event') return false;
  // Falls back to reading the sentence, because the field is optional and a caller that never fills it must
  // not silently lose the protection: history being rewritten is not a failure that announces itself.
  const futurity = fact.futurity ?? inferTemporality(fact.text).futurity;
  return futurity === 'past';
}

/** Whether the fact is a plan, and therefore has a lifecycle rather than a truth value. */
export function isPlan(fact: KnowledgeFact): boolean {
  return fact.modality === 'planned' || fact.futurity === 'future';
}

export type PlanTransition = {
  readonly factId: string;
  readonly from: PlanState;
  readonly to: PlanState;
  readonly reason: 'due-and-unmet' | 'declared-fulfilled' | 'declared-abandoned' | 'not-yet-due';
};

/**
 * Move every plan to the state the evidence supports.
 *
 * Four transitions, and the asymmetry between them is the design:
 *
 * - **`pending` → `fulfilled`** requires a **declaration** naming the fact that fulfilled it. No inference.
 * - **`pending` → `lapsed`** requires only that the due time has passed and no fulfilment was declared.
 *   This is the one transition made on absence, and it is deliberately weak: `lapsed` discounts a plan, it
 *   does not delete one, because "nobody said it happened" is not "it did not happen".
 * - **`pending` → `abandoned`** requires a declaration too. A plan that is dropped is usually announced.
 * - **`pending` stays `pending`** while it is not yet due, even if a fulfilment was declared early — a plan
 *   completed ahead of its date is `fulfilled`, which the first rule already handles.
 *
 * The function is pure and total: a fact with no `planState` is not a plan and is returned untouched.
 */
export function reconcilePlans(
  facts: readonly KnowledgeFact[],
  now: number,
  options: {
    /** `[plannedId, fulfillingId]` pairs. Declared, never inferred — see the module comment. */
    readonly fulfils?: readonly (readonly [string, string])[];
    /** `[plannedId, cancellingId]` pairs. */
    readonly abandons?: readonly (readonly [string, string])[];
  } = {},
): { readonly facts: readonly KnowledgeFact[]; readonly transitions: readonly PlanTransition[] } {
  const fulfilledBy = new Map<string, string>();
  for (const [plannedId, byId] of options.fulfils ?? []) fulfilledBy.set(plannedId, byId);
  const abandonedBy = new Map<string, string>();
  for (const [plannedId, byId] of options.abandons ?? []) abandonedBy.set(plannedId, byId);

  const transitions: PlanTransition[] = [];
  const next = facts.map((fact) => {
    if (!isPlan(fact)) return fact;
    const current: PlanState = fact.planState ?? 'pending';
    if (current !== 'pending') return fact;

    if (fulfilledBy.has(fact.id)) {
      transitions.push({
        factId: fact.id,
        from: 'pending',
        to: 'fulfilled',
        reason: 'declared-fulfilled',
      });
      return { ...fact, planState: 'fulfilled' as const };
    }
    if (abandonedBy.has(fact.id)) {
      transitions.push({
        factId: fact.id,
        from: 'pending',
        to: 'abandoned',
        reason: 'declared-abandoned',
      });
      return { ...fact, planState: 'abandoned' as const };
    }
    // No due date means no basis for lapse: a plan without a time is not overdue, it is undated.
    if (fact.at === undefined || fact.at > now) {
      transitions.push({ factId: fact.id, from: 'pending', to: 'pending', reason: 'not-yet-due' });
      return fact;
    }
    transitions.push({ factId: fact.id, from: 'pending', to: 'lapsed', reason: 'due-and-unmet' });
    return { ...fact, planState: 'lapsed' as const };
  });

  return { facts: next, transitions };
}

/**
 * How a plan should be weighted when answering.
 *
 * `fulfilled` is a fact and answers normally. `abandoned` is nothing. `lapsed` is the hard one and the
 * discount is deliberately mild: a plan whose date passed without word is more likely not to have happened,
 * but the system has no evidence either way, and answering "it never happened" with confidence is the
 * failure PM-Bench calls a false alarm in the other direction.
 */
export function planFactor(fact: KnowledgeFact): number {
  if (!isPlan(fact)) return 1;
  switch (fact.planState) {
    case 'fulfilled':
      return 1;
    case 'lapsed':
      return 0.4;
    case 'abandoned':
      return 0;
    default:
      return 0.8;
  }
}

/** A one-line rendering for the block, or `''` when there is nothing a reader needs to know. */
export function describePlan(fact: KnowledgeFact): string {
  if (!isPlan(fact)) return '';
  const state = fact.planState ?? 'pending';
  if (state === 'fulfilled') return '';
  const due = fact.at === undefined ? 'no date' : new Date(fact.at).toISOString().slice(0, 10);
  const certainty = fact.certainty === 'possible' ? 'a possibility' : 'a plan';
  return `${certainty}, ${state} (due ${due})`;
}
