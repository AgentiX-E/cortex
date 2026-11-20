/**
 * The interval a value held, and the three ways this render could lie.
 *
 * ## What is being asserted, and why each assertion has a way to fail
 *
 * The capability (`docs/PRODUCT-CAPABILITY-LEDGER.md` row 19) is *"orders facts by their own event times"*, and
 * there are exactly three ways a render of that claim can be worse than no render at all:
 *
 * 1. **It prints an interval for a fact the ledger withheld.** `assemble` refuses the older fact on a default
 *    question — its `persistence` is `refuted` — so a timeline built from the *store* would re-publish, as
 *    dates, the one value the exit refused. The test asserts the withheld value's interval is absent while its
 *    text still appears inside the relation line, which is the same asymmetry `semantic-carry.test.ts` pins for
 *    the `fact:` lines.
 * 2. **It moves the day.** The instant is `stampEpoch`'s UTC reading of a record's `[YYYY/MM/DD …]` digits, and
 *    formatting it back in local time shifts every record stamped before 08:00 in a UTC+8 process to the
 *    previous day. The test reads the date off the rendered line and compares it to the record's own digits.
 * 3. **It changes a prompt when the switch is absent.** `factTimeline` is a second switch beside `semanticCarry`
 *    for the reason `types.ts` states, and the assertion is byte equality against the same instance with only
 *    this option differing — a string that "contains the same things" is not the claim.
 *
 * ## Why the producer is the fixture
 *
 * `timelineOf` reads a `SemanticUpdate`, so the test builds one through `semanticUpdateFrom` rather than by
 * hand: a hand-built unit would exercise the arithmetic and skip the one thing that can be wrong, which is
 * whether the producer puts usable instants on the two facts. The guard cases then mutate that same object,
 * so each refusal is a statement about a state the object can actually reach.
 */

import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { semanticUpdateFrom, type SemanticUpdate } from '../semantic-facts.js';
import { renderTimeline, timelineOf } from '../timeline.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const EARLY = '[2023/01/15 (Sun) 09:10] user: I am at 20 dozen at the moment.';
const LATE = '[2023/03/12 (Sun) 11:40] user: I am at 30 dozen at the moment.';
const EVIDENCE = `1. ${EARLY}\n2. ${LATE}`;

/** The two instants the receipts carry, as `stampEpoch` builds them: the record's digits, read as UTC. */
const EARLY_AT = Date.UTC(2023, 0, 15, 9, 10);
const LATE_AT = Date.UTC(2023, 2, 12, 11, 40);

const UPDATING = 'How many dozen of stock am I at?';
const REVISIT = 'What is my current stock position?';

const SUPERSEDE_ANSWER =
  'CHANGED: yes\nLATER: 30 dozen at the moment\nWHEN: 2023/03/12 (Sun) 11:40';

/** One authorised substitution, through the function that produces them. */
function authorised(): SemanticUpdate {
  const update = semanticUpdateFrom({
    evidence: EVIDENCE,
    frameId: 'timeline-fixture',
    question: UPDATING,
    first: '20 dozen',
    verdict: {
      kind: 'replace',
      value: '30 dozen',
      record: 1,
      authorised: {
        later: { text: LATE, date: '2023/03/12 (Sun) 11:40', at: LATE_AT },
        earlier: { text: EARLY, date: '2023/01/15 (Sun) 09:10', at: EARLY_AT },
      },
    },
  });
  // The fixture is load-bearing: every assertion below reads a unit this line did not produce as a bug in
  // the test rather than in the module.
  if (update === null) throw new Error('the fixture must be an authorisable substitution');
  return update;
}

describe('timelineOf', () => {
  it('returns the older interval closed at the newer record and the newer one open', () => {
    const spans = timelineOf(authorised());
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({
      factId: 'timeline-fixture:before',
      value: '20 dozen',
      from: EARLY_AT,
      until: LATE_AT,
    });
    expect(spans[1]).toEqual({
      factId: 'timeline-fixture:after',
      value: '30 dozen',
      from: LATE_AT,
      until: Number.POSITIVE_INFINITY,
    });
  });

  it('refuses a unit whose facts are not both in its own list', () => {
    const update = authorised();
    const missing = {
      ...update,
      factIds: ['timeline-fixture:after', 'elsewhere'],
    } as SemanticUpdate;
    expect(timelineOf(missing)).toEqual([]);
  });

  it('refuses a unit with fewer than two fact ids, which no producer writes', () => {
    // Reachable only by a caller that constructs the object itself. Kept because the alternative is an
    // `undefined` id flowing into a map lookup, and a module a caller can import on its own has to state its
    // own boundary rather than rely on its producer's.
    const update = { ...authorised(), factIds: ['timeline-fixture:after'] } as SemanticUpdate;
    expect(timelineOf(update)).toEqual([]);
  });

  it('refuses a fact whose sentence stated no instant', () => {
    const update = authorised();
    const undated = {
      ...update,
      unit: {
        ...update.unit,
        facts: update.unit.facts.map((fact) =>
          fact.id === 'timeline-fixture:before' ? { ...fact, at: undefined } : fact,
        ),
      },
    } as SemanticUpdate;
    expect(timelineOf(undated)).toEqual([]);
  });

  it('refuses two facts on one instant instead of rendering a zero-length interval', () => {
    // A span `from X until X` is a claim that a value was true for no time at all, and it would render as a
    // perfectly ordinary line. `deriveSupersedes` refuses this pair, so the state is unreachable through the
    // producer — asserted here because a module that can be imported alone must not depend on that.
    const update = authorised();
    const collapsed = {
      ...update,
      unit: {
        ...update.unit,
        facts: update.unit.facts.map((fact) => ({ ...fact, at: LATE_AT })),
      },
    } as SemanticUpdate;
    expect(timelineOf(collapsed)).toEqual([]);
  });
});

