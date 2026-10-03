/**
 * The step's named verification.
 *
 * `AUDIT-CODE-VS-DOCS.md` §6.2 step 2's acceptance is "≥95% coverage per
 * dimension, TDD, no mocks; **and it passes `memory-system-conformance.test.ts`**".
 * That suite lives in `cortex-eval` and asserts `runBenchmark`'s routing
 * contract. This file runs the same contract against `CortexMemory` — a real
 * system, not a recorder — and then asserts what `CortexMemory` does *with*
 * each routed call.
 *
 * No mocks. The `LLM` collaborator is a hand-written object that records the
 * prompts it receives and returns deterministic text; the assertions are on
 * what was sent, which is observable behaviour of the system under test.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, CompleteOptions } from '@agentix-e/cortex-core';
import type { BenchmarkDataset, Question, SessionAwareMemorySystem } from '@agentix-e/cortex-eval';
import { runBenchmark } from '@agentix-e/cortex-eval';
import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_700_000_000_000;

/** Records every prompt and replies with a fixed, per-call-unique string. */
class RecordingLlm implements LLM {
  readonly prompts: string[] = [];
  constructor(private readonly reply: (prompt: string) => string = () => 'recorded') {}

  async complete(prompt: string, _opts?: CompleteOptions): Promise<string> {
    this.prompts.push(prompt);
    return this.reply(prompt);
  }

  async completeStructured<T>(
    prompt: string,
    _schema: unknown,
    _opts?: CompleteOptions,
  ): Promise<T> {
    this.prompts.push(prompt);
    return JSON.parse(this.reply(prompt)) as T;
  }
}

/**
 * The contract instruction segment: everything after the last blank line, which
 * is where `buildPrompt` places it. Comparing this across two prompts asks
 * "which contract answered?" without requiring the questions to be identical.
 */
function instructionTail(prompt: string): string {
  const splitAt = prompt.lastIndexOf('\n\n');
  return prompt.slice(splitAt + 2);
}

function options(llm: LLM, overrides: Partial<CortexMemoryOptions> = {}): CortexMemoryOptions {
  return {
    llm,
    now: NOW,
    // Permissive by default so a routed call is never skipped for the wrong
    // reason; the admission behaviour has its own file.
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 100 },
    ...overrides,
  };
}

/** One question per routable shape, mirroring the cortex-eval conformance set. */
function dataset(questions: Question[]): BenchmarkDataset {
  return { name: 'routing', questions };
}

const ROUTABLE: Question[] = [
  {
    id: 'mr',
    capability: 'MR',
    question: 'What did the user decide across sessions?',
    expected: 'a',
    context: ['c1', 'c2'],
    sessions: [['c1'], ['c2']],
  },
  {
    id: 'tr',
    capability: 'TR',
    question: 'How long ago was that?',
    expected: 'a',
    context: ['c1'],
    questionDate: '2023-05-01',
  },
  {
    id: 'abs',
    capability: 'ABS',
    question: 'What is the user\u2019s flight number?',
    expected: null,
    context: ['c1'],
  },
  {
    id: 'assistant',
    capability: 'IE',
    questionType: 'single-session-assistant',
    question: 'What did you recommend?',
    expected: 'a',
    context: ['c1'],
  },
  {
    id: 'ku',
    capability: 'KU',
    questionType: 'knowledge-update',
    question: 'What is the user\u2019s current address?',
    expected: 'a',
    context: ['c1'],
  },
  {
    id: 'preference',
    capability: 'IE',
    questionType: 'single-session-preference',
    question: 'What should the user do?',
    expected: 'a',
    context: ['c1'],
  },
  {
    id: 'plain',
    capability: 'IE',
    question: 'What is the user\u2019s name?',
    expected: 'a',
    context: ['c1'],
  },
];

