/**
 * The prompt budget must be spent on the turns that matter, not on the turns
 * that happen to arrive first.
 *
 * ## The defect these tests close
 *
 * Measured on run `38114272884`: `fitToBudget` spends the evidence room on
 * `truncateCodePointSafe(evidenceText, room)`, which takes a **prefix**. Nothing
 * chooses which turns deserve the room, so the model reads the first turns in
 * arrival order — and arrival order on this arm is the dataset's own haystack
 * order, because `CortexMemory` performs no retrieval (`memory.ts` has no
 * `retrieveTopK`, no `embedding`, no `sort(`). The gold turn falls inside the
 * carried prefix for **15 of 121** questions, 12.4%, while the median gold session
 * sits at 22% of the haystack and the prefix reaches 4.6% of it.
 *
 * So the budget was not merely small. It was spent on the wrong turns, and no
 * prompt wording can recover a question whose evidence never reached the prompt.
 *
 * ## The two decisions, which are separate on purpose
 *
 * - **Selection** — which turns fill the room. Driven by the injected signal,
 *   scored by relevance, largest fitting prefix of the relevance order.
 * - **Presentation** — the order they are printed in. Always arrival order, which
 *   is chronological. `selectSessionBudget` already draws this line for sessions
 *   and states why: a prompt that lists a later session before an earlier one
 *   makes relative-time and knowledge-update questions unanswerable. Selecting by
 *   relevance and *presenting* by relevance would trade one defect for another, so
 *   the tests below pin both halves.
 *
 * ## How these assertions avoid agreeing with the code under test
 *
 * Nothing here asks the builder what it did and then checks that it said so. The
 * expected evidence is constructed independently — from `formatEvidence`, which is
 * the renderer the prompt uses and not the selection — and the room is set from the
 * measured full-prompt length, so the search behaviour is characterised rather than
 * re-implemented:
 *
 *   - without a signal, the carried text is a character **prefix** of the evidence
 *     and grows one character per character of room, which is what a clip does;
 *   - with a signal, the carried text is a union of **whole turns**, and the set is
 *     the largest prefix of the relevance order that fits;
 *   - a swept budget never yields a prompt over budget and never shrinks the
 *     carried set, which is the property a priority order has and two heuristics do
 *     not.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { buildPrompt, buildSessionPrompt, formatEvidence } from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import type { AdmittedTurn } from '../admission.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;
const MARKER = 'EVIDENCE:\n';
const QUESTION = 'Q?';

function turn(content: string, ordinal = 0): AdmittedTurn {
  return { id: `t${ordinal}`, content, ordinal } as unknown as AdmittedTurn;
}

function session(index: number, contents: string[]): AdmittedSession {
  return {
    index,
    turns: contents.map((content, i) => turn(content, i)),
    size: contents.length,
  } as unknown as AdmittedSession;
}

/** The evidence section of an assembled prompt, without its header. */
function carried(prompt: string): string {
  const at = prompt.indexOf(MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const body = prompt.slice(at + MARKER.length);
  const end = body.indexOf('\n\nQUESTION: ');
  return end === -1 ? body : body.slice(0, end);
}

/**
 * The carried evidence, or `''` when the prompt has no evidence section at all.
 *
 * The budget sweep runs below the point where an evidence header fits, and there
 * "no section" and "empty section" are the same state rather than a failure. Every
 * other test uses the strict reader above, so an unexpectedly missing header is
 * still caught where it means something.
 */
function carriedOrNothing(prompt: string): string {
  return prompt.includes(MARKER) ? carried(prompt) : '';
}

/**
 * A budget that leaves exactly `room` characters for the evidence section.
 *
 * Derived from the measured full prompt rather than from the allocator's
 * arithmetic: the two paths differ only in their evidence text, so shifting the
 * budget by the difference in evidence length shifts the room by the same amount.
 * A test that restated `maxChars - instruction - separators - header` would be
 * checking the implementation's own formula back against itself.
 */
function budgetForRoom(turns: readonly AdmittedTurn[], room: number): number {
  const full = buildPrompt(QUESTION, turns, 'extractive').prompt;
  const evidence = formatEvidence(turns);
  return full.length - (evidence.length - room);
}

/** Contents of `count` turns, each long enough that turn boundaries are visible. */
function turnsOf(count: number, width = 40): AdmittedTurn[] {
  return Array.from({ length: count }, (_, i) => turn(`turn ${i}`.padEnd(width, '.'), i));
}

/**
 * The largest prefix of `order` whose chronological rendering fits `room`.
 *
 * A brute-force restatement of the *specification*, not of the implementation:
 * the implementation binary-searches and this scans, so a search that converged
 * to the wrong k would disagree with it.
 */
function largestFittingPrefix(
  order: readonly AdmittedTurn[],
  room: number,
): readonly AdmittedTurn[] {
  let best: readonly AdmittedTurn[] = [];
  for (let k = 0; k <= order.length; k += 1) {
    const candidate = order.slice(0, k);
    const chronological = candidate
      .map((entry, arrival) => ({ entry, arrival }))
      .sort((a, b) => a.arrival - b.arrival)
      .map(({ entry }) => entry);
    if (formatEvidence(chronological).length <= room) best = candidate;
  }
  return best;
}

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
  return {
    llm,
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...overrides,
  };
}

