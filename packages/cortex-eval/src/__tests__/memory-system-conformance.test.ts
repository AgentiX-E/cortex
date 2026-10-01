/**
 * The `MemorySystem` conformance suite: what it means to *be* a memory system,
 * asserted executably.
 *
 * ## Why this file exists
 *
 * `AUDIT-CODE-VS-DOCS.md` §6.2 step 1 names its verification as "`cortex-memory`
 * passes the existing `MemorySystem` conformance tests". `AUDIT-EVAL-CONTRACTS.md`
 * records that **no such suite existed**: `grep -rn conformance packages/` returned
 * nothing, and `MemorySystem` appeared in the repository only as a type annotation
 * and an `implements` clause. The type said what shape an object must have; nothing
 * said what a system must do.
 *
 * That gap is not pedantic, because the contract is not "implement `answer`". It is
 * "implement `answer`, and every optional path you declare will be routed to, with
 * these argument shapes, and must return `Answer`". A system can satisfy the type
 * and be wrong about all of it:
 *
 *   - declare `answerSessions` and return `undefined` for an empty session list;
 *   - declare `answerAbstention` and return a non-null answer, silently converting
 *     the abstention block into a wrong-answer block;
 *   - declare nothing optional and still be routed correctly.
 *
 * ## What is asserted, and why these properties
 *
 * The subject is `runBenchmark`'s **routing contract**: for each of the seven
 * optional members, is the system called on it, and with what? That is what decides
 * whether declaring a member helps or hurts, so it is what a conformance suite has
 * to pin. The suite describes behaviour that already holds — it is a characterisation
 * test, written to be run against implementations that do not exist yet, which is
 * exactly the point: it is the specification `cortex-memory` will be built against.
 *
 * Two properties are checked that a type cannot express:
 *
 *   1. **Minimality.** `{ name, answer }` alone is fully conformant, and receives
 *      every question. A system that declares nothing must still work, because that
 *      is the configuration a new implementation starts from.
 *   2. **Precedence.** When several optional members are declared, which one wins is
 *      decided by a fixed branch order (`ABS` before `single-session-assistant`, for
 *      instance, because an ABS question may also carry that question type). The
 *      order is load-bearing and is asserted rather than left to be inferred from
 *      source.
 *
 * ## What is deliberately NOT asserted
 *
 * Answer correctness. That is the benchmark's job and needs an LLM; the routing is
 * the harness's job and needs a recorder. Every system here returns a constant per
 * path, so a failure names a routing decision and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../benchmark.js';
import type { Answer, BenchmarkDataset, MemorySystem, SessionAwareMemorySystem } from '../types.js';

/**
 * One question per routable shape, so a routing test can name the branch it means.
 *
 * The shapes are the ones `runBenchmark` distinguishes. `questionType` is set only
 * on the three questions that need it, because the branch tests it against a
 * literal.
 */
const ROUTING_DATASET: BenchmarkDataset = {
  name: 'conformance-routing',
  questions: [
    {
      id: 'mr-multi-session',
      capability: 'MR',
      question: 'multi-session',
      expected: null,
      context: ['flat'],
      sessions: [['s1'], ['s2']],
    },
    {
      id: 'mr-no-sessions',
      capability: 'MR',
      question: 'mr without session boundaries',
      expected: null,
      context: ['flat'],
    },
    {
      id: 'tr',
      capability: 'TR',
      question: 'temporal',
      expected: null,
      context: ['flat'],
      questionDate: '2024/03/01',
      sessions: [['s1']],
    },
    {
      id: 'abs',
      capability: 'ABS',
      question: 'abstention',
      expected: null,
      context: ['flat'],
      sessions: [['s1']],
    },
    {
      id: 'abs-but-assistant-typed',
      capability: 'ABS',
      questionType: 'single-session-assistant',
      question: 'abstention carrying the assistant question type',
      expected: null,
      context: ['flat'],
      sessions: [['s1']],
    },
    {
      id: 'assistant',
      capability: 'IE',
      questionType: 'single-session-assistant',
      question: 'assistant evidence',
      expected: null,
      context: ['flat'],
      sessions: [['s1']],
    },
    {
      id: 'preference',
      capability: 'IE',
      questionType: 'single-session-preference',
      question: 'preference',
      expected: null,
      context: ['flat'],
      sessions: [['s1']],
    },
    {
      id: 'knowledge-update',
      capability: 'IE',
      questionType: 'knowledge-update',
      question: 'knowledge update',
      expected: null,
      context: ['flat'],
      sessions: [['s1']],
    },
    {
      id: 'plain',
      capability: 'IE',
      question: 'plain extractive',
      expected: null,
      context: ['flat'],
      sessions: [['s1']],
    },
  ],
};

