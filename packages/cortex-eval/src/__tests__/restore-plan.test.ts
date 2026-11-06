import { describe, expect, it } from 'vitest';

import type { LLM } from '@agentix-e/cortex-core';

import {
  readRestorePlanFromEnv,
  restrictDatasetToPlan,
  restoringReader,
  restoreBlock,
  type RestoreCall,
} from '../restore-plan.js';

/**
 * The variable's name as a literal rather than as an imported constant.
 *
 * A rename has to break this file -- the literal is how a test fails when the contract moves -- and
 * the module keeps the constant private so a caller cannot depend on the spelling.
 */
const PLAN_VARIABLE = 'CORTEX_RESTORE_PLAN';
const BANNER = 'ADDITIONAL EVIDENCE:';

/** Parse through the exported reader, which is the path a run takes. */
function parse(value: unknown): { source: string; entries: RestoreEntryShape[] } {
  return readRestorePlanFromEnv({ [PLAN_VARIABLE]: '/plan.json' }, () => JSON.stringify(value)) as {
    source: string;
    entries: RestoreEntryShape[];
  };
}

type RestoreEntryShape = {
  readonly questionId: string;
  readonly question: string;
  readonly turns: readonly string[];
  readonly recordedOutcome: 'correct' | 'incorrect';
};
import type { BenchmarkDataset } from '../types.js';

/**
 * A reader that records what it was sent and answers with a fixed string.
 *
 * The restore decorator's whole product is the prompt it forwards, so the fake has to keep it.
 * A fake that answered without recording would let every assertion below be written against the
 * decorator's own bookkeeping instead of the bytes that crossed the seam.
 */
function recordingReader(): { llm: LLM; sent: string[] } {
  const sent: string[] = [];
  const llm: LLM = {
    complete: (prompt: string) => {
      sent.push(prompt);
      return Promise.resolve('answer');
    },
    completeStructured: <T>(prompt: string) => {
      sent.push(prompt);
      return Promise.resolve({ ok: true } as T);
    },
  };
  return { llm, sent };
}

type PlanShape = { readonly source?: string; readonly entries?: readonly RestoreEntryShape[] };

