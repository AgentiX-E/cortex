/**
 * The artifact must be able to say how much evidence the **prompt carried**, not
 * only how much was offered to it.
 *
 * ## The gap these tests close
 *
 * `#recordEvidence` captures the turns passed to `buildPrompt` and stores them as
 * the reader's context. `buildPrompt` then calls `fitToBudget` when the assembled
 * prompt is over `maxChars`, and that truncates the evidence. The arm never sets
 * `maxPromptChars`, so the budget is `DEFAULT_MAX_PROMPT_CHARS` — and run
 * `38044858147` averaged 506,338 characters of evidence per question against it.
 *
 * So the run's artifact reports 3,016-4,528 turns of evidence while the model
 * received roughly 150-160. The overstatement is not a rounding error: it is the
 * difference between "the gold turn was not retrieved" and "the gold turn was
 * retrieved and then cut", and `§13.11.5` hands the next round exactly that
 * question.
 *
 * ## How these assertions avoid agreeing with the code under test
 *
 * The rendered evidence is a known string for a known input, and the tests say so
 * rather than asking the builder twice. `formatEvidence` is the renderer the
 * prompt actually uses, so comparing against it catches a builder that reports the
 * input length instead of the rendered length — which is the defect. And where the
 * evidence is truncated the test locates the reported length **inside the emitted
 * prompt** and requires it to land on a section boundary, so a builder that
 * returned a plausible constant would fail.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import {
  buildPrompt,
  buildSessionPrompt,
  DEFAULT_MAX_PROMPT_CHARS,
  formatEvidence,
} from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import type { AdmittedTurn } from '../admission.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const MARKER = 'EVIDENCE:\n';

function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

function session(index: number, contents: string[]): AdmittedSession {
  return {
    index,
    turns: contents.map((content, i) => turn(content, i)),
    size: contents.length,
  } as unknown as AdmittedSession;
}

/** Where the evidence section starts in an assembled prompt, or `-1`. */
function evidenceStart(prompt: string): number {
  const at = prompt.indexOf(MARKER);
  return at === -1 ? -1 : at + MARKER.length;
}

function recordingLlm(seen: string[], answer = 'Lisbon'): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...options,
  });
}

/**
 * The evidence text a prompt emitted, located by the length the builder reports.
 *
 * Independent of the builder's arithmetic: it takes the number, goes to where
 * that number says the evidence ends, and the assertions require the next two
 * characters to be the section separator. A reported length that was too long,
 * too short, or the input length rather than the rendered length lands somewhere
 * that is not a boundary.
 */
function carriedSlice(prompt: string, reported: number): { text: string; after: string } {
  const start = evidenceStart(prompt);
  const end = start + reported;
  return { text: prompt.slice(start, end), after: prompt.slice(end, end + 2) };
}

