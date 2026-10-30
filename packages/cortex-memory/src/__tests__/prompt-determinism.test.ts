/**
 * The arm's prompt is a function of the question, the evidence and the configuration -- nothing else.
 *
 * ## Why this is a test and not an assumption
 *
 * Run `41090564131` read `featurePromptVariants = 4` on **all 500 questions**: four passes, four prompts. Two
 * dispatches of the identical configuration then delivered byte-identical evidence -- same carried turns,
 * same order, same character count -- with `0/500` equal `promptDigest` values. Between those two facts the
 * arm is either stateful (a repeated question does not produce a repeated prompt) or the drift is in the
 * inputs, and the campaign cannot tell which without a measurement.
 *
 * This is the measurement, at the layer that can make it without a dispatch: the same instance, the same
 * question, the same evidence, four times, on the three routes the arm actually uses. If the texts differ,
 * the arm carries state and every repetition in every artifact is a different treatment. If they agree, the
 * drift is in what the arm is handed and the next reading belongs to the bench rather than to this package.
 *
 * The constant relevance signal is the load-bearing case: `0.5` for every turn makes the ranking degenerate,
 * which is exactly the configuration that would expose an unstable tie-break or an ordering that depends on
 * how many times the sort has run.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';

const NOW = 1_759_470_000_000;

function llm(answer = 'Lisbon'): LLM {
  return {
    complete: async () => answer,
    completeStructured: async () => {
      throw new Error('unused');
    },
  };
}

function turns(n: number, chars: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const head = `[2023/05/2${i % 9} (Sat) 03:5${i % 10}] user: turn ${i} `;
    return head + 'x'.repeat(Math.max(0, chars - head.length));
  });
}

describe('the prompt is a function of its inputs, so a drift in it is a drift in them', () => {
  it('flat route, no relevance signal: four passes send one prompt', async () => {
    const memory = new CortexMemory({
      now: NOW,
      llm: llm(),
      gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    });
    const context = turns(40, 600);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await memory.answer('How many trips did I take?', context);
      seen.push(memory.lastPromptText() ?? '');
    }
    expect(new Set(seen).size).toBe(1);
  });

  it('flat route, constant relevance: four passes send one prompt', async () => {
    const memory = new CortexMemory({
      now: NOW,
      llm: llm(),
      gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
      relevanceFor: () => 0.5,
    });
    const context = turns(400, 700);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await memory.answer('How many trips did I take?', context);
      seen.push(memory.lastPromptText() ?? '');
    }
    // Every prompt is the same 23,498 bytes, which is what `fitToBudget` spends at the default ceiling.
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]!.length).toBe(23498);
  });

  it('multi-session route, constant relevance: four passes send one prompt', async () => {
    const memory = new CortexMemory({
      now: NOW,
      llm: llm(),
      gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
      relevanceFor: (_q: string, _t: string) => 0.5,
      evidenceRoles: ['user'],
      roleOf: (content: string) => (content.includes('user:') ? 'user' : 'assistant'),
      evidenceRolesRoutes: ['multi-session', 'temporal'],
      maxTurnChars: 400,
      maxTurnCharsRoutes: ['multi-session', 'temporal'],
      maxPromptChars: 48000,
    });
    const sessions = [0, 1, 2, 3, 4].map((s) => turns(30, 500).map((t) => `s${s} ${t}`));
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await memory.answerSessions('How much did I spend in total?', sessions);
      seen.push(memory.lastPromptText() ?? '');
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]!.length).toBe(47869);
  });
});

describe('the sourced rendering, which is the one that carries identity into the prompt', () => {
  /**
   * The route the first three cases could not reach.
   *
   * `formatEvidenceWithSources` renders `${index}. [${turn.id}] …`, and a turn's id came from
   * `crypto.randomUUID()` inside `createMemory`. So on this route -- and only on this route -- four
   * passes of the same question sent four different prompts, which is what `41144910162`'s witness
   * showed: four prompts agreeing on their first **14 bytes** and differing afterwards, byte-identical
   * once the UUID tokens were stripped.
   *
   * These two cases are the fix's contract: the same question over the same turns must send the same
   * bytes, citation labels included, or the prefix cache has nothing to reuse and every "repeat" in
   * every artifact is a different treatment.
   */
  it('flat route: four passes send one prompt, citation labels included', async () => {
    const memory = new CortexMemory({
      now: NOW,
      llm: llm(),
      gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
      promptContract: 'abstention-evidence-blocks',
    });
    const context = turns(20, 300);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await memory.answer('How many trips did I take?', context);
      seen.push(memory.lastPromptText() ?? '');
    }
    expect(new Set(seen).size).toBe(1);
    // The citation is present, so the assertion above is about ids rather than about their absence.
    expect(seen[0]).toMatch(/\[[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}\]/);
  });

  it('multi-session route: four passes send one prompt, citation labels included', async () => {
    const memory = new CortexMemory({
      now: NOW,
      llm: llm(),
      gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
      relevanceFor: (_q: string, _t: string) => 0.5,
      evidenceRoles: ['user'],
      roleOf: (content: string) => (content.includes('user:') ? 'user' : 'assistant'),
      evidenceRolesRoutes: ['multi-session', 'temporal'],
      maxTurnChars: 400,
      maxTurnCharsRoutes: ['multi-session', 'temporal'],
      maxPromptChars: 48000,
      promptContract: 'abstention-evidence-blocks',
    });
    const sessions = [0, 1, 2, 3, 4].map((s) => turns(30, 500).map((t) => `s${s} ${t}`));
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await memory.answerSessions('How much did I spend in total?', sessions);
      seen.push(memory.lastPromptText() ?? '');
    }
    expect(new Set(seen).size).toBe(1);
  });
});
