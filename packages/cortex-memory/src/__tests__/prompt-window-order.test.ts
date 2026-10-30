/**
 * The time-window reorder, at the builder.
 *
 * `temp_query_search_pruning.py` (§13.151.1) infers a date range and moves the items inside it to the
 * front of the list retrieval already produced. What makes that registrable as an increment of its own is
 * that the move is a **permutation** -- the delivered multiset is invariant, so a reading can attribute
 * movement to order and to nothing else (§13.151.5, §13.152.4 criterion 2).
 *
 * That claim is a property of `partitionLead` and of the three call sites `buildPrompt` has, so it is
 * asserted here rather than left to the run. Three of the tests below are about the **set**: the fits
 * path, the relevance-selected path and the character-clip path must all deliver exactly what the same
 * configuration delivers without an ordering. Two are about the **order**: the promoted block comes first,
 * both blocks keep their own sequence, and the promoted block is numbered from one because the renderer
 * numbers by position.
 *
 * One is about the case the mechanism's own docstring calls the honest null: a window that admits no
 * delivered turn leaves the prompt **byte-identical**, which is what makes "fired and moved nothing"
 * distinguishable from "was administered".
 */
import { describe, expect, it } from 'vitest';

import type { AdmittedTurn } from '../admission.js';
import { buildPrompt, type EvidenceOrdering } from '../prompt.js';

let nextOrdinal = 0;

/** One admitted turn whose content carries a `[YYYY/MM/DD]` stamp, as the arm's turns do. */
function stamped(date: string, body: string): AdmittedTurn {
  return {
    id: `${date}-${body}`,
    content: `[${date} (Wed) 09:00] user: ${body}`,
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
    ordinal: nextOrdinal++,
  };
}

