/**
 * The stop rule, one branch at a time, and the order of the branches.
 *
 * ## Why the order is tested and not only the branches
 *
 * Because several conditions hold on the same step in a real run, and the reported reason is what
 * the next iteration reads. A reader that answers on its final allowed call satisfies three of
 * these at once; reporting `step-limit` would send the next dispatch to raise a budget that was
 * already sufficient, and the artifact would not contain the sentence that says otherwise. Every
 * test below that passes a second true condition alongside its own is there to pin that.
 */
import { describe, expect, it } from 'vitest';

import { decideStop, type StopInput } from '../../agent/stop.js';

const BASE: StopInput = {
  calls: 1,
  maxSteps: 2,
  action: 'search',
  query: 'charity',
  added: 3,
  held: 5,
  corpusTurns: 40,
  promptChars: 900,
  budgetChars: 40_000,
  note: null,
};

const stopOf = (overrides: Partial<StopInput>): string | null =>
  decideStop({ ...BASE, ...overrides });

describe('decideStop', () => {
  it('keeps going while a search bought evidence and the budget has room', () => {
    expect(stopOf({})).toBeNull();
  });

  it('reports the reader answer even on the last allowed call', () => {
    // `calls === maxSteps` and `held === corpusTurns - 1`: two other reasons are also true here.
    expect(stopOf({ action: 'answer', calls: 2, held: 39, added: 0 })).toBe('answered');
  });

  it('tells a provider failure apart from a reply it could not read', () => {
    expect(stopOf({ action: 'unparsed', note: 'llm: 429 rate limited' })).toBe('llm-error');
    expect(stopOf({ action: 'unparsed', note: 'not-json' })).toBe('unparsed');
    expect(stopOf({ action: 'unparsed', note: null })).toBe('unparsed');
  });

  it('stops on a search whose query is blank', () => {
    expect(stopOf({ query: '' })).toBe('empty-query');
    expect(stopOf({ query: '   \n\t' })).toBe('empty-query');
    // A search step with no query at all: unreachable from the loop, reachable from a replayed
    // trace, and the rule has to be the same one.
    expect(stopOf({ query: null })).toBe('empty-query');
    // A blank query outranks the step budget: it is a fact about this step, not about the run.
    expect(stopOf({ query: '', calls: 5, maxSteps: 2 })).toBe('empty-query');
  });

  it('stops once every turn is held, before charging for another call', () => {
    expect(stopOf({ held: 40, added: 2 })).toBe('corpus-exhausted');
    // An empty corpus is not "every turn is held": there is nothing to have exhausted, and a reader
    // on an empty corpus must not be refused the one search that could find something.
    expect(stopOf({ held: 0, corpusTurns: 0, added: 0, action: 'seed' })).toBeNull();
  });

  it('stops at the call budget, and before spending a budget it has already reached', () => {
    expect(stopOf({ calls: 2, maxSteps: 2 })).toBe('step-limit');
    expect(stopOf({ calls: 9, maxSteps: 2 })).toBe('step-limit');
    expect(stopOf({ calls: 1, maxSteps: 3, promptChars: 40_000 })).toBe('budget');
    expect(stopOf({ calls: 1, maxSteps: 3, promptChars: 40_001 })).toBe('budget');
  });

  it('stops when the last step found nothing it did not already hold', () => {
    expect(stopOf({ added: 0, held: 5 })).toBe('no-new-evidence');
  });

  it('lets the reader search after a seed that matched nothing', () => {
    // The one case `added === 0` must not stop on: a question whose words are not in the corpus is
    // the question a paraphrase is for.
    expect(stopOf({ action: 'seed', added: 0, held: 0 })).toBeNull();
  });
});