/** Ids in dataset order, so an assertion about `calls` reads as a routing table. */
const QUESTION_IDS = ROUTING_DATASET.questions.map((q) => q.id);

/**
 * A recorder that implements every optional path, each returning its own name.
 *
 * Returning the path name rather than a constant means the answer vector *is* the
 * routing decision, so a mis-route cannot be masked by two paths agreeing.
 */
function recordingSystem(calls: string[]): SessionAwareMemorySystem {
  const record =
    (label: string): (() => Answer) =>
    () => {
      calls.push(label);
      return label;
    };
  return {
    name: 'recording',
    answer: record('answer'),
    answerSessions: async () => record('answerSessions')(),
    answerTemporal: async () => record('answerTemporal')(),
    answerAbstention: async () => record('answerAbstention')(),
    answerAssistant: async () => record('answerAssistant')(),
    answerPreference: async () => record('answerPreference')(),
    answerKnowledgeUpdate: async () => record('answerKnowledgeUpdate')(),
  };
}

describe('the minimal MemorySystem is conformant', () => {
  it('accepts an object with only name and answer', async () => {
    // The configuration a new implementation starts from. If this did not work,
    // every system would have to declare the full optional surface to be usable,
    // and the optional members would not be optional.
    const minimal: MemorySystem = {
      name: 'minimal',
      answer: async () => 'ok',
    };
    const answers = await runBenchmark(ROUTING_DATASET, minimal);
    expect(answers).toHaveLength(QUESTION_IDS.length);
    expect(answers.every((a) => a === 'ok')).toBe(true);
  });

  it('passes the flat context and the sessions to answer', async () => {
    // `sessions` is optional and additive: a minimal system must be able to ignore
    // it, but a system that wants it must receive it, and it must be the same turns
    // as `context` when the question carries both.
    type Seen = {
      question: string;
      context: string[];
      // Explicitly `| undefined`: `exactOptionalPropertyTypes` is on, and the
      // harness passes `sessions` positionally, so an absent value arrives as
      // `undefined` rather than as an absent key.
      sessions: string[][] | undefined;
    };
    const seen: Seen[] = [];
    const system: MemorySystem = {
      name: 'observer',
      answer: async (question, context, sessions) => {
        seen.push({ question, context, sessions });
        return null;
      },
    };
    await runBenchmark(ROUTING_DATASET, system);

    const assistant = seen[QUESTION_IDS.indexOf('assistant')]!;
    expect(assistant.question).toBe('assistant evidence');
    expect(assistant.context).toEqual(['flat']);
    expect(assistant.sessions).toEqual([['s1']]);
  });
});