function plan(overrides: PlanShape = {}) {
  const base = {
    source: 'run-42190193540',
    entries: [
      {
        questionId: 'q1',
        question: 'How many notebooks did I buy?',
        turns: ['user: I bought three notebooks.', 'assistant: Noted, three notebooks.'],
        recordedOutcome: 'incorrect' as const,
      },
      {
        questionId: 'q2',
        question: 'Which city did I move to?',
        turns: ['user: I moved to Lisbon.'],
        recordedOutcome: 'correct' as const,
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('parseRestorePlan', () => {
  it('reads a well-formed plan into entries with their recorded outcomes', () => {
    const parsed = parse({
      source: 'run-1',
      entries: [
        { questionId: 'a', question: 'Q a?', turns: ['t'], recordedOutcome: 'incorrect' },
        { questionId: 'b', question: 'Q b?', turns: ['t', 'u'], recordedOutcome: 'correct' },
      ],
    });
    expect(parsed.source).toBe('run-1');
    expect(parsed.entries.map((entry) => entry.questionId)).toEqual(['a', 'b']);
    expect(parsed.entries[1]?.turns).toEqual(['t', 'u']);
    expect(parsed.entries[0]?.recordedOutcome).toBe('incorrect');
  });

  it('copies the turn list rather than aliasing the parsed JSON', () => {
    // The plan arrives from `JSON.parse`, and a decorator that mutated the array would silently
    // change the plan every later question reads.
    const turns = ['only'];
    const parsed = parse({
      source: 'run-1',
      entries: [{ questionId: 'a', question: 'Q?', turns, recordedOutcome: 'correct' }],
    });
    turns.push('added later');
    expect(parsed.entries[0]?.turns).toEqual(['only']);
  });

  it('refuses a value that is not an object', () => {
    // `undefined` is absent from this list on purpose: a plan arrives through `JSON.parse`, which
    // cannot produce it, so the branch that would handle it is a branch no run can reach.
    for (const value of [null, 42, 'plan', []]) {
      expect(() => parse(value)).toThrow(/not an object/);
    }
  });

  it('refuses a plan with no source, because the population has to name its artifact', () => {
    expect(() => parse({ entries: [] })).toThrow(/`source`/);
    expect(() => parse({ source: '   ', entries: [] })).toThrow(/`source`/);
  });

  it('refuses a plan whose entries are missing or empty', () => {
    expect(() => parse({ source: 'r' })).toThrow(/`entries` must be an array/);
    expect(() => parse({ source: 'r', entries: {} })).toThrow(/`entries` must be an array/);
    expect(() => parse({ source: 'r', entries: [] })).toThrow(/would measure nothing/);
  });

  it('refuses an entry that is not an object', () => {
    expect(() => parse({ source: 'r', entries: ['q1'] })).toThrow(/entries\[0\] is not an object/);
  });

  it('refuses an entry without an id or without a question', () => {
    const base = { questionId: 'a', question: 'Q?', turns: ['t'], recordedOutcome: 'correct' };
    expect(() => parse({ source: 'r', entries: [{ ...base, questionId: '' }] })).toThrow(
      /questionId/,
    );
    expect(() => parse({ source: 'r', entries: [{ ...base, question: '' }] })).toThrow(
      /question must be a non-empty string/,
    );
    expect(() => parse({ source: 'r', entries: [{ ...base, questionId: undefined }] })).toThrow(
      /questionId/,
    );
  });

  it('refuses an entry with nothing to restore', () => {
    // The branch that matters most: an empty list would run the whole intervention with nothing in
    // it and report a clean null result -- the experiment would look like a refutation.
    const base = { questionId: 'a', question: 'Q?', recordedOutcome: 'correct' };
    expect(() => parse({ source: 'r', entries: [{ ...base, turns: [] }] })).toThrow(
      /no turns to restore/,
    );
    expect(() => parse({ source: 'r', entries: [{ ...base, turns: 't' }] })).toThrow(
      /no turns to restore/,
    );
  });

  it('refuses an empty or non-string turn', () => {
    const base = { questionId: 'a', question: 'Q?', recordedOutcome: 'correct' };
    expect(() => parse({ source: 'r', entries: [{ ...base, turns: [''] }] })).toThrow(/turns\[0\]/);
    expect(() => parse({ source: 'r', entries: [{ ...base, turns: [7] }] })).toThrow(/turns\[0\]/);
  });

  it('refuses an entry that does not say how the source run scored it', () => {
    // Without this field the analysis cannot tell the failure population from the control, and
    // reading them off the wrong side inverts gate 2 into its own opposite.
    for (const recordedOutcome of [undefined, 'wrong', 'CORRECT', true]) {
      expect(() =>
        parse({
          source: 'r',
          entries: [{ questionId: 'a', question: 'Q?', turns: ['t'], recordedOutcome }],
        }),
      ).toThrow(/correct/);
    }
  });

  it('refuses duplicate ids', () => {
    expect(() =>
      parse({
        source: 'r',
        entries: [
          { questionId: 'a', question: 'Q1?', turns: ['t'], recordedOutcome: 'correct' },
          { questionId: 'a', question: 'Q2?', turns: ['t'], recordedOutcome: 'correct' },
        ],
      }),
    ).toThrow(/duplicate questionId/);
  });

  it('refuses two entries that share a question text', () => {
    // The decorator matches on the question line, so one prompt would receive both blocks and the
    // insertion would be measured as a single intervention.
    expect(() =>
      parse({
        source: 'r',
        entries: [
          { questionId: 'a', question: 'Same?', turns: ['t'], recordedOutcome: 'correct' },
          { questionId: 'b', question: 'Same?', turns: ['u'], recordedOutcome: 'correct' },
        ],
      }),
    ).toThrow(/one prompt would receive both blocks/);
  });
});

describe('restoreBlock', () => {
  it('renders one bullet per turn under the banner, with no trailing text', () => {
    expect(restoreBlock({ turns: ['alpha', 'beta'] })).toBe(`\n${BANNER}\n- alpha\n- beta\n`);
  });

  it('opens with exactly one newline, because the insertion point is already a line break', () => {
    // Two would leave a paragraph of whitespace between the evidence and the banner; zero would run
    // the banner on from the last evidence turn and merge two blocks into one.
    const block = restoreBlock({ turns: ['alpha'] });
    expect(block.startsWith('\n')).toBe(true);
    expect(block.startsWith('\n\n')).toBe(false);
    expect(block.endsWith('\n')).toBe(true);
  });
});

describe('restoringReader', () => {
  const ask = (text: string) => `EVIDENCE:\n- something\n\nQUESTION: ${text}\nAnswer briefly.`;

  it('inserts the entry block immediately above the question line', () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    return reader.llm.complete(ask('How many notebooks did I buy?')).then(() => {
      const sent = inner.sent[0] ?? '';
      expect(sent).toContain(restoreBlock({ turns: plan().entries[0]?.turns ?? [] }));
      expect(sent.endsWith('\nQUESTION: How many notebooks did I buy?\nAnswer briefly.')).toBe(
        true,
      );
      // Above the ask, not after it: the block belongs to the evidence section.
      expect(sent.indexOf(BANNER)).toBeLessThan(sent.indexOf('QUESTION:'));
    });
  });

  it('leaves a prompt with no question line untouched and records it as unmatched', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.complete('Answer this without a labelled question.');
    expect(inner.sent[0]).toBe('Answer this without a labelled question.');
    expect(reader.calls).toEqual([
      { questionId: null, channel: 'complete', beforeChars: 40, afterChars: 40 },
    ]);
    expect(reader.unmatchedCalls()).toBe(1);
  });

  it('leaves a prompt for an unplanned question untouched', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.complete(ask('A question nobody planned.'));
    expect(inner.sent[0]).toBe(ask('A question nobody planned.'));
    expect(reader.unmatchedCalls()).toBe(1);
  });

  it('matches on the last question line, because the instructions quote the question too', async () => {
    // A prompt that opens with the marker in an instruction and closes with the ask must restore at
    // the ask. Taking the first occurrence would insert the block inside an instruction, which is a
    // different experiment that produces a plausible artifact.
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    const prompt = `QUESTION: ignored instruction line\nEVIDENCE:\n- x\n\nQUESTION: Which city did I move to?\nDone.`;
    await reader.llm.complete(prompt);
    const sent = inner.sent[0] ?? '';
    expect(sent.indexOf(BANNER)).toBeGreaterThan(sent.indexOf('EVIDENCE:'));
    expect(sent.endsWith('\nQUESTION: Which city did I move to?\nDone.')).toBe(true);
  });

  it('handles a question line that is the end of the prompt', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.complete('EVIDENCE:\n- x\n\nQUESTION: Which city did I move to?');
    // The slice keeps the newline that opened the question line, so the expectation spells it out
    // rather than concatenating around a character the block does not own.
    expect(inner.sent[0]).toBe(
      `EVIDENCE:\n- x\n${restoreBlock({ turns: ['user: I moved to Lisbon.'] })}\nQUESTION: Which city did I move to?`,
    );
  });

  it('decorates structured calls on the same rule and counts them on their own channel', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.completeStructured(ask('Which city did I move to?'), {
      type: 'object',
      properties: { answer: { type: 'string' } },
    });
    expect(inner.sent[0]).toContain(BANNER);
    expect(reader.calls.map((call) => call.channel)).toEqual(['structured']);
  });

  it('records the exact growth, which is what §13.267.3 gate 4 subtracts', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    const prompt = ask('Which city did I move to?');
    await reader.llm.complete(prompt);
    const call = reader.calls[0];
    expect(call?.beforeChars).toBe(prompt.length);
    expect(call?.afterChars).toBe(
      prompt.length + restoreBlock({ turns: ['user: I moved to Lisbon.'] }).length,
    );
    expect(call?.questionId).toBe('q2');
  });

  it('matches a question line the product truncated, when the prefix is unique', async () => {
    // `prompt.ts` truncates the question line when the evidence leaves no room, and those are
    // exactly the questions whose windows are full -- the population this instrument exists for. An
    // equality-only rule would report them unmatched and the run would look like an instrument fault.
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.complete('EVIDENCE:\n- x\n\nQUESTION: How many notebooks did I bu');
    expect(inner.sent[0]).toContain(BANNER);
    expect(reader.calls[0]?.questionId).toBe('q1');
  });

  it('refuses a truncated line too short to be unique', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.complete('EVIDENCE:\n- x\n\nQUESTION: Which');
    expect(inner.sent[0]).not.toContain(BANNER);
    expect(reader.unmatchedCalls()).toBe(1);
  });

  it('refuses a prefix two questions share rather than choosing one', async () => {
    // Picking one would put the wrong evidence in a prompt and report that it landed.
    const inner = recordingReader();
    const ambiguous = plan({
      entries: [
        {
          questionId: 'a',
          question: 'How many notebooks did I buy in Lisbon last year?',
          turns: ['t'],
          recordedOutcome: 'incorrect',
        },
        {
          questionId: 'b',
          question: 'How many notebooks did I buy in Lisbon this year?',
          turns: ['u'],
          recordedOutcome: 'correct',
        },
      ],
    });
    const reader = restoringReader(inner.llm, ambiguous);
    await reader.llm.complete('EVIDENCE:\n\nQUESTION: How many notebooks did I buy in Lisbon');
    expect(reader.unmatchedCalls()).toBe(1);
  });

  it('counts no unmatched calls when every prompt carried a planned question', async () => {
    const inner = recordingReader();
    const reader = restoringReader(inner.llm, plan());
    await reader.llm.complete(ask('Which city did I move to?'));
    await reader.llm.complete(ask('How many notebooks did I buy?'));
    expect(reader.unmatchedCalls()).toBe(0);
    expect(reader.calls.map((call) => call.questionId)).toEqual(['q2', 'q1']);
  });

  it('forwards the completion options the product passed', async () => {
    const seen: unknown[] = [];
    const inner: LLM = {
      complete: (_prompt: string, options?: unknown) => {
        seen.push(options);
        return Promise.resolve('a');
      },
      completeStructured: <T>(_prompt: string, _schema: unknown, options?: unknown) => {
        seen.push(options);
        return Promise.resolve({} as T);
      },
    };
    const reader = restoringReader(inner, plan());
    await reader.llm.complete(ask('Which city did I move to?'), { temperature: 0 });
    await reader.llm.completeStructured(
      ask('Which city did I move to?'),
      { type: 'object' },
      {
        temperature: 1,
      },
    );
    expect(seen).toEqual([{ temperature: 0 }, { temperature: 1 }]);
  });
});