describe('renderTimeline', () => {
  it('writes the record date, the end of the interval and the value on one line each', () => {
    const spans = timelineOf(authorised());
    expect(renderTimeline(spans, ['timeline-fixture:before', 'timeline-fixture:after'])).toEqual([
      'timeline: 20 dozen [2023/01/15 -> 2023/03/12]',
      'timeline: 30 dozen [2023/03/12 -> now]',
    ]);
  });

  it('renders nothing for a fact the exit withheld', () => {
    // The default question: the ledger served the newer fact and refuted the older one. Printing the older
    // interval would publish the value and a date range, which is strictly more than the entry it refused.
    const spans = timelineOf(authorised());
    expect(renderTimeline(spans, ['timeline-fixture:after'])).toEqual([
      'timeline: 30 dozen [2023/03/12 -> now]',
    ]);
    expect(renderTimeline(spans, [])).toEqual([]);
  });

  it('keeps a value that was stated across lines on one line', () => {
    // A reader's own answer can carry a newline. A second line without the `timeline:` prefix is a row a reader
    // cannot tell from evidence, and the truncation this render is designed for cuts by line.
    const spans = [{ factId: 'id', value: '  30\n  dozen  ', from: LATE_AT, until: Infinity }];
    expect(renderTimeline(spans, ['id'])).toEqual(['timeline: 30 dozen [2023/03/12 -> now]']);
  });
});

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: (_memory: MemoryValue) => 1,
} as const;

function reader(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      if (prompt.includes('Do not answer the question again')) return SUPERSEDE_ANSWER;
      if (prompt.includes(UPDATING)) return '20 dozen';
      return '30 dozen';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function system(llm: LLM, options: Partial<CortexMemoryOptions> = {}): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: OPEN_GATE,
    reviewPass: 'supersede',
    ...options,
    llm,
  });
}

/** Answer the question that authorises the substitution, then the one whose prompt would carry it. */
async function promptAfterAuthorisation(
  options: Partial<CortexMemoryOptions>,
): Promise<{ memory: CortexMemory; prompt: string; calls: number }> {
  const seen: string[] = [];
  const memory = system(reader(seen), options);
  expect(await memory.answerKnowledgeUpdate(UPDATING, [EARLY, LATE])).toBe('30 dozen');
  await memory.answer(REVISIT, [EARLY, LATE]);
  const prompt = memory.lastPromptText();
  if (prompt === null) throw new Error('the product must have rendered a prompt');
  return { memory, prompt, calls: seen.length };
}

describe('the product path', () => {
  it('carries the interval of the served fact, and only of the served fact', async () => {
    const { prompt, memory } = await promptAfterAuthorisation({
      semanticCarry: true,
      factTimeline: true,
    });
    // The premise, asserted rather than assumed: this is the case where the ledger refused one of the two
    // facts. Without this line, "the older interval is absent" would be equally true of an empty store.
    expect(memory.semanticCarryCensus().withheld).toBe(1);
    expect(prompt).toContain('timeline: 30 dozen [2023/03/12 -> now]');
    // The date on the line is the record's own digits, not a local-time rendering of the same instant.
    expect(prompt).toContain('2023/03/12');
    expect(prompt).not.toContain('timeline: 20 dozen');
    // The withheld value is still named by the relation line, so the reader loses nothing by the filter.
    expect(prompt).toContain('"20 dozen"');
    // After the facts it dates, and before the question: an interval above the facts would be a reading
    // offered before the evidence.
    expect(prompt.indexOf('fact:     30 dozen')).toBeLessThan(prompt.indexOf('timeline: 30 dozen'));
    expect(prompt.indexOf('timeline: 30 dozen')).toBeLessThan(
      prompt.indexOf(`QUESTION: ${REVISIT}`),
    );
  });

  it('changes nothing when the option is absent — byte for byte', async () => {
    const off = await promptAfterAuthorisation({ semanticCarry: true });
    const on = await promptAfterAuthorisation({ semanticCarry: true, factTimeline: true });
    expect(off.prompt).not.toContain('timeline:');
    expect(on.prompt).not.toBe(off.prompt);
    expect(on.prompt.replace(/^timeline: .*$\n?/gm, '')).toBe(off.prompt);
  });

  it('renders nothing without `semanticCarry`, because an interval describes a fact the prompt lacks', async () => {
    const alone = await promptAfterAuthorisation({ factTimeline: true });
    const control = await promptAfterAuthorisation({});
    expect(alone.prompt).not.toContain('timeline:');
    expect(alone.prompt).toBe(control.prompt);
  });

  it('spends no model call: the same three calls with the switch on and off', async () => {
    const on = await promptAfterAuthorisation({ semanticCarry: true, factTimeline: true });
    const off = await promptAfterAuthorisation({ semanticCarry: true });
    expect(on.calls).toBe(3);
    expect(off.calls).toBe(3);
  });
});
