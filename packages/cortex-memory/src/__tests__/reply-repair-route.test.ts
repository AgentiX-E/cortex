/**
 * The repair fires on the routes that hold the population, and on nothing else.
 *
 * ## What each test pins against the others
 *
 * The treatment is one extra model call on a population that is currently always wrong. A test that read only the
 * returned answer would pass for a system that re-asked every question; a test that read only the census would pass
 * for one that recorded a consultation it never made. So each case pins the **call log**, the **return value** and
 * the **census** against each other: the number of calls says whether the pass fired, the prompt says what it
 * asked, and the census has to agree with both.
 *
 * The exclusions are the part that costs money if it is wrong:
 *
 * - `abstention` route: its gold **is** the decline, it reads 30/30, and 29 of its 30 answers are the bare token.
 *   A repair reaching it would spend a call to turn a right answer into a wrong one.
 * - a correct answer: never re-asked, under either kind.
 * - a bare decline with `reviewBareDecline` on: the two treatments are disjoint by `classifyReply`'s ordering, so
 *   one question can acquire at most one extra call even with both switches on.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const OPEN_GATE = { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY };

/** An LLM that returns the scripted replies in order, and records every prompt. */
function scripted(replies: readonly string[]): { llm: LLM; seen: string[] } {
  const seen: string[] = [];
  let at = 0;
  return {
    seen,
    llm: {
      complete: async (prompt: string) => {
        seen.push(prompt);
        const reply = replies[Math.min(at, replies.length - 1)] as string;
        at += 1;
        return reply;
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    } as unknown as LLM,
  };
}

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, llm, ...options });
}

const QUESTION = 'What degree did I graduate with?';
const CONTEXT = ['[2023/05/20] user: I graduated with a degree in Business Administration.'];

function sessions(): string[][] {
  return [
    ['[2023/05/20 (Sat) 20:05] user: I graduated with a degree in Business Administration.'],
    ['[2023/05/25 (Thu) 16:59] user: The ceremony was in June, two weeks after the last exam.'],
  ];
}

/** The eight refusals' shape: an answer to the parser, a refusal to a reader. */
const PROSE_REFUSAL = 'Not specified in the evidence';

/** The shape failures that are quotations: the turns quoted, no stamp, no answer line. */
const QUOTATION_DUMP = [
  '- "I graduated with a degree in Business Administration."',
  '- "The ceremony was in June, two weeks after the last exam."',
].join('\n');

/**
 * The shape failures that are the evidence written back: the same list, with the renderer's stamp on each line.
 *
 * The two are separate kinds since `MEASURE-COMPETITOR-PAIRING.md` section 4 -- 15 replies wrong 53.3% of the time
 * against 28 wrong 14.3% -- and separate values on the option, so both need a route test and neither may fire
 * under the other's arm.
 */
const EVIDENCE_ECHO = [
  '- [2023/05/20] user: "I graduated with a degree in Business Administration."',
  '- [2023/05/25] user: "The ceremony was in June, two weeks after the last exam."',
].join('\n');