describe('the budget without a relevance signal', () => {
  it('clips the evidence character by character, as it always has', () => {
    // The characterisation of a clip: one more character of room buys exactly one
    // more character of evidence. Cell-by-cell growth is the signature, and it is
    // what distinguishes the unsignalled path from the selecting one below. The
    // comparison is against the renderer's own output, so the numbering prefix is
    // accounted for by the renderer rather than by this test.
    const turns = [turn('x'.repeat(500), 0)];
    const rendered = formatEvidence(turns);
    const at = (room: number) =>
      carried(
        buildPrompt(QUESTION, turns, 'extractive', { maxChars: budgetForRoom(turns, room) }).prompt,
      );

    expect(at(300)).toBe(rendered.slice(0, 300));
    expect(at(301)).toBe(rendered.slice(0, 301));
    expect(at(301).length - at(300).length).toBe(1);
  });

  it('reports the clipped length as carried evidence', () => {
    const turns = [turn('x'.repeat(500), 0)];
    const assembled = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, 300),
    });

    expect(assembled.evidenceChars).toBe(300);
  });
});

describe('the budget with a relevance signal', () => {
  it('carries whole turns rather than a character clip', () => {
    // Every carried turn appears verbatim, and the text is exactly the renderer's
    // output for the selected set. A clip would end mid-turn, which is the shape
    // the two assertions exclude between them.
    const turns = turnsOf(4);
    const room = formatEvidence([turns[0]!, turns[1]!]).length;
    const prompt = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, room),
      relevanceFor: () => 0,
    }).prompt;

    expect(carried(prompt)).toBe(formatEvidence([turns[0]!, turns[1]!]));
    for (const t of [turns[0]!, turns[1]!]) expect(carried(prompt)).toContain(t.content);
  });

  it('carries a late turn the signal ranks first, which no prefix would reach', () => {
    // The defect in one assertion. With 200 turns and room for five, the
    // chronological prefix holds turns 0-4; the gold turn at 150 is outside it.
    // Ranking it first has to bring it inside.
    const turns = turnsOf(200);
    const gold = turns[150]!;
    const room = formatEvidence(turns.slice(0, 5)).length;
    const budget = budgetForRoom(turns, room);

    const without = carried(
      buildPrompt(QUESTION, turns, 'extractive', { maxChars: budget }).prompt,
    );
    const with_ = carried(
      buildPrompt(QUESTION, turns, 'extractive', {
        maxChars: budget,
        relevanceFor: (_question, candidate) => (candidate === gold.content ? 1 : 0),
      }).prompt,
    );

    expect(without).not.toContain(gold.content);
    expect(with_).toContain(gold.content);
  });

  it('presents the selected turns in arrival order, not relevance order', () => {
    // Four turns, room for three, relevance ranking d highest then a, b, c. The
    // selected set is therefore {b, c, d} -- no: the top three are d, a and b, and
    // they must be printed a, b, d, with a and b before d despite d outranking
    // both. Printing them in relevance order would reorder the log, which is the
    // property `selectSessionBudget` refuses to break for sessions.
    const turns = turnsOf(4, 10);
    const [a, b, , d] = turns as [AdmittedTurn, AdmittedTurn, AdmittedTurn, AdmittedTurn];
    const rank = new Map([
      [d.content, 3],
      [a.content, 2],
      [b.content, 1],
    ]);
    const room = formatEvidence([a, b, d]).length;

    const prompt = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, room),
      relevanceFor: (_question, candidate) => rank.get(candidate) ?? 0,
    }).prompt;

    expect(carried(prompt)).toBe(formatEvidence([a, b, d]));
    expect(carried(prompt)).not.toContain(turns[2]!.content);
  });

  it('selects the largest prefix of the relevance order that fits', () => {
    // The specification, checked by brute force over every prefix. This is what
    // makes "largest" mean something: a search that stopped early, or that
    // maximised the number of characters rather than the number of turns, would
    // land on a different set for at least one room in the sweep.
    const turns = turnsOf(12, 30);
    const order = [...turns].reverse();
    const rank = new Map(order.map((t, i) => [t.content, order.length - i]));

    for (let room = 40; room <= formatEvidence(turns).length; room += 37) {
      const expected = largestFittingPrefix(order, room);
      const prompt = buildPrompt(QUESTION, turns, 'extractive', {
        maxChars: budgetForRoom(turns, room),
        relevanceFor: (_question, candidate) => rank.get(candidate) ?? 0,
      }).prompt;

      expect(prompt.length).toBeLessThanOrEqual(budgetForRoom(turns, room));
      if (expected.length === 0) continue;
      const chronological = [...expected]
        .map((entry) => ({ entry, arrival: turns.indexOf(entry) }))
        .sort((x, y) => x.arrival - y.arrival)
        .map(({ entry }) => entry);
      expect(carried(prompt)).toBe(formatEvidence(chronological));
    }
  });

  it('never exceeds the budget and never shrinks as the budget grows', () => {
    // The two properties a priority order has and two heuristics do not. The first
    // is the existing budget invariant, re-asserted on the selecting path; the
    // second is monotone growth of the carried set, which a selection that
    // reordered with the budget could violate.
    const turns = turnsOf(30, 25);
    const rank = new Map(turns.map((t, i) => [t.content, (i * 7) % 30]));
    const relevanceFor = (_question: string, candidate: string) => rank.get(candidate) ?? 0;
    const full = buildPrompt(QUESTION, turns, 'extractive').prompt.length;

    let previous = 0;
    for (let budget = 1; budget <= full + 5; budget += 1) {
      const prompt = buildPrompt(QUESTION, turns, 'extractive', {
        maxChars: budget,
        relevanceFor,
      }).prompt;
      expect(prompt.length).toBeLessThanOrEqual(budget);

      const evidence = carriedOrNothing(prompt);
      const count = evidence === '' ? 0 : evidence.split('\n\n').length;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });

  it('keeps the abstention token when no turn fits the room at all', () => {
    // The degenerate room. The instruction block outranks the evidence, so the
    // model can still decline -- and it is the state a single turn larger than the
    // whole room produces, which is why the assertion is here rather than only in
    // the tiny-budget sweep.
    const turns = [turn('x'.repeat(900), 0)];
    const prompt = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, 100),
      relevanceFor: () => 1,
    }).prompt;

    expect(prompt).toContain('INSUFFICIENT_EVIDENCE');
    expect(prompt).not.toContain('x'.repeat(900));
  });
});