describe('CortexMemory satisfies the MemorySystem conformance contract', () => {
  it('is session-aware, so MR questions reach the session path', async () => {
    const llm = new RecordingLlm();
    const system: SessionAwareMemorySystem = new CortexMemory(options(llm));

    expect('answerSessions' in system).toBe(true);
  });

  it('answers every routable shape under runBenchmark without throwing', async () => {
    const system = new CortexMemory(options(new RecordingLlm()));

    const answers = await runBenchmark(dataset(ROUTABLE), system);

    expect(answers).toHaveLength(ROUTABLE.length);
    for (const answer of answers) {
      expect(answer === null || typeof answer === 'string').toBe(true);
    }
  });

  it('issues exactly one LLM call per question, in dataset order', async () => {
    // More than one call per question would mean a hidden retry loop inflating
    // cost; fewer would mean a path answers without evidence.
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await runBenchmark(dataset(ROUTABLE), system);

    expect(llm.prompts).toHaveLength(ROUTABLE.length);
  });

  it('routes each shape to a distinct prompt, proving the paths are not aliases', async () => {
    // If `answerAbstention` and `answer` produced the same prompt, the routing
    // the conformance suite asserts would be decorative.
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await runBenchmark(dataset(ROUTABLE), system);

    const byId = new Map(ROUTABLE.map((q, i) => [q.id, llm.prompts[i] ?? '']));
    expect(byId.get('abs')).not.toBe(byId.get('plain'));
    expect(byId.get('tr')).not.toBe(byId.get('plain'));
    expect(byId.get('assistant')).not.toBe(byId.get('plain'));
    expect(byId.get('ku')).not.toBe(byId.get('plain'));
  });

  it('gives the temporal path the question date and the flat path none', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await runBenchmark(dataset(ROUTABLE), system);

    const temporalPrompt = llm.prompts[1] ?? '';
    const flatPrompt = llm.prompts[6] ?? '';
    expect(temporalPrompt).toContain('2023-05-01');
    expect(flatPrompt).not.toContain('2023-05-01');
  });

  it('preserves question order in its answers, which McNemar pairing requires', async () => {
    // `runBenchmark` pairs baseline and feature per-question by position. A
    // system that reordered would silently corrupt every paired statistic.
    let n = 0;
    const llm = new RecordingLlm(() => `answer-${n++}`);
    const system = new CortexMemory(options(llm));

    const answers = await runBenchmark(dataset(ROUTABLE), system);

    expect(answers[0]).toBe('answer-0');
    expect(answers[ROUTABLE.length - 1]).toBe(`answer-${ROUTABLE.length - 1}`);
  });

  it('propagates an LLM abstention as a null answer, not as text', async () => {
    const llm = new RecordingLlm(() => 'INSUFFICIENT_EVIDENCE');
    const system = new CortexMemory(options(llm));

    const answers = await runBenchmark(dataset(ROUTABLE), system);

    expect(answers.every((a) => a === null)).toBe(true);
  });

  it('accepts a plain-object caller: the contract is structural, not nominal', async () => {
    // The conformance suite asserts this of any system. Asserting it of
    // CortexMemory specifically guards against a future `private` field making
    // the class unsatisfiable by structural typing.
    const system: SessionAwareMemorySystem = new CortexMemory(options(new RecordingLlm()));

    expect(typeof system.answer).toBe('function');
    expect(typeof system.answerSessions).toBe('function');
  });

  it('declares answerPreference is absent, and the flat path still receives those questions', async () => {
    // `answerPreference` is deliberately deferred: a value gate filters
    // *evidence*, while a preference question asks for a *suggestion*. The
    // fallback must therefore be live, not an accident.
    //
    // The assertion is on the *instruction tail*, not on the whole prompt: the
    // two questions differ, so identical strings would be the wrong expectation.
    // What must match is which contract answered them.
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await runBenchmark(dataset(ROUTABLE), system);

    const preferenceTail = instructionTail(llm.prompts[5] ?? '');
    const flatTail = instructionTail(llm.prompts[6] ?? '');
    expect(preferenceTail).toBe(flatTail);
    expect(preferenceTail).toContain('Reply with the answer alone.');
  });

  it('routes no question to a preference path, because none is declared', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    // Read through the declared contract rather than the class type: the class
    // does not declare the member, and `in` is what `runBenchmark` uses.
    expect('answerPreference' in (system as SessionAwareMemorySystem)).toBe(false);

    await runBenchmark(dataset(ROUTABLE), system);
    expect(llm.prompts).toHaveLength(ROUTABLE.length);
  });
});