describe('every declared optional path is routed to', () => {
  it('sends each question shape to the member that declares it', async () => {
    // The routing table, asserted as a table. Each entry names one branch of
    // `runBenchmark`'s dispatch; a change to the branch order moves a row.
    const calls: string[] = [];
    await runBenchmark(ROUTING_DATASET, recordingSystem(calls));

    expect(calls).toEqual([
      'answerSessions', // MR with session boundaries
      'answer', // MR without them: no sessions to route on
      'answerTemporal', // TR with a declared temporal path
      'answerAbstention', // ABS
      'answerAbstention', // ABS wins over the assistant question type
      'answerAssistant', // single-session-assistant, capability IE
      'answerPreference', // single-session-preference
      'answerKnowledgeUpdate', // knowledge-update
      'answer', // plain extractive fallback
    ]);
  });

  it('routes an abstention question to abstention even when it is also assistant-typed', async () => {
    // Asserted separately from the table because the ORDER is the substance: the
    // abstention branch is tested before the assistant branch on purpose, since an
    // ABS question may carry `single-session-assistant`. Reversing the two branches
    // keeps the table above correct only by accident, and changes this answer.
    const calls: string[] = [];
    const answers = await runBenchmark(ROUTING_DATASET, recordingSystem(calls));
    const index = QUESTION_IDS.indexOf('abs-but-assistant-typed');
    expect(answers[index]).toBe('answerAbstention');
  });

  it('falls back to answer for a capability whose optional member is absent', async () => {
    // Declaring `answerSessions` but not `answerTemporal` means TR questions take
    // the extractive path. The fallback must be per-member, not all-or-nothing:
    // a session-aware system is not thereby a temporal one.
    const calls: string[] = [];
    const partial: SessionAwareMemorySystem = {
      name: 'partial',
      answer: async () => {
        calls.push('answer');
        return 'answer';
      },
      answerSessions: async () => {
        calls.push('answerSessions');
        return 'answerSessions';
      },
    };
    const answers = await runBenchmark(ROUTING_DATASET, partial);
    expect(calls).toEqual([
      'answerSessions',
      'answer',
      'answer',
      'answer',
      'answer',
      'answer',
      'answer',
      'answer',
      'answer',
    ]);
    expect(answers[QUESTION_IDS.indexOf('tr')]).toBe('answer');
  });

  it('does not route to a path that is not declared', async () => {
    // The converse guard: a system without `answerSessions` must never have it
    // called, which is what makes the minimal system above safe. Asserted by
    // giving the object an `answerSessions`-shaped property under a different name,
    // so a duck-typing implementation that probed for "a function returning an
    // answer" rather than for the member name would be caught.
    const calls: string[] = [];
    const sneaky: MemorySystem & { sessionAnswer: unknown } = {
      name: 'sneaky',
      answer: async () => {
        calls.push('answer');
        return 'answer';
      },
      sessionAnswer: async () => {
        calls.push('sessionAnswer');
        return 'sessionAnswer';
      },
    };
    const answers = await runBenchmark(ROUTING_DATASET, sneaky);
    expect(calls.every((c) => c === 'answer')).toBe(true);
    expect(answers.every((a) => a === 'answer')).toBe(true);
  });
});

describe('answers conform to the Answer contract', () => {
  it('accepts a null answer, which means abstention', async () => {
    // `Answer = string | null`, and `null` is a first-class value, not an error.
    // A system whose whole output is `null` is conformant; it scores badly, which
    // is the benchmark's problem, not the contract's.
    const abstaining: MemorySystem = { name: 'abstain', answer: async () => null };
    const answers = await runBenchmark(ROUTING_DATASET, abstaining);
    expect(answers).toEqual(ROUTING_DATASET.questions.map(() => null));
  });

  it('accepts a synchronously returned answer', async () => {
    // The contract is `Answer | Promise<Answer>`, so a system that does no I/O may
    // return directly. Exercised because the harness must `await` uniformly: a
    // harness that called `.then` on the result would pass the async tests and fail
    // this one.
    const sync: MemorySystem = { name: 'sync', answer: () => 'sync' };
    const answers = await runBenchmark(ROUTING_DATASET, sync);
    expect(answers.every((a) => a === 'sync')).toBe(true);
  });

  it('accepts an empty string, which is an answer and not an abstention', async () => {
    // Distinguishing `''` from `null` is the reason `Answer` is a union rather
    // than `string | undefined`: an empty answer and a refused answer score
    // differently and must be routable to different code.
    const empty: MemorySystem = { name: 'empty', answer: () => '' };
    const answers = await runBenchmark(ROUTING_DATASET, empty);
    expect(answers.every((a) => a === '')).toBe(true);
    expect(answers.some((a) => a === null)).toBe(false);
  });
});

describe('the contract is structural, not nominal', () => {
  it('accepts a plain object literal with no class and no import of the type', async () => {
    // This is what makes §6.2 step 1 cheap: a package in another workspace project
    // that has never heard of `cortex-eval` satisfies the contract by declaring two
    // members. Asserted by building the object through `as const` at the call site
    // rather than annotating it with `MemorySystem`, so the object's own type is
    // inferred and the assignability check is what the test exercises.
    const structural = {
      name: 'structural',
      answer: (question: string) => `answered:${question}`,
    };
    const answers = await runBenchmark(ROUTING_DATASET, structural);
    expect(answers[0]).toBe('answered:multi-session');
  });

  it('preserves dataset question order in the answers', async () => {
    // Order is the harness's contract with every paired test: McNemar pairs two
    // systems' answer vectors position by position, so a harness that reordered
    // would silently correlate the wrong questions and produce a confident wrong
    // p-value.
    const echoing: MemorySystem = { name: 'echo', answer: (q) => q };
    const answers = await runBenchmark(ROUTING_DATASET, echoing);
    expect(answers).toEqual(ROUTING_DATASET.questions.map((q) => q.question));
  });
});
