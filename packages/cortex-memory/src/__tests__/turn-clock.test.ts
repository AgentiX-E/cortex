/**
 * The session boundary's clock: does a block of two hundred turns say anywhere when it happened?
 *
 * ## The reading that motivated it
 *
 * `44017278305` (`S16`) answers 101.25 of 121 multi-session questions per run, and 16 of the 121 are
 * wrong in all four repetitions. Reading those sixteen, one signature recurs: the reader names the right
 * candidates and then stamps them all with **one** date. `gpt4_2f8be40d` counts five weddings, every one
 * printed `2023/10/15` (the question's date); `d851d5ba` sums eight donations, every one `2023/03/20`;
 * `gpt4_372c3eed` dates two events from two sessions `2021/08/20`. The association is measured, not
 * anecdotal: a reply that prints three or more dates, of which three or more are identical, occurs in **17
 * of the 57** questions that are ever wrong (29.8%) and in **39 of the 443** that never are (8.8%) -- 3.39
 * times the rate.
 *
 * The dates are all still in the prompt — verified, not assumed: 0 of that artifact's 41,822 delivered
 * turns lack a `[YYYY/MM/DD …]` stamp. What is missing is salience at the boundary, which is a rendering
 * fact and therefore fixed in a rendering function.
 *
 * ## What these tests are for
 *
 * The pure tests pin the two decisions a label can get wrong: only a *leading* stamp is a date, and a
 * boundary is a whole line rather than the word "Session". The property test pins the decision the first
 * implementation got wrong: the label must describe what was **rendered**, and on a clipped prompt the
 * rendered set is smaller than the selected one. The last test walks the public entry, because a
 * mechanism that exists in a module and cannot be reached from `assembleMemory` is the defect
 * requirement ⑯ names.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

import { assembleMemory } from '../assemble.js';
import type { AdmittedTurn } from '../admission.js';
import { buildSessionPrompt } from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import { annotateSessionBoundaries } from '../turn-clock.js';

const NOW = 1_759_470_000_000;

/** An admitted turn as admission stamps one: the date lives in the content, not in `createdAt`. */
function turn(id: string, content: string, ordinal = 0): AdmittedTurn {
  return {
    id,
    content,
    value: 0.5,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: NOW,
    lastAccessedAt: NOW,
    stability: 1,
    difficulty: 5,
    reads: 0,
    ordinal,
  };
}

function sessionOf(index: number, turns: AdmittedTurn[]): AdmittedSession {
  return { index, size: turns.length, turns };
}