describe('readRestorePlanFromEnv', () => {
  const body = JSON.stringify({
    source: 'run-1',
    entries: [{ questionId: 'a', question: 'Q?', turns: ['t'], recordedOutcome: 'incorrect' }],
  });

  it('answers null when the variable is absent, which is every ordinary run', () => {
    expect(readRestorePlanFromEnv({}, () => body)).toBeNull();
  });

  it('reads the file the variable names, through the reader it was given', () => {
    const asked: string[] = [];
    const planRead = readRestorePlanFromEnv({ [PLAN_VARIABLE]: ' /tmp/plan.json ' }, (path) => {
      asked.push(path);
      return body;
    });
    // Trimmed before the read: a YAML block scalar or a shell export leaves whitespace, and a path
    // that differs by a trailing space is a file-not-found at question zero of a paid run.
    expect(asked).toEqual(['/tmp/plan.json']);
    expect(planRead?.entries.map((entry) => entry.questionId)).toEqual(['a']);
  });

  it('refuses a set-but-empty variable rather than reading it as an ordinary run', () => {
    // The dangerous direction: a dispatch that meant to restore and named nothing would otherwise
    // run five hundred questions and answer a question nobody asked, at full price.
    expect(() => readRestorePlanFromEnv({ [PLAN_VARIABLE]: '   ' }, () => body)).toThrow(
      /set but empty/,
    );
  });

  it('refuses a file whose contents are not a plan', () => {
    expect(() => readRestorePlanFromEnv({ [PLAN_VARIABLE]: 'p' }, () => '{"entries":[]}')).toThrow(
      /`source`/,
    );
  });
});

