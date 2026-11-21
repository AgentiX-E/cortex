/**
 * The probe: the arithmetic that decides whether a two-step dispatch is worth buying.
 *
 * ## Why these cases are shaped the way they are
 *
 * The instrument's whole claim is that it can tell four states apart on one population: a reader
 * whose searches found **gold**, a reader whose searches found only more of the same, a reader whose
 * finds the room then discarded, and a corpus with no gold annotation at all. Each of those has a
 * different consequence for the campaign -- dispatch, cancel, widen the room, exclude from coverage
 * claims -- and a probe that reported one number for all four would be the kind of instrument this
 * campaign has already paid for: one that prints the same word for different failures.
 */
import { describe, expect, it } from 'vitest';

import { probeMultiStep, type ProbeCase } from '../probe.js';

import { ScriptedLlm } from './fixtures.js';

const QUESTION = 'What did the charity race raise?';

const TURNS = [
  'I adopted a dog named Biscuit in March and he sleeps by the window all afternoon.',
  'Biscuit likes the park near the river and will not leave it without a second walk.',
  'My sister moved to Lisbon last spring and says she will not come back any time soon.',
  'The charity race raised four hundred pounds for the shelter near the park gate.',
] as const;

const CASE: ProbeCase = {
  id: 'q1',
  question: QUESTION,
  turns: TURNS,
  goldTurns: [TURNS[0], TURNS[3]],
};

describe('probeMultiStep', () => {
  it('separates gold the reader found from evidence it merely added', async () => {
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    const report = await probeMultiStep([CASE], { llm, k: 4, maxSteps: 2 });

    // The seed is the question, so `4` is what the static retrieval had.
    expect(report.goldSeed).toBe(1);
    // The reader's query brought the dog turn, which is gold, and the park turn, which is not.
    expect(report.newGold).toBe(1);
    expect(report.gainedQuestions).toBe(1);
    expect(report.addedQuestions).toBe(1);
    expect(report.goldSelected).toBe(2);
    expect(report.goldTotal).toBe(2);
    expect(report.queries).toBe(1);
    expect(report.calls).toBe(2);
  });

  it('reports a reader that searched and found nothing new with no gold', async () => {
    const llm = new ScriptedLlm(['{"action":"search","query":"Lisbon"}', '{"action":"answer"}']);
    const report = await probeMultiStep([CASE], { llm, k: 4, maxSteps: 2 });

    expect(report.addedQuestions).toBe(1);
    expect(report.newGold).toBe(0);
    expect(report.gainedQuestions).toBe(0);
    // The static retrieval already had the gold, which is the finding that would cancel a dispatch.
    expect(report.goldSeed).toBe(1);
    expect(report.goldCarried).toBe(1);
  });

  it('reports gold the reader found and the room then dropped', async () => {
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}', '{"action":"answer"}']);
    const report = await probeMultiStep([CASE], { llm, k: 4, maxChars: 500, maxSteps: 2 });

    expect(report.goldSelected).toBe(2);
    expect(report.goldCarried).toBeLessThan(2);
    expect(report.foundNotCarried).toBe(1);
  });

  it('counts a corpus with no gold annotation as zero rather than as perfect coverage', async () => {
    const unannotated: ProbeCase = { ...CASE, id: 'q2', goldTurns: [] };
    const llm = new ScriptedLlm([]);
    const report = await probeMultiStep([unannotated], { llm, maxSteps: 0 });

    expect(report.goldTotal).toBe(0);
    expect(report.goldSeed).toBe(0);
    expect(report.goldCarried).toBe(0);
    expect(report.foundNotCarried).toBe(0);
    expect(report.cases).toBe(1);
  });

  it('measures the single retrieval when the reader is allowed no decisions', async () => {
    const llm = new ScriptedLlm([]);
    const report = await probeMultiStep([CASE], { llm, maxSteps: 0 });

    expect(report.calls).toBe(0);
    expect(report.queries).toBe(0);
    expect(report.askedQuestions).toBe(0);
    expect(report.goldSelected).toBe(report.goldSeed);
  });

  it('aggregates across a population without hiding the per-case record', async () => {
    const second: ProbeCase = { ...CASE, id: 'q2' };
    const llm = new ScriptedLlm([
      '{"action":"search","query":"Biscuit"}',
      '{"action":"answer"}',
      '{"action":"search","query":"Lisbon"}',
      '{"action":"answer"}',
    ]);
    const report = await probeMultiStep([CASE, second], { llm, k: 4, maxSteps: 2 });

    expect(report.cases).toBe(2);
    expect(report.gainedQuestions).toBe(1);
    expect(report.addedQuestions).toBe(2);
    expect(report.perCase.map((row) => row.id)).toEqual(['q1', 'q2']);
    expect(report.goldTotal).toBe(4);
    // Per-question cost is the number a dispatch estimate is built from, so it has to be the sum the
    // report prints and not a second measurement of the same calls.
    expect(report.promptChars).toBe(
      report.perCase.reduce((sum, row) => sum + row.trace.promptChars, 0),
    );
    expect(report.promptChars).toBeGreaterThan(0);
  });

  it('runs on its defaults, which are one decision and the abstention contract', async () => {
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}']);
    const report = await probeMultiStep([CASE], { llm });

    expect(report.maxSteps).toBe(1);
    expect(report.cases).toBe(1);
    // Default `k` is the loop's, and the digest is the default width: this test exists to prove the
    // probe is usable with nothing configured, which is how a one-off read is actually taken.
    expect(report.calls).toBe(1);
  });

  it('threads every width it was given, so a read can price a narrower reader', async () => {
    const llm = new ScriptedLlm(['{"action":"search","query":"Biscuit"}']);
    const wide = await probeMultiStep([CASE], {
      llm: new ScriptedLlm(['{"action":"search","query":"Biscuit"}']),
      maxSteps: 1,
    });
    const narrow = await probeMultiStep([CASE], {
      llm,
      contract: 'temporal',
      k: 2,
      digestChars: 40,
      digestTurns: 1,
      maxChars: 900,
      maxSteps: 1,
    });

    expect(narrow.promptChars).toBeLessThan(wide.promptChars);
    expect(narrow.cases).toBe(1);
  });

  it('hands the reader the session tool on a corpus that has boundaries', async () => {
    const withBoundaries: ProbeCase = { ...CASE, sessionOf: [0, 0, 1, 1] };
    const llm = new ScriptedLlm(['{"action":"session","turn":0}', '{"action":"answer"}']);
    const report = await probeMultiStep([withBoundaries], { llm, k: 4, maxSteps: 2 });

    // The seed is the question, so turn 0 is not in hand until the session opens it; the probe
    // records what the step bought rather than what the reader asked for.
    expect(report.perCase[0]?.trace.queries).toBe(0);
    expect(report.calls).toBe(2);
  });
});