describe('the flat route', () => {
  it('changes nothing when the option is absent, which is the shipped behaviour', async () => {
    const { llm, seen } = scripted([PROSE_REFUSAL, 'Business Administration']);
    const instance = system(llm);
    expect(await instance.answer(QUESTION, CONTEXT)).toBe(PROSE_REFUSAL);
    expect(seen).toHaveLength(1);
    // `null`, not a zeroed pair: this build does not carry the repair, and an artifact has to be able to say so.
    expect(instance.replyRepairCensus()).toBeNull();
  });

  it('re-asks a refusal in prose and takes the answer', async () => {
    const { llm, seen } = scripted([PROSE_REFUSAL, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'commitment' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(instance.replyRepairCensus()).toEqual({
      attempted: 1,
      answered: 1,
      commitment: { attempted: 1, answered: 1, questions: [QUESTION] },
      echo: { attempted: 0, answered: 0, questions: [] },
      shape: { attempted: 0, answered: 0, questions: [] },
    });
  });

  it('carries the evidence the first call read, and says why it is asking again', async () => {
    const { llm, seen } = scripted([PROSE_REFUSAL, 'Business Administration']);
    await system(llm, { replyRepair: 'commitment' }).answer(QUESTION, CONTEXT);
    const retry = seen[1] as string;
    expect(retry).toContain('Business Administration');
    expect(retry).toContain(QUESTION);
    expect(retry).toContain('a refusal is not');
    // The bare retry's sentence must not appear: this reply named the evidence, it did not stay silent.
    expect(retry).not.toContain('named no evidence');
  });

  it('does not re-ask an answer, under either kind', async () => {
    for (const mode of ['commitment', 'shape', 'both'] as const) {
      const { llm, seen } = scripted(['Business Administration', 'something else']);
      const instance = system(llm, { replyRepair: mode });
      expect(await instance.answer(QUESTION, CONTEXT), mode).toBe('Business Administration');
      expect(seen, mode).toHaveLength(1);
      expect(instance.replyRepairCensus()?.attempted, mode).toBe(0);
    }
  });

  it('re-asks a quotation dump for its shape, and the reply parses to the answer', async () => {
    const { llm, seen } = scripted([QUOTATION_DUMP, 'Answer: Business Administration']);
    const instance = system(llm, { replyRepair: 'shape' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('Answer: <the answer');
    expect(instance.replyRepairCensus()).toEqual({
      attempted: 1,
      answered: 1,
      commitment: { attempted: 0, answered: 0, questions: [] },
      echo: { attempted: 0, answered: 0, questions: [] },
      shape: { attempted: 1, answered: 1, questions: [QUESTION] },
    });
  });

  it('re-asks a transcript for an answer, and says which mistake it made', async () => {
    // The kind `MEASURE-COMPETITOR-PAIRING.md` section 4 separated from the quotations: the reply is the evidence
    // block with this renderer's stamp on every line, wrong 53.3% of the time against 14.3% for the quotations.
    // The prompt has to name the mistake -- a reply that already enumerated will enumerate again if asked to.
    const { llm, seen } = scripted([EVIDENCE_ECHO, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'echo' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('copied the evidence above back instead of answering');
    expect(seen[1]).toContain('Do not restate, quote or list the evidence');
    expect(instance.replyRepairCensus()).toEqual({
      attempted: 1,
      answered: 1,
      commitment: { attempted: 0, answered: 0, questions: [] },
      echo: { attempted: 1, answered: 1, questions: [QUESTION] },
      shape: { attempted: 0, answered: 0, questions: [] },
    });
  });

  it('keeps the two shape kinds on their own arms, in both directions', async () => {
    // `echo` must not reach a quotation list, and `shape` must not reach a transcript: a mode that reached both
    // would publish one reading for two populations, and the whole reason the split exists is that the two have
    // different wrong rates.
    const quotation = scripted([QUOTATION_DUMP, 'Business Administration']);
    expect(await system(quotation.llm, { replyRepair: 'echo' }).answer(QUESTION, CONTEXT)).toBe(
      QUOTATION_DUMP,
    );
    expect(quotation.seen).toHaveLength(1);

    const transcript = scripted([EVIDENCE_ECHO, 'Business Administration']);
    expect(await system(transcript.llm, { replyRepair: 'shape' }).answer(QUESTION, CONTEXT)).toBe(
      EVIDENCE_ECHO,
    );
    expect(transcript.seen).toHaveLength(1);
  });

  it('does not repair a dump when only the commitment kind is on', async () => {
    // The kinds are separate treatments on disjoint populations, so a run has to be able to say which one moved.
    const { llm, seen } = scripted([QUOTATION_DUMP, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'commitment' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe(QUOTATION_DUMP);
    expect(seen).toHaveLength(1);
    expect(instance.replyRepairCensus()?.shape.attempted).toBe(0);
  });

  it('names the question it repaired, and hands out a copy of the list', async () => {
    // §13.358. The population `E3.2` needs. The copy matters because the census is read after the question that
    // produced it: a shared array would let the next repair append to a record a reader already holds, which is the
    // shape of every "the artifact and its own summary disagreed" defect in this register.
    const { llm } = scripted([PROSE_REFUSAL, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'commitment' });
    await instance.answer(QUESTION, CONTEXT);

    const first = instance.replyRepairCensus();
    expect(first?.commitment.questions).toEqual([QUESTION]);
    (first?.commitment.questions as string[]).push('a question this run never asked');
    expect(instance.replyRepairCensus()?.commitment.questions).toEqual([QUESTION]);
  });

  it('counts a repair that refused again, and keeps the refusal', async () => {
    // The honest outcome for evidence that genuinely holds nothing. `attempted` and `answered` are separate so that
    // "the pass did not fire" and "the pass fired and changed nothing" stay distinguishable -- and this is the arm
    // that makes them different: the second call declined too, so the treatment fired and converted nothing.
    const { llm, seen } = scripted([PROSE_REFUSAL, ABSTAIN_TOKEN]);
    const instance = system(llm, { replyRepair: 'commitment' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBeNull();
    expect(seen).toHaveLength(2);
    expect(instance.replyRepairCensus()?.commitment).toEqual({
      attempted: 1,
      answered: 0,
      questions: [QUESTION],
    });
  });

  it('keeps a second refusal in prose rather than the first one', async () => {
    // A repair that refuses **in words** again is an answer to the parser, and the record carries what the reader
    // last said -- which is the more informative of the two refusals for a reader of the artifact.
    const { llm, seen } = scripted([PROSE_REFUSAL, 'Cannot be determined']);
    const instance = system(llm, { replyRepair: 'commitment' });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe('Cannot be determined');
    expect(seen).toHaveLength(2);
    expect(instance.replyRepairCensus()?.commitment).toEqual({
      attempted: 1,
      answered: 1,
      questions: [QUESTION],
    });
  });
});

describe('the multi-session route', () => {
  it('re-asks a refusal in prose, on the route that holds half the population', async () => {
    const { llm, seen } = scripted([PROSE_REFUSAL, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'commitment' });
    expect(await instance.answerSessions(QUESTION, sessions())).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(instance.replyRepairCensus()?.commitment).toEqual({
      attempted: 1,
      answered: 1,
      questions: [QUESTION],
    });
  });

  it('re-asks a quotation dump for its shape', async () => {
    const { llm, seen } = scripted([QUOTATION_DUMP, 'Answer: Business Administration']);
    const instance = system(llm, { replyRepair: 'both' });
    expect(await instance.answerSessions(QUESTION, sessions())).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(instance.replyRepairCensus()?.shape).toEqual({
      attempted: 1,
      answered: 1,
      questions: [QUESTION],
    });
  });

  it('leaves an answer alone', async () => {
    const { llm, seen } = scripted(['Business Administration', 'something else']);
    expect(await system(llm, { replyRepair: 'both' }).answerSessions(QUESTION, sessions())).toBe(
      'Business Administration',
    );
    expect(seen).toHaveLength(1);
  });
});

describe('the exclusions', () => {
  it('never reaches the abstention route, whose gold is the decline', async () => {
    // `ABS` reads 30/30 and 29 of its 30 answers are the bare token. The route does not decline here -- it returns
    // what it read (`#prompt` with the abstention contract, whose own gate decides) -- and the point of the case is
    // that the repair adds no consultation to it either way: a commitment rule there would ask the one capability
    // whose answer IS a refusal to stop refusing.
    const { llm, seen } = scripted([PROSE_REFUSAL, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'both' });
    expect(await instance.answerAbstention(QUESTION, CONTEXT)).toBe(PROSE_REFUSAL);
    expect(seen).toHaveLength(1);
    expect(instance.replyRepairCensus()?.attempted).toBe(0);
  });

  it('cannot double-consult with the bare retry, even with both treatments on', async () => {
    // The disjointness `classifyReply`'s ordering buys: a bare decline belongs to `reviewBareDecline`, so the two
    // switches together still add at most one call, and the census says which treatment earned it.
    const { llm, seen } = scripted([ABSTAIN_TOKEN, 'Business Administration']);
    const instance = system(llm, { replyRepair: 'both', reviewBareDecline: true });
    expect(await instance.answer(QUESTION, CONTEXT)).toBe('Business Administration');
    expect(seen).toHaveLength(2);
    expect(instance.bareRetryCensus()).toEqual({ attempted: 1, answered: 1 });
    expect(instance.replyRepairCensus()).toEqual({
      attempted: 0,
      answered: 0,
      commitment: { attempted: 0, answered: 0, questions: [] },
      echo: { attempted: 0, answered: 0, questions: [] },
      shape: { attempted: 0, answered: 0, questions: [] },
    });
  });

  it('refuses to be configured beside a review pass', () => {
    // Two second consultations with overlapping populations on one route: a run that carried both could not say
    // which one moved a question.
    for (const reviewPass of ['audit', 'recover'] as const) {
      expect(() => system(scripted(['x']).llm, { replyRepair: 'both', reviewPass })).toThrow(
        /replyRepair and reviewPass cannot both be on/,
      );
    }
    // `off` is not a configuration of the repair, so it is not refused beside a pass.
    expect(() =>
      system(scripted(['x']).llm, { replyRepair: 'off', reviewPass: 'audit' }),
    ).not.toThrow();
  });
});