/** The stamps a block of text contains, as `YYYY-MM-DD`, in the form the label uses. */
function stampsIn(text: string): string[] {
  return [...text.matchAll(/\[(\d{4})\/(\d{2})\/(\d{2})/g)].map(
    (match) => `${match[1]}-${match[2]}-${match[3]}`,
  );
}

describe('what counts as a date: a bracketed stamp, and only if it names a day', () => {
  /** The label a one-block prompt gets, which is the only observable this module has. */
  const labelOf = (block: string): string => {
    const annotated = annotateSessionBoundaries(`Session 1\n${block}`);
    const match = /^Session 1 \((.+)\)$/m.exec(annotated);
    return match === null ? '' : match[1]!;
  };

  it('reads the dataset stamp, with or without a trailing clock, in either separator', () => {
    expect(labelOf('1. [2023/05/21 (Sun) 18:48] user: I moved.')).toBe('2023-05-21');
    expect(labelOf('1. [2023/05/21] user: I moved.')).toBe('2023-05-21');
    expect(labelOf('1. [2023-5-9 07:00] user: I moved.')).toBe('2023-05-09');
  });

  it('ignores a date the prose states, because that is an event and not a record', () => {
    // "I moved on 2023/05/21" says something happened then; it does not say the turn was recorded then, and
    // a boundary labelled with it would be a claim the evidence does not make.
    expect(labelOf('1. user: I moved on 2023/05/21 and it rained.')).toBe('');
  });

  it('never prints a day that does not exist', () => {
    // `[2023/02/30]` in a transcript is a typo. A boundary that repeated it would put a date that is not a
    // date into the one line the reader is meant to trust about time.
    expect(labelOf('1. [2023/02/30] user: a typo.')).toBe('');
    expect(labelOf('1. [2023/13/01] user: a typo.')).toBe('');
    expect(labelOf('1. [2024/02/29] user: a leap year.')).toBe('2024-02-29');
    expect(labelOf('1. [2023/02/29] user: not a leap year.')).toBe('');
  });
});

describe('annotateSessionBoundaries — the boundary the reader actually got', () => {
  const body =
    'EVIDENCE:\nSession 1\n1. [2023/05/21] user: a\n\n2. [2023/05/21] user: b\n\nSession 2\n1. [2023/06/02] user: c';

  it('dates each boundary with the range its own block states', () => {
    expect(annotateSessionBoundaries(body)).toContain('Session 1 (2023-05-21)');
    expect(annotateSessionBoundaries(body)).toContain('Session 2 (2023-06-02)');
  });

  it('is a no-op on a prompt with no boundary, returning the same string', () => {
    const flat = 'EVIDENCE:\n1. [2023/05/21] user: a\n\nQUESTION: how many?';
    expect(annotateSessionBoundaries(flat)).toBe(flat);
  });

  it('leaves an undated block unlabelled rather than inventing a date', () => {
    const undated = 'Session 1\n1. no stamp here';
    expect(annotateSessionBoundaries(undated)).toBe(undated);
  });

  it('does not mistake the word "Session" inside a turn for a boundary', () => {
    // A turn that begins its own line with "Session 7" is content. Annotating it would put a date on a
    // line the renderer did not draw, and the reader would read it as a conversation boundary.
    const inside = 'Session 1\n1. [2023/05/21] user: notes\nSession 7\nmore prose';
    const annotated = annotateSessionBoundaries(inside);
    expect(annotated).toContain('Session 1 (2023-05-21)');
    expect(annotated).toContain('\nSession 7\n');
  });

  it('writes a range when the block spans two days', () => {
    const spread = 'Session 1\n1. [2023/05/27] user: a\n\n2. [2023/05/21] user: b';
    expect(annotateSessionBoundaries(spread)).toBe(
      'Session 1 (2023-05-21..2023-05-27)\n1. [2023/05/27] user: a\n\n2. [2023/05/21] user: b',
    );
  });

  it('is idempotent, so a second pass cannot print the label twice', () => {
    const once = annotateSessionBoundaries(body);
    expect(annotateSessionBoundaries(once)).toBe(once);
  });

  it('labels the rendered block, not the selected one, on a prompt the budget clipped', () => {
    // The property the first implementation violated. Four turns are admitted, the room holds two and a
    // half, and the clip lands inside the third: a label computed from the selection reads
    // `2023-05-21..2023-12-31` while the reader is shown nothing dated December. Asserted as a property
    // rather than as a fixture string, so it holds whatever the budget decides.
    const sessions = [
      sessionOf(0, [
        turn('a', '[2023/05/21] user: I bought a bike.', 0),
        turn('b', `[2023/05/22] user: ${'padding words '.repeat(20)}`, 1),
        turn('c', `[2023/12/31] user: ${'padding words '.repeat(20)}`, 2),
        turn('d', `[2023/12/31] user: ${'padding words '.repeat(20)}`, 3),
      ]),
    ];
    const assembled = buildSessionPrompt('How many bikes do I own?', sessions, {
      maxChars: 700,
      maxEvidenceChars: 700,
    });
    const annotated = annotateSessionBoundaries(assembled.prompt);
    const shown = stampsIn(annotated);
    expect(shown.length).toBeGreaterThan(0);
    const first = shown.reduce((low, date) => (date < low ? date : low));
    const last = shown.reduce((high, date) => (date > high ? date : high));
    expect(annotated).toContain(`Session 1 (${first === last ? first : `${first}..${last}`})`);
    expect(annotated).not.toContain('2023-12-31');
  });
});

describe('the mechanism is reachable from the public entry', () => {
  function recordingLlm(seen: string[]): LLM {
    return {
      async complete(prompt: string) {
        seen.push(prompt);
        return '2';
      },
    } as unknown as LLM;
  }

  const SESSIONS = [
    ['[2023/05/21] user: I bought a bike.'],
    ['[2023/06/02] user: I bought another bike.'],
  ];

  it('labels the boundaries when the option is set, and not otherwise', async () => {
    const plain: string[] = [];
    const plainInstall = assembleMemory({
      llm: recordingLlm(plain),
      now: NOW,
      storage: new SqliteStorage(),
    });
    await plainInstall.memory.answerSessions('How many bikes do I own?', SESSIONS);
    expect(plain[0]).not.toContain('(2023-05-21)');

    const labelled: string[] = [];
    const labelledInstall = assembleMemory({
      llm: recordingLlm(labelled),
      now: NOW,
      storage: new SqliteStorage(),
      sessionClock: true,
    });
    await labelledInstall.memory.answerSessions('How many bikes do I own?', SESSIONS);
    expect(labelled[0]).toContain('Session 1 (2023-05-21)');
    expect(labelled[0]).toContain('Session 2 (2023-06-02)');
  });
});
