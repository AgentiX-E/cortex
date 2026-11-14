/**
 * The update block inside the prompt: where it sits, what it costs, and what its absence reproduces.
 *
 * ## Three claims, and the third is the one that matters
 *
 * 1. **Position.** Between the evidence and the question. A reader told which of two values is current
 *    *before* it has seen either would be reading an answer rather than evidence.
 * 2. **Budget.** The block is bought whole or not at all, before the note and before the evidence, and the
 *    prompt still fits its room. Half a fact block states a relation whose other end is missing, which reads
 *    as an assertion.
 * 3. **Absence is identity.** With the option absent, the assembled string is byte-for-byte the one every
 *    archived artifact was produced with. That is the property that makes this mechanism testable as a delta
 *    instead of arguable as a capability, and it is asserted by comparison rather than by inspection.
 */

import { describe, expect, it } from 'vitest';

import { buildPrompt } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

function admitted(content: string): AdmittedTurn {
  return {
    id: `id-${content.slice(0, 8)}`,
    content,
    value: 0.8,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: 0,
    lastAccessedAt: 0,
    stability: 1,
    difficulty: 5,
    ordinal: 0,
  };
}

const UPDATES = [
  'fact:     30 dozen  [state]',
  'status:   replaces "20 dozen"',
  'fact:     20 dozen  [state]',
  'status:   superseded by "30 dozen"',
];

const QUESTION = 'How many dozen am I at?';

describe('the update block', () => {
  it('sits between the evidence and the question', () => {
    const built = buildPrompt(QUESTION, [admitted('we have 30 dozen')], 'extractive', {
      knownUpdates: UPDATES,
    });

    expect(built.prompt).toContain('UPDATES:');
    const at = built.prompt.indexOf('UPDATES:');
    expect(built.prompt.indexOf('EVIDENCE:')).toBeLessThan(at);
    expect(at).toBeLessThan(built.prompt.indexOf(`QUESTION: ${QUESTION}`));
    // Every line, in the order it was given: the renderer decided the order and this builder is not a second
    // place that could re-sort it.
    for (const line of UPDATES) expect(built.prompt).toContain(line);
  });

  it('reproduces the archived bytes exactly when it is absent', () => {
    const turns = [admitted('alpha'), admitted('beta')];
    const withOption = buildPrompt(QUESTION, turns, 'extractive', { knownUpdates: [] });
    const withoutOption = buildPrompt(QUESTION, turns, 'extractive');

    expect(withOption.prompt).toBe(withoutOption.prompt);
    expect(withOption.prompt).not.toContain('UPDATES:');
  });

  it('survives the budget path and still carries the block', () => {
    // A ten-thousand-character window in a two-thousand-character room takes `fitToBudget`, which is a different
    // assembly from the fits path -- and the block is a section it has to buy rather than a string appended
    // afterwards. This is the case where a mechanism wired into one path and not the other would look present
    // on small questions and vanish on large ones, which is the silent-degradation shape the census work exists
    // to refuse.
    const built = buildPrompt(QUESTION, [admitted('y'.repeat(10_000))], 'extractive', {
      maxChars: 2000,
      knownUpdates: UPDATES,
    });

    expect(built.prompt.length).toBeLessThanOrEqual(2000);
    expect(built.prompt).toContain('UPDATES:');
    expect(built.prompt).toContain('status:   replaces "20 dozen"');
  });

  it('drops the block whole rather than half of it when the room cannot buy it', () => {
    // Half a fact block is a relation with one end, which reads as an assertion. The alternative -- clip the
    // block and keep the head -- is what the note's allocation refuses one line below, for the same reason.
    const built = buildPrompt(QUESTION, [admitted('y'.repeat(10_000))], 'extractive', {
      maxChars: 2000,
      knownUpdates: UPDATES.map((line) => `${line}${'z'.repeat(2000)}`),
    });

    expect(built.prompt.length).toBeLessThanOrEqual(2000);
    expect(built.prompt).not.toContain('UPDATES:');
    expect(built.prompt).not.toContain('replaces "20 dozen"');
  });
});
