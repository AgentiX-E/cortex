/**
 * The one place the two halves of the multi-step arm can be seen together.
 *
 * ## Why this case lives in `cortex-memory`
 *
 * `cortex-ai` owns the loop and must not depend on this package; this package owns the renderer and
 * must not depend on the loop. Neither side may assert the equivalence that matters most -- "the
 * loop, printing through this renderer, produces the registered prompt byte for byte" -- because the
 * assertion needs both in one process. This package already takes `cortex-ai` as a dev dependency,
 * so hosting the case here adds no edge. The reverse direction did: a dev dependency from the loop's
 * package onto this one closed a cycle (`cortex-memory` → `cortex-eval` → `cortex-ai` → back), and
 * `pnpm` reported it on the first install.
 *
 * A test is not a reason to add an edge the product does not have.
 *
 * ## What breaks if this file is deleted
 *
 * Nothing fails at build time and no arm stops running. What is lost is the only check that a
 * `multi-step` dispatch would be differenced against the registered arm rather than against a
 * second rendering path -- the failure mode §14.98.5 makes a precondition of spending anything.
 */
import { describe, expect, it } from 'vitest';

import type { LLM } from '@agentix-e/cortex-core';
import { admitTurns, buildPrompt, renderInOrder, SearchIndex } from '@agentix-e/cortex-memory';
import {
  carriedIds,
  composeAgentPrompt,
  indexRetrieval,
  probeMultiStep,
  type ProbeCase,
} from '@agentix-e/cortex-ai/agent';

const QUESTION = 'What did the charity race raise money for?';

const GOLD = 'The race raised four hundred pounds for the animal shelter near the park.';

const TURNS = [
  'I adopted a dog named Biscuit in March and named him after a biscuit tin.',
  'Biscuit the dog needed a dental cleaning, which the vet scheduled for next month.',
  'My sister moved to Lisbon last spring and says she will not come back.',
  'I ran the charity ten kilometre race in fifty two minutes on a cold morning.',
  GOLD,
];

const ALL = [0, 1, 2, 3, 4];

/** An LLM that always says the evidence is enough, and refuses the structured path. */
const answering: LLM = {
  complete: () => Promise.resolve('{"action":"answer"}'),
  completeStructured: () =>
    Promise.reject(
      new Error(
        'the loop must decide with one `complete` call: completeStructured would bill a prompt the trace never described',
      ),
    ),
};

describe('the loop and the shipped renderer, together', () => {
  it('produces the registered prompt byte for byte when the selection is the retrieval', () => {
    const registered = buildPrompt(
      QUESTION,
      admitTurns(TURNS, { now: 0, threshold: 0 }),
      'abstention',
    );
    const composed = composeAgentPrompt(QUESTION, TURNS, ALL, {
      renderer: renderInOrder,
      config: { contract: 'abstention' },
    });
    expect(composed.prompt).toBe(registered.prompt);
    expect(composed.evidenceChars).toBe(registered.evidenceChars);
    expect(carriedIds(composed)).toEqual(ALL);
  });

  it('ranks with the index the registered arm ranks with', async () => {
    // The claim the seam exists to keep true: the adapter is a pass-through, not a second ranking.
    const index = new SearchIndex();
    index.add(TURNS);
    const retrieval = indexRetrieval(index, TURNS);
    const expected = await index.search('charity race raised', 3);
    const actual = await retrieval.search('charity race raised', 3);
    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(0);
  });

  it('runs the whole probe on the shipped index and the shipped renderer', async () => {
    const probeCase: ProbeCase = {
      id: 'q1',
      question: QUESTION,
      turns: TURNS,
      goldTurns: [GOLD],
    };
    const report = await probeMultiStep([probeCase], {
      llm: answering,
      retrievalFor: (turns, sessionOf) => {
        const index = new SearchIndex();
        index.add(turns);
        return indexRetrieval(index, turns, sessionOf === undefined ? {} : { sessionOf });
      },
      renderer: renderInOrder,
      config: { contract: 'abstention' },
      maxSteps: 0,
    });

    // `maxSteps: 0` is the registered arm's configuration: one retrieval, no model call, so the
    // selected set and the seed set are the same object read twice.
    expect(report.calls).toBe(0);
    expect(report.queries).toBe(0);
    expect(report.goldSelected).toBe(report.goldSeed);
    expect(report.cases).toBe(1);
  });
});