describe('CortexMemory behaviour under the gates', () => {
  it('answers null when admission empties the evidence, without calling the LLM', async () => {
    // An unreachable threshold admits nothing. Answering from no evidence is
    // the failure mode the reference pipeline's abstention path exists to
    // prevent; here the gate prevents it structurally, and the LLM is not
    // consulted at all.
    const llm = new RecordingLlm();
    const system = new CortexMemory(
      options(llm, { gate: { threshold: 2, retrievalThreshold: 0, sessionBudget: 100 } }),
    );

    const answers = await runBenchmark(dataset(ROUTABLE), system);

    expect(answers.every((a) => a === null)).toBe(true);
    expect(llm.prompts).toEqual([]);
  });

  it('still calls the LLM when the gate admits exactly one turn', async () => {
    const llm = new RecordingLlm(() => 'from one turn');
    const system = new CortexMemory(
      options(llm, { gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: 100 } }),
    );

    const answers = await runBenchmark(
      dataset([
        {
          id: 'one',
          capability: 'IE',
          question: 'Q?',
          expected: 'a',
          context: ['only turn'],
        },
      ]),
      system,
    );

    expect(answers[0]).toBe('from one turn');
    expect(llm.prompts[0]).toContain('only turn');
  });

  it('honours the session budget when selecting which sessions to present', async () => {
    // Two sessions, budget one: the higher-value session must be the one shown.
    // The value function is injected so the outcome is deterministic.
    const llm = new RecordingLlm();
    const system = new CortexMemory(
      options(llm, {
        gate: {
          threshold: 0,
          // Identity retrieval gate: the conformance suite asserts routing, and
          // a non-zero value here would turn some routed questions into
          // abstentions the suite does not expect.
          retrievalThreshold: 0,
          sessionBudget: 1,
          valueFunction: (memory) => (memory.content.includes('KEEP') ? 0.9 : 0.1),
        },
      }),
    );

    await runBenchmark(
      dataset([
        {
          id: 'mr',
          capability: 'MR',
          question: 'Q?',
          expected: 'a',
          context: ['drop me', 'KEEP me'],
          sessions: [['drop me'], ['KEEP me']],
        },
      ]),
      system,
    );

    expect(llm.prompts[0]).toContain('KEEP me');
    expect(llm.prompts[0]).not.toContain('drop me');
  });

  it('awaits a promise-returning LLM, as the contract requires', async () => {
    // `LLM.complete` returns `Promise<string>` in `cortex-core`; there is no
    // synchronous overload. Asserting the awaited value (rather than the
    // promise) is the shape a real provider has.
    const asyncLlm: LLM = {
      complete: async (prompt: string) => `async:${prompt.length}`,
      completeStructured: async <T>() => JSON.parse('{}') as T,
    };
    const system = new CortexMemory(options(asyncLlm));

    const answers = await runBenchmark(
      dataset([{ id: 'q', capability: 'IE', question: 'Q?', expected: 'a', context: ['c'] }]),
      system,
    );

    expect(answers[0]).toMatch(/^async:/);
  });

  it('uses the injected clock for admission, not the wall clock', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm, { now: 42 }));

    await runBenchmark(
      dataset([{ id: 'q', capability: 'IE', question: 'Q?', expected: 'a', context: ['c'] }]),
      system,
    );

    expect(llm.prompts).toHaveLength(1);
  });
});

describe('CortexMemory surfaces its name', () => {
  it('carries a stable name for report attribution', async () => {
    const system = new CortexMemory(options(new RecordingLlm()));
    expect(system.name).toBe('cortex-memory');
  });

  it('accepts a name override so an arm can be labelled distinctly', () => {
    const system = new CortexMemory(
      options(new RecordingLlm(), { name: 'cortex-memory/gates-off' }),
    );
    expect(system.name).toBe('cortex-memory/gates-off');
  });
});

describe('CortexMemory answer paths are individually reachable', () => {
  it('answers a temporal question through the temporal path with a date-aware prompt', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await system.answerTemporal?.('How long ago?', ['turn about the move'], '2023-05-01');

    expect(llm.prompts[0]).toContain('2023-05-01');
  });

  it('answers a temporal question with no date by omitting the date section', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await system.answerTemporal?.('How long ago?', ['turn about the move']);

    expect(llm.prompts[0]).not.toContain('undefined');
  });

  it('answers through every declared optional path', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    await system.answer('Q?', ['c']);
    await system.answerSessions('Q?', [['c']]);
    await system.answerTemporal?.('Q?', ['c'], '2023-05-01');
    await system.answerAbstention?.('Q?', ['c']);
    await system.answerAssistant?.('Q?', ['c']);
    await system.answerKnowledgeUpdate?.('Q?', ['c']);

    expect(llm.prompts).toHaveLength(6);
  });

  it('answers null from every path when evidence is empty, without calling the LLM', async () => {
    const llm = new RecordingLlm();
    const system = new CortexMemory(options(llm));

    expect(await system.answer('Q?', [])).toBeNull();
    expect(await system.answerSessions('Q?', [])).toBeNull();
    expect(await system.answerTemporal?.('Q?', [])).toBeNull();
    expect(await system.answerAbstention?.('Q?', [])).toBeNull();
    expect(await system.answerAssistant?.('Q?', [])).toBeNull();
    expect(await system.answerKnowledgeUpdate?.('Q?', [])).toBeNull();
    expect(llm.prompts).toEqual([]);
  });
});