/** A predicate over a stamp, which is what the arm builds from its window. */
function admits(start: string, end: string): EvidenceOrdering {
  return {
    leadWhen: (turn) => {
      const match = /^\[(\d{4}\/\d{2}\/\d{2})/.exec(turn.content);
      if (match === null) return false;
      const date = match[1] as string;
      return date >= start && date <= end;
    },
  };
}

/** The evidence block of a prompt, which is what the reader actually sees. */
function evidenceOf(prompt: string): string {
  return prompt.slice(
    prompt.indexOf('EVIDENCE:\n') + 'EVIDENCE:\n'.length,
    prompt.indexOf('\n\nQUESTION:'),
  );
}

describe('the ordering is a permutation of the delivered set', () => {
  it('leaves the prompt byte-identical when the window admits nothing', () => {
    // The honest null. `partitionLead` returns its argument unchanged, so this is not "a reordering that
    // happens to look the same" -- the two prompts are the same string, and the delivered list is the same
    // array identity is not asserted because a caller should not depend on it.
    const turns = [stamped('2023/02/01', 'alpha'), stamped('2023/02/02', 'beta')];
    const control = buildPrompt('What did I do?', turns, 'extractive', { maxChars: 8_000 });
    const treated = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 8_000 },
      admits('2024/01/01', '2024/01/02'),
    );

    expect(treated.prompt).toBe(control.prompt);
    expect(treated.carried).toEqual(control.carried);
    expect(treated.evidenceChars).toBe(control.evidenceChars);
  });

  it('leaves the prompt byte-identical when the window admits everything', () => {
    // The other end of the same branch: a window spanning the corpus promotes every delivered turn, and a
    // permutation that moves nothing must not be spelled as a reordering.
    const turns = [stamped('2023/02/01', 'alpha'), stamped('2023/02/02', 'beta')];
    const control = buildPrompt('What did I do?', turns, 'extractive', { maxChars: 8_000 });
    const treated = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 8_000 },
      admits('2000/01/01', '2099/12/31'),
    );

    expect(treated.prompt).toBe(control.prompt);
    expect(treated.carried).toEqual(control.carried);
  });

  it('moves the admitted turns to the front, keeping both blocks in their own order', () => {
    const turns = [
      stamped('2023/02/01', 'one'),
      stamped('2023/02/10', 'two'),
      stamped('2023/02/02', 'three'),
      stamped('2023/02/11', 'four'),
      stamped('2023/02/03', 'five'),
    ];
    const assembled = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 8_000 },
      admits('2023/02/10', '2023/02/11'),
    );

    // The set is the whole window: nothing was budgeted away, so this test is about order alone.
    expect(assembled.carried).toHaveLength(turns.length);
    // Position read on the turn list, so the claim is about turns rather than about substrings.
    expect(assembled.carried.map((turn) => turn.content.split(': ')[1])).toEqual([
      'two',
      'four',
      'one',
      'three',
      'five',
    ]);
  });

  it('numbers the promoted block from one, because the renderer numbers by position', () => {
    const turns = [stamped('2023/02/01', 'one'), stamped('2023/02/10', 'two')];
    const assembled = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 8_000 },
      admits('2023/02/10', '2023/02/10'),
    );

    // The reference pipeline renumbers its list after the move (`ranked_items_new = left + right`), and so
    // does this: a reader that cites "1." must be citing the turn printed first.
    expect(evidenceOf(assembled.prompt)).toMatch(/^1\. \[2023\/02\/10[^\n]*two/);
  });

  it('delivers the same set on the path where the budget selects for relevance', () => {
    // The path §13.27 shipped. `plan.turns` is deliberately unpermuted there, so the selection's tie-breaks
    // cannot read position -- and the proof is that the delivered multiset is equal.
    // Distinct dates, so "the date of a delivered turn" names exactly one turn below.
    const turns = Array.from({ length: 28 }, (_, index) =>
      stamped(`2023/02/${String(index + 1).padStart(2, '0')}`, `turn-${index}-${'x'.repeat(120)}`),
    );
    const relevanceFor = (_question: string, content: string) =>
      content.length - content.charCodeAt(60);
    const control = buildPrompt('What did I do?', turns, 'extractive', {
      maxChars: 3_000,
      relevanceFor,
    });
    // The window admits the date of the third delivered turn and nothing else, so the promotion has a
    // target **inside** the delivered set whatever the ranking chose -- a window that missed it would
    // satisfy "the set is equal" for the trivial reason that nothing was promoted.
    const target = /^\[(\d{4}\/\d{2}\/\d{2})/.exec(control.carried[2]!.content)![1] as string;
    expect(control.carried[0]!.id).not.toBe(control.carried[2]!.id);
    const treated = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 3_000, relevanceFor },
      admits(target, target),
    );
    expect(treated.carried[0]!.content).toContain(target);

    // Preconditions, stated so this test cannot pass by silently taking the fits path.
    expect(control.carried.length).toBeLessThan(turns.length);
    expect(control.carried.length).toBeGreaterThan(4);
    expect(control.prompt.length).toBeLessThanOrEqual(3_000);

    const ids = (picked: readonly AdmittedTurn[]) => picked.map((turn) => turn.id).sort();
    expect(ids(treated.carried)).toEqual(ids(control.carried));
    expect(treated.carried.map((turn) => turn.id)).not.toEqual(
      control.carried.map((turn) => turn.id),
    );
    expect(treated.evidenceChars).toBe(control.evidenceChars);
    expect(treated.prompt.length).toBeLessThanOrEqual(3_000);
  });

  it('delivers the same set on the character-clip path', () => {
    // The one path where re-rendering is not length-preserving: the clip can end inside a turn, so
    // `carried` is the largest prefix of whole turns and the re-render drops the partial tail. The delivered
    // **turns** must therefore still be the control's, and the prompt may only get shorter.
    const turns = Array.from({ length: 20 }, (_, index) =>
      stamped('2023/02/01', `turn-${index}-${'y'.repeat(150)}`),
    );
    const control = buildPrompt('What did I do?', turns, 'extractive', { maxChars: 1_600 });
    const treated = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 1_600 },
      admits('2023/02/01', '2023/02/01'),
    );

    expect(control.carried.length).toBeGreaterThan(1);
    expect(control.carried.length).toBeLessThan(turns.length);
    expect(treated.carried.map((turn) => turn.id).sort()).toEqual(
      control.carried.map((turn) => turn.id).sort(),
    );
    expect(treated.evidenceChars).toBeLessThanOrEqual(control.evidenceChars);
    expect(treated.prompt.length).toBeLessThanOrEqual(1_600);
  });

  it('does not promote a turn whose stamp it cannot read', () => {
    // `leadWhen` answering `false` is "leave it where the retrieval ranked it", which is the only answer
    // that says nothing about an undated turn. The stamped sibling is promoted ahead of it.
    const undated: AdmittedTurn = {
      id: 'undated',
      content: 'user: I did something with no stamp',
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
      ordinal: nextOrdinal++,
    };
    const turns = [undated, stamped('2023/02/10', 'in-window')];
    const assembled = buildPrompt(
      'What did I do?',
      turns,
      'extractive',
      { maxChars: 8_000 },
      admits('2023/02/10', '2023/02/10'),
    );

    expect(assembled.carried.map((turn) => turn.id)).toEqual(['2023/02/10-in-window', 'undated']);
  });

  it('reaches the temporal contract and not the multi-session builder', () => {
    // Stated as a type-level fact rather than a runtime one: `ordering` is the fifth parameter of
    // `buildPrompt`, and `buildSessionPrompt`'s signature has no fifth parameter. A field on
    // `PromptOptions` would have been accepted by both, which is the inert configuration this shape
    // makes unrepresentable.
    const turns = [stamped('2023/02/01', 'one'), stamped('2023/02/10', 'two')];
    const assembled = buildPrompt(
      'How long ago did that happen?',
      turns,
      // The temporal contract, because that is the one `options.questionDate` reaches -- the flat
      // contracts deliberately do not get a date.
      'temporal',
      { maxChars: 8_000, questionDate: '2023/02/15' },
      admits('2023/02/10', '2023/02/12'),
    );

    expect(assembled.carried[0]?.id).toBe('2023/02/10-two');
    // The date reaches the temporal contract's instruction block, which is the route the arm hands it to.
    expect(assembled.prompt).toContain('2023/02/15');
  });
});
