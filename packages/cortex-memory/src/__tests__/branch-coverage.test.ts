/**
 * Branch coverage for the defensive paths and the budget paths.
 *
 * Two families live here, and they are different in kind:
 *
 * - **Sparse-array guards.** `noUncheckedIndexedAccess` forces every indexed
 *   read to be treated as possibly `undefined`. Those `continue` arms are
 *   unreachable by construction for a dense array, but they are also the only
 *   thing standing between a sparse input and a `TypeError` inside a gate.
 *   Exercising them is how we know they do the right thing rather than merely
 *   compile.
 * - **Budget arithmetic.** Truncation decides what the model sees, so the
 *   boundary conditions (exactly at budget, one character over, budget smaller
 *   than the instruction block) are behaviour, not plumbing.
 */
import { describe, expect, it } from 'vitest';
import { admitTurns } from '../admission.js';
import { admitSessions } from '../sessionize.js';
import { buildPrompt, buildSessionPrompt, truncateCodePointSafe } from '../prompt.js';
import { parseAnswer } from '../parse.js';
import { CortexMemory } from '../memory.js';
import type { AdmittedSession } from '../sessionize.js';
import type { AdmittedTurn } from '../admission.js';
import type { LLM } from '@agentix-e/cortex-core';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_700_000_000_000;

class NoopLlm implements LLM {
  readonly prompts: string[] = [];
  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return 'ok';
  }
  async completeStructured<T>(): Promise<T> {
    return JSON.parse('{}') as T;
  }
}

function options(llm: LLM, overrides: Partial<CortexMemoryOptions> = {}): CortexMemoryOptions {
  return { llm, now: NOW, gate: { threshold: 0, sessionBudget: 100 }, ...overrides };
}

/** A dense turn list with a hole punched in it. */
function sparse<T>(items: T[], holeAt: number): T[] {
  const copy = items.slice();
  delete copy[holeAt];
  return copy;
}

describe('sparse input does not crash the gates', () => {
  it('skips an undefined slot in the turn list', () => {
    const turns = sparse(['alpha', 'beta', 'gamma'], 1);

    const admitted = admitTurns(turns, { now: NOW, threshold: 0 });

    expect(admitted.map((t) => t.content)).toEqual(['alpha', 'gamma']);
  });

  it('reports ordinals that still address the original positions', () => {
    // The hole is at 1, so `gamma` is at ordinal 2. Re-numbering it to 1 would
    // silently reindex the evidence relative to its source.
    const admitted = admitTurns(sparse(['alpha', 'beta', 'gamma'], 1), { now: NOW, threshold: 0 });

    expect(admitted.map((t) => t.ordinal)).toEqual([0, 2]);
  });

  it('skips an undefined session in the session list', () => {
    const sessions = sparse([['s0'], ['s1'], ['s2']], 1);

    const admitted = admitSessions(sessions, { now: NOW, threshold: 0 });

    expect(admitted.map((s) => s.index)).toEqual([0, 2]);
  });

  it('handles a turn list that is entirely holes', () => {
    const holes: string[] = [];
    holes.length = 3;

    expect(admitTurns(holes, { now: NOW, threshold: 0 })).toEqual([]);
  });

  it('handles a session list that is entirely holes', () => {
    const holes: string[][] = [];
    holes.length = 2;

    expect(admitSessions(holes, { now: NOW, threshold: 0 })).toEqual([]);
  });
});