describe('the relevance signal as an input', () => {
  it('is not consulted when the evidence already fits', () => {
    // Deliberate, and it is the cost boundary rather than an optimisation: on this
    // arm the signal is a retrieval over the question's whole haystack, so a run
    // whose prompts all fit should not pay for one. The counter makes the claim
    // checkable rather than inferred from a timing.
    const turns = turnsOf(3, 10);
    let calls = 0;
    buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: 100_000,
      relevanceFor: () => {
        calls += 1;
        return 0;
      },
    });

    expect(calls).toBe(0);
  });

  it('rejects a non-finite relevance, naming the turn it came from', () => {
    // `NaN` compares false against everything, so a sort on it would fall back to
    // an implementation-defined order and the artifact would describe the sort
    // rather than the system. The turn is named because the callback is evaluated
    // per turn and "somewhere in this context" is not a location.
    const turns = [turn('aaa', 0), turn('bbb', 1)];
    const at = (value: number) =>
      buildPrompt(QUESTION, turns, 'extractive', {
        maxChars: budgetForRoom(turns, 10),
        relevanceFor: (_question, candidate) => (candidate === 'bbb' ? value : 0),
      });

    expect(() => at(Number.NaN)).toThrow(/bbb/);
    expect(() => at(Number.POSITIVE_INFINITY)).toThrow(/relevanceFor/);
  });

  it('accepts a negative relevance, because a score is not a probability', () => {
    // Unlike `confidenceFor`, which is a factor of a bounded product and is
    // validated into `[0, 1]`, this orders turns and any real orders them. A future
    // signal that is a log-likelihood, a centred cosine or a reciprocal-rank
    // penalty must not have to be rescaled to be accepted.
    const turns = turnsOf(4, 10);
    const [, b, , d] = turns as [AdmittedTurn, AdmittedTurn, AdmittedTurn, AdmittedTurn];
    const rank = new Map([
      [d.content, -1],
      [b.content, -5],
    ]);
    const room = formatEvidence([b, d]).length;

    const prompt = buildPrompt(QUESTION, turns, 'extractive', {
      maxChars: budgetForRoom(turns, room),
      relevanceFor: (_question, candidate) => rank.get(candidate) ?? -100,
    }).prompt;

    expect(carried(prompt)).toContain(d.content);
  });
});