describe('restricting and restoring together', () => {
  it('shares one ledger across two decorators, so two readers make one record', () => {
    // `readerByRoute` gives a run a second client; a per-reader ledger would be two records a
    // caller could concatenate wrongly, and the unmatched count would be per-reader too.
    const ledger: RestoreCall[] = [];
    const first = recordingReader();
    const second = recordingReader();
    const planValue = plan();
    const a = restoringReader(first.llm, planValue, ledger);
    const b = restoringReader(second.llm, planValue, ledger);
    expect(a.calls).toBe(ledger);
    expect(b.calls).toBe(ledger);
    return Promise.all([
      a.llm.complete('EVIDENCE:\n\nQUESTION: Which city did I move to?'),
      b.llm.complete('EVIDENCE:\n\nQUESTION: How many notebooks did I buy?'),
    ]).then(() => {
      expect(ledger.map((call) => call.questionId)).toEqual(['q2', 'q1']);
      expect(b.unmatchedCalls()).toBe(0);
    });
  });
});

describe('restrictDatasetToPlan', () => {
  function dataset(): BenchmarkDataset {
    return {
      name: 'longmemeval-s',
      questions: [
        {
          id: 'q1',
          capability: 'MR',
          question: 'Q1?',
          expected: 'x',
          context: ['c'],
        },
        {
          id: 'q9',
          capability: 'MR',
          question: 'Q9?',
          expected: 'y',
          context: ['c'],
        },
        {
          id: 'q2',
          capability: 'TR',
          question: 'Q2?',
          expected: 'z',
          context: ['c'],
        },
      ],
    };
  }

  it('keeps only the planned questions, in the dataset order', () => {
    const restricted = restrictDatasetToPlan(dataset(), plan());
    expect(restricted.questions.map((question) => question.id)).toEqual(['q1', 'q2']);
    expect(restricted.name).toBe('longmemeval-s');
  });

  it('refuses a plan entry the dataset cannot supply', () => {
    // A stale plan produces a run of fewer questions that calls itself the plan's size, and no
    // downstream number can put the missing one back.
    expect(() =>
      restrictDatasetToPlan(dataset(), {
        source: 'r',
        entries: [{ questionId: 'q404', question: 'Q?', turns: ['t'], recordedOutcome: 'correct' }],
      }),
    ).toThrow(/different file or a different sample/);
  });
});