describe('prompt budget boundaries', () => {
  /**
   * The smallest budget at which `needle` appears in the prompt.
   *
   * Scanned rather than computed, so the test measures the implementation's
   * boundary instead of restating its arithmetic. The scan is bounded by the
   * unbounded prompt length, so a predicate that is never satisfied fails
   * loudly instead of looping — an unbounded scan here once hung the suite.
   */
  function findBudgetWhere(turnToShow: AdmittedTurn, needle: string): number {
    const full = buildPrompt('Q?', [turnToShow], 'extractive').length;
    for (let budget = 1; budget <= full; budget += 1) {
      if (buildPrompt('Q?', [turnToShow], 'extractive', { maxChars: budget }).includes(needle)) {
        return budget;
      }
    }
    throw new Error(`"${needle}" never appears at any budget up to ${full}`);
  }

  function turn(content: string): AdmittedTurn {
    return {
      id: content,
      content,
      value: 0.5,
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

  it('returns the prompt unchanged when it is exactly at the budget', () => {
    const unbounded = buildPrompt('Q?', [turn('a')], 'extractive');
    const atBudget = buildPrompt('Q?', [turn('a')], 'extractive', { maxChars: unbounded.length });

    expect(atBudget).toBe(unbounded);
  });

  it('truncates evidence, not the instruction block, when one over budget', () => {
    const unbounded = buildPrompt('Q?', [turn('a'.repeat(200))], 'extractive');
    const bounded = buildPrompt('Q?', [turn('a'.repeat(200))], 'extractive', {
      maxChars: unbounded.length - 1,
    });

    expect(bounded).toContain('Reply with the answer alone.');
    expect(bounded.length).toBeLessThanOrEqual(unbounded.length - 1);
  });

  it('shrinks the evidence rather than dropping it when the budget is tight', () => {
    // The instruction block carries the abstention token, so it must survive;
    // the evidence is what gives. Asserting the surviving token and the bound
    // is asserting the priority order.
    const bounded = buildPrompt('Q?', [turn('x'.repeat(5_000))], 'extractive', { maxChars: 200 });

    expect(bounded).toContain('INSUFFICIENT_EVIDENCE');
    expect(bounded).toContain('1. x');
    expect(bounded.length).toBeLessThanOrEqual(200);
    // Evidence is present but much shorter than the input.
    expect(bounded.split('x').length - 1).toBeLessThan(200);
  });

  it('never exceeds the budget, at any budget', () => {
    const long = turn('x'.repeat(5_000));
    const full = buildPrompt('Q?', [long], 'extractive').length;

    for (let budget = 1; budget <= full + 5; budget += 1) {
      const bounded = buildPrompt('Q?', [long], 'extractive', { maxChars: budget });
      expect(bounded.length).toBeLessThanOrEqual(budget);
    }
  });

  it('keeps the abstention token monotonically once it fits', () => {
    // Two earlier implementations failed this. The first truncated from the
    // end, so a small budget dropped the token while keeping the evidence. The
    // second split the decision across an early return and a separate
    // truncation branch that allocated differently, so the token appeared at
    // one budget, vanished at a larger one, and reappeared later. Monotonicity
    // is the property that distinguishes a priority order from two heuristics
    // that happen to agree at the sampled points.
    const long = turn('x'.repeat(5_000));
    const full = buildPrompt('Q?', [long], 'extractive').length;
    const tokenFitsAt = findBudgetWhere(long, 'INSUFFICIENT_EVIDENCE');

    for (let budget = tokenFitsAt; budget <= full; budget += 1) {
      expect(buildPrompt('Q?', [long], 'extractive', { maxChars: budget })).toContain(
        'INSUFFICIENT_EVIDENCE',
      );
    }
  });

  it('returns an empty prompt when the budget cannot hold a single character', () => {
    // `maxChars: 0` is a caller error, but a thrown exception here would abort
    // a whole benchmark run over one bad option. An empty string is the honest
    // result: there is no room for anything, including the token.
    expect(buildPrompt('Q?', [turn('x')], 'extractive', { maxChars: 0 })).toBe('');
    expect(buildSessionPrompt('Q?', [], { maxChars: 0 })).toBe('');
  });

  it('spends the budget on the instruction block before the question', () => {
    // The priority order is the function's entire content, so it is asserted
    // directly: at a budget too small for both, the instruction survives and
    // the question does not.
    const long = turn('x'.repeat(5_000));
    const tokenFitsAt = findBudgetWhere(long, 'INSUFFICIENT_EVIDENCE');
    const questionFitsAt = findBudgetWhere(long, 'QUESTION:');

    expect(tokenFitsAt).toBeLessThanOrEqual(questionFitsAt);
    const tight = buildPrompt('Q?', [long], 'extractive', { maxChars: tokenFitsAt });
    expect(tight).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('spends the budget on the question before the evidence', () => {
    const long = turn('x'.repeat(5_000));
    const full = buildPrompt('Q?', [long], 'extractive').length;
    const questionFitsAt = findBudgetWhere(long, 'QUESTION:');

    expect(questionFitsAt).toBeLessThanOrEqual(full);
    expect(buildPrompt('Q?', [long], 'extractive', { maxChars: questionFitsAt })).toContain(
      'QUESTION:',
    );
    // One below the threshold, the question is gone and the budget still fits.
    const justBelow = buildPrompt('Q?', [long], 'extractive', { maxChars: questionFitsAt - 1 });
    expect(justBelow).not.toContain('QUESTION:');
    expect(justBelow.length).toBeLessThanOrEqual(questionFitsAt - 1);
  });

  it('still returns a string when the budget cannot fit the instruction block', () => {
    // Degenerate but reachable: a caller that sets a budget below the fixed
    // overhead. The result is clipped rather than thrown, because a thrown
    // error here would abort a whole benchmark run over one bad option.
    const bounded = buildPrompt('Q?', [turn('a')], 'extractive', { maxChars: 10 });

    expect(typeof bounded).toBe('string');
    expect(bounded.length).toBeLessThanOrEqual(10);
  });

  it('applies the same budget rules to a session prompt', () => {
    const session: AdmittedSession = { index: 0, size: 1, turns: [turn('a'.repeat(400))] };
    const unbounded = buildSessionPrompt('Q?', [session]);
    const bounded = buildSessionPrompt('Q?', [session], { maxChars: unbounded.length - 1 });

    expect(bounded.length).toBeLessThanOrEqual(unbounded.length - 1);
    expect(bounded).toContain('Reply with the answer alone.');
  });

  it('labels a session prompt with the session number', () => {
    const sessions: AdmittedSession[] = [
      { index: 0, size: 1, turns: [turn('first')] },
      { index: 2, size: 1, turns: [turn('third')] },
    ];

    const prompt = buildSessionPrompt('Q?', sessions);

    // The label uses the source index, not the presentation position, so a
    // reader can match a block back to the session it came from.
    expect(prompt).toContain('Session 1');
    expect(prompt).toContain('Session 3');
  });

  it('explains the empty case in a session prompt rather than omitting the section', () => {
    const prompt = buildSessionPrompt('Q?', []);

    expect(prompt).toContain('(no evidence was admitted for this question)');
  });

  it('clips a session prompt that cannot fit its own instruction block', () => {
    const session: AdmittedSession = { index: 0, size: 1, turns: [turn('a')] };
    const bounded = buildSessionPrompt('Q?', [session], { maxChars: 10 });

    expect(bounded.length).toBeLessThanOrEqual(10);
  });
});

describe('truncateCodePointSafe boundaries', () => {
  it('keeps a whole astral character that ends exactly at the limit', () => {
    const emoji = '\u{1F600}';
    expect(truncateCodePointSafe(emoji, 2)).toBe(emoji);
  });

  it('drops a high surrogate left at the cut point', () => {
    const text = `ab\u{1F600}`;
    expect(truncateCodePointSafe(text, 3)).toBe('ab');
  });

  it('handles text made only of astral characters', () => {
    const emoji = '\u{1F600}';
    expect(truncateCodePointSafe(emoji.repeat(3), 5)).toBe(emoji.repeat(2));
  });
});

describe('parseAnswer on structurally odd input', () => {
  it('treats a token on the last line as a decision, whatever precedes it', () => {
    const raw = 'Here is my reasoning.\nIt is long and discursive.\nINSUFFICIENT_EVIDENCE';
    expect(parseAnswer(raw)).toBeNull();
  });

  it('ignores blank lines when locating the decision line', () => {
    expect(parseAnswer(`INSUFFICIENT_EVIDENCE\n\n  \n`)).toBeNull();
  });

  it('keeps a token that is not on the final line as part of the answer', () => {
    // The rule is "the last non-empty line decides". A token on line 1 with an
    // answer on line 2 is a quote, not a decision.
    const raw = 'INSUFFICIENT_EVIDENCE is the token the prompt names.\nParis';
    expect(parseAnswer(raw)).toBe(raw);
  });
});

describe('CortexMemory option branches', () => {
  it('uses the default name when none is supplied', () => {
    expect(new CortexMemory(options(new NoopLlm())).name).toBe('cortex-memory');
  });

  it('passes maxPromptChars through to prompt construction', async () => {
    const llm = new NoopLlm();
    const system = new CortexMemory(options(llm, { maxPromptChars: 120 }));

    await system.answer('Q?', ['turn '.repeat(200)]);

    expect(llm.prompts[0]?.length).toBeLessThanOrEqual(120);
  });

  it('passes an injected value function through the session path', async () => {
    const llm = new NoopLlm();
    const system = new CortexMemory(
      options(llm, {
        gate: {
          threshold: 0.5,
          sessionBudget: 10,
          valueFunction: (memory) => (memory.content === 'keep' ? 0.9 : 0.1),
        },
      }),
    );

    await system.answerSessions('Q?', [['keep'], ['drop']]);

    expect(llm.prompts[0]).toContain('keep');
    expect(llm.prompts[0]).not.toContain('drop');
  });

  it('falls back to the flat context when sessions are present but empty', async () => {
    // An MR question carries `sessions` only when the dataset has boundaries.
    // An empty group is not a boundary, so the flat context must still be used
    // instead of returning a spurious abstention.
    const llm = new NoopLlm();
    const system = new CortexMemory(options(llm));

    const answer = await system.answer('Q?', ['flat evidence'], []);

    expect(answer).toBe('ok');
    expect(llm.prompts[0]).toContain('flat evidence');
  });

  it('flattens sessions for a path that has no boundary presentation', async () => {
    // `answerAssistant` receives sessions but renders one block: the assistant
    // contract is about turn authorship, not about boundaries, and inventing
    // session labels it never promised would be a silent contract change.
    const llm = new NoopLlm();
    const system = new CortexMemory(options(llm));

    await system.answerAssistant('Q?', ['unused flat'], [['from session']]);

    expect(llm.prompts[0]).toContain('from session');
  });

  it('returns null when sessions admit nothing on a flat-only path', async () => {
    const llm = new NoopLlm();
    const system = new CortexMemory(options(llm, { gate: { threshold: 2, sessionBudget: 10 } }));

    expect(await system.answerAssistant('Q?', ['x'], [['y']])).toBeNull();
    expect(llm.prompts).toEqual([]);
  });
});