describe('buildPrompt reports the evidence it carried', () => {
  it('reports the rendered size, not the offered content length', () => {
    // `formatEvidence` numbers each turn and joins with a blank line, so the
    // rendered evidence is longer than the sum of its turn contents. Reporting
    // the content length would understate the prompt and hide the budget, so the
    // expectation is the renderer's own output.
    const turns = [turn('alpha'), turn('beta', 1)];
    const rendered = formatEvidence(turns);
    expect(rendered).toBe('1. alpha\n\n2. beta');

    const assembled = buildPrompt('Q?', turns, 'extractive');

    expect(assembled.evidenceChars).toBe(rendered.length);
    expect(carriedSlice(assembled.prompt, assembled.evidenceChars).text).toBe(rendered);
  });

  it('reports the truncated size when the budget binds, not the offered size', () => {
    // The defect, stated as a test: the rendered evidence is far larger than the
    // budget, and the reported number must be the smaller one. A builder that
    // echoed the rendered length would pass the case above and fail this one.
    const turns = [turn('x'.repeat(5_000))];

    const unbounded = buildPrompt('Q?', turns, 'extractive');
    const bounded = buildPrompt('Q?', turns, 'extractive', { maxChars: 500 });

    expect(unbounded.evidenceChars).toBe(formatEvidence(turns).length);
    expect(bounded.evidenceChars).toBeLessThan(unbounded.evidenceChars);
    // The reported slice ends exactly at the separator, so the number describes
    // the evidence that is really there rather than a similar one.
    const slice = carriedSlice(bounded.prompt, bounded.evidenceChars);
    expect(slice.after).toBe('\n\n');
    expect(unbounded.prompt).toContain(slice.text);
    // And the instruction block that names the abstention token survived, which is
    // the priority the allocator exists to hold.
    expect(bounded.prompt).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('reports zero when no evidence was admitted at all', () => {
    // The placeholder sentence is a statement about evidence, not evidence. A
    // builder that counted its characters would report a delivery for a question
    // where nothing was retrieved -- the confusion this measurement exists to end.
    const assembled = buildPrompt('Q?', [], 'extractive');

    expect(assembled.evidenceChars).toBe(0);
    expect(assembled.prompt).toContain('no evidence was admitted');
  });

  it('reports the session route through the same one number', () => {
    const sessions = [session(0, ['y'.repeat(3_000)])];
    const rendered = formatEvidence(sessions[0]!.turns, { sessionIndex: 0 });

    const unbounded = buildSessionPrompt('Q?', sessions);
    const bounded = buildSessionPrompt('Q?', sessions, { maxChars: 600 });

    expect(unbounded.evidenceChars).toBe(rendered.length);
    expect(bounded.evidenceChars).toBeLessThan(unbounded.evidenceChars);
    expect(carriedSlice(bounded.prompt, bounded.evidenceChars).after).toBe('\n\n');
    expect(bounded.prompt).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('reports zero on the session route when the list is empty', () => {
    const assembled = buildSessionPrompt('Q?', []);

    expect(assembled.evidenceChars).toBe(0);
  });

  it('keeps the default budget observable, since it is what makes the cut routine', () => {
    // The arm never sets `maxPromptChars`, so this constant is the budget every
    // question met. Asserting it here means a future change to it is a change to
    // what the artifacts mean, and shows up as this failure rather than as a
    // silent shift in every prompt-carried number.
    expect(DEFAULT_MAX_PROMPT_CHARS).toBe(24_000);
  });
});

describe('the system reports the evidence the prompt carried', () => {
  it('starts at null, because no prompt has been built yet', () => {
    const memory = system({ llm: recordingLlm([]) });

    expect(memory.lastPromptEvidenceChars()).toBeNull();
  });

  it('reports less than was offered when the context is over budget', async () => {
    // The shape of the incident, reproduced at fixture scale: 2,000 turns offered
    // against a 24,000-character budget, so the carried size has to be strictly
    // smaller. Equality here would mean the budget is not being spent, which is
    // the condition §13.13.3 names as falsifying this whole section.
    const memory = system({ llm: recordingLlm([]) });
    const context = Array.from({ length: 2_000 }, (_, i) => `user: note number ${i} about it`);

    await memory.answer('What did I note?', context);

    const offered = memory.lastRetrievedContext()!.length;
    const carried = memory.lastPromptEvidenceChars()!;
    expect(offered).toBeGreaterThan(DEFAULT_MAX_PROMPT_CHARS);
    expect(carried).toBeLessThan(offered);
    // And it is bounded by the budget, which is the allocator's whole job.
    expect(carried).toBeLessThanOrEqual(DEFAULT_MAX_PROMPT_CHARS);
  });

  it('reports the carried size on the session route, which is half the measured loss', async () => {
    const memory = system({ llm: recordingLlm([]) });
    const sessions = [
      Array.from({ length: 1_500 }, (_, i) => `user: session turn ${i} here`),
      Array.from({ length: 1_500 }, (_, i) => `user: other turn ${i} there`),
    ];

    await memory.answerSessions('How many things?', sessions);

    const carried = memory.lastPromptEvidenceChars()!;
    expect(carried).toBeGreaterThan(0);
    expect(carried).toBeLessThanOrEqual(DEFAULT_MAX_PROMPT_CHARS);
  });

  it('reports a small run as carried whole, so the field does not read as always reduced', async () => {
    const memory = system({ llm: recordingLlm([]) });

    await memory.answer('Where?', ['user: I went to Lisbon.']);

    expect(memory.lastPromptEvidenceChars()).toBeGreaterThan(0);
    expect(memory.lastPromptEvidenceChars()).toBeLessThan(DEFAULT_MAX_PROMPT_CHARS);
  });

  it('reports the length the prompt really carried, located inside the prompt it sent', async () => {
    // The independent check at the memory level: take the number the accessor
    // reported, go that far into the prompt the LLM actually received, and require
    // a section boundary there. A route that recorded the offered size instead
    // would land hundreds of thousands of characters past the end of the evidence.
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen) });
    const context = Array.from({ length: 1_200 }, (_, i) => `user: entry ${i} of the log`);

    await memory.answer('What did I log?', context);

    const reported = memory.lastPromptEvidenceChars()!;
    const slice = carriedSlice(seen[0]!, reported);
    expect(slice.after).toBe('\n\n');
    expect(slice.text.length).toBe(reported);
    // The offered context is larger, which is the whole reason the two fields are
    // kept apart. Not asserted as a ratio: the offered number counts the joined
    // turn contents and the carried one counts the numbered rendering, so the two
    // are in different units and only the direction is meaningful here.
    expect(memory.lastRetrievedContext()!.length).toBeGreaterThan(reported);
  });
});