describe('the same signal on the multi-session route', () => {
  it('selects across sessions and keeps every boundary it draws', () => {
    // Sessions 1 and 3 contribute; session 2 loses every turn, so it is dropped
    // rather than rendered empty. Real evidence for a dropped session would be a
    // boundary with nothing behind it.
    const sessions = [
      session(0, ['s0a', 's0b']),
      session(1, ['s1a', 's1b']),
      session(2, ['s2a', 's2b']),
    ];
    const flat = sessions.flatMap((s) => s.turns);
    const wanted = [flat[0]!, flat[5]!];
    const room = [0, 2]
      .map((index) =>
        formatEvidence(
          sessions[index]!.turns.filter((t) => wanted.includes(t)),
          {
            sessionIndex: index,
          },
        ),
      )
      .join('\n\n').length;

    const prompt = buildSessionPrompt(QUESTION, sessions, {
      maxChars: budgetForRoom(flat, room),
      relevanceFor: (_question, candidate) => (wanted.some((t) => t.content === candidate) ? 1 : 0),
    }).prompt;

    expect(carried(prompt)).toContain('Session 1');
    expect(carried(prompt)).toContain('Session 3');
    expect(carried(prompt)).not.toContain('Session 2');
    expect(carried(prompt)).not.toContain('s1a');
  });
});

describe('the relevance signal reaches the prompt and nothing else', () => {
  it('carries the promoted turn into the prompt the model is asked', async () => {
    // End to end through `CortexMemory`, because the option has to survive
    // `#promptOptions` and both builders -- and an option that never reaches the
    // builder is the failure mode §10.10 records for `retrievalThreshold`.
    const llm = new NoopLlm();
    const context = turnsOf(60, 30).map((t) => t.content);
    const gold = context[55]!;
    const memory = new CortexMemory(
      options(llm, {
        maxPromptChars: budgetForRoom(
          context.map((content, i) => turn(content, i)),
          formatEvidence(context.slice(0, 4).map((content, i) => turn(content, i))).length,
        ),
        relevanceFor: (_question, candidate) => (candidate === gold ? 1 : 0),
      }),
    );

    await memory.answer('Q?', context);

    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain(gold);
  });

  it('leaves the admission and abstention decisions exactly where they were', async () => {
    // The signal changes which turns are printed, not which are admitted and not
    // whether the layer answers at all. A signal that moved any of those would make
    // the next run's delta uninterpretable: two variables would have moved.
    const context = turnsOf(40, 30).map((t) => t.content);
    const room = formatEvidence(context.slice(0, 3).map((content, i) => turn(content, i))).length;
    const budget = budgetForRoom(
      context.map((content, i) => turn(content, i)),
      room,
    );

    const without = new CortexMemory(options(new NoopLlm(), { maxPromptChars: budget }));
    const with_ = new CortexMemory(
      options(new NoopLlm(), { maxPromptChars: budget, relevanceFor: () => 1 }),
    );
    await without.answerAbstention('Q?', context);
    await with_.answerAbstention('Q?', context);

    expect(with_.abstentionReasons()).toEqual(without.abstentionReasons());
  });
});
