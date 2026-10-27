/**
 * What the reader is actually told about time, per route.
 *
 * ## Why this file exists
 *
 * `docs/PREREG-DATE-FRAME.md` was written to add a date frame to two routes on the premise that
 * "the reader is told nothing". Rendering the two prompts says the premise is false: the temporal
 * contract already carries the anchor the published mechanism adds, and every route already carries
 * per-turn dates. A pre-registration whose mechanism is already installed cannot be tested, and a
 * P0 was about to be dispatched on it.
 *
 * These assertions are the evidence for that withdrawal, kept as tests rather than as a paragraph
 * because the claim is about what the code renders. They are also the record of the one route that
 * genuinely has no anchor — `multi-session` — which is the only place a date frame could still act.
 *
 * The tests assert the **presence** of the sentence, not its full wording. A copy of the wording
 * would fail on every legitimate edit and teach the next reader to relax the assertion; what has to
 * stay true is that the anchor reaches exactly the routes named here.
 */
import { describe, expect, it } from 'vitest';
import { buildPrompt, buildSessionPrompt } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';
import type { AdmittedSession } from '../sessionize.js';

const NOW = 1_700_000_000_000;

/** A dated turn: the dataset puts the date in a prefix inside the content, so it rides along. */
const DATED: AdmittedTurn = {
  id: 't1',
  content: '[2023/05/20] user: I ran ten kilometres today.',
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
  ordinal: 0,
};

/** The one session that holds `turns`, shaped the way `admitSessions` produces them. */
function sessionOf(turns: AdmittedTurn[]): AdmittedSession {
  return { index: 0, size: turns.length, turns };
}

const QUESTION = 'How far did I run last month?';
const ANCHOR = /the question was asked on 2023\/06\/02/i;

describe('the temporal contract already carries the anchor', () => {
  it('renders the question date and the instruction to resolve relative expressions against it', () => {
    const { prompt } = buildPrompt(QUESTION, [DATED], 'temporal', {
      questionDate: '2023/06/02',
      maxChars: 4000,
    });
    expect(prompt).toMatch(ANCHOR);
    // The instruction half matters as much as the date: a date with no instruction is a fact the
    // reader may not think to use.
    expect(prompt).toMatch(/resolve every relative expression/i);
  });

  it('carries the per-turn date prefix the published mechanism calls the block date', () => {
    // The other half of the published mechanism -- "each content block's own date" -- is inside the
    // turn text and survives rendering on every route, so a fix aimed at it would be aimed at
    // something already present.
    const { prompt } = buildPrompt(QUESTION, [DATED], 'temporal', {
      questionDate: '2023/06/02',
      maxChars: 4000,
    });
    expect(prompt).toContain('[2023/05/20]');
  });

  it('omits the anchor when the dataset supplied no question date, rather than inventing one', () => {
    // The state that makes this route's anchor conditional rather than constant. Pinned because a
    // fallback here -- the maximum turn date, say -- would be a different mechanism wearing the
    // same sentence, and the registration's predictions were about the anchor being *absent*.
    const { prompt } = buildPrompt(QUESTION, [DATED], 'temporal', { maxChars: 4000 });
    expect(prompt).not.toMatch(ANCHOR);
    expect(prompt).not.toMatch(/resolve every relative expression/i);
  });
});

describe('the routes that have no anchor, stated rather than assumed', () => {
  it('renders no anchor on the flat route even when a date is handed to the builder', () => {
    // `buildPrompt` deliberately drops `questionDate` for every contract but `temporal`. This is
    // the routing leak the option's docstring names, and it is what makes "add a date frame to
    // IE/KU" a no-op at the builder level: the date is discarded before it can reach the prompt.
    // `abstention-evidence-blocks` is the shipped contract, so this is the rendering IE and KU
    // actually travel; `flat` is the route's name in the reach tables, not a contract.
    const { prompt } = buildPrompt(QUESTION, [DATED], 'abstention-evidence-blocks', {
      questionDate: '2023/06/02',
      maxChars: 4000,
    });
    expect(prompt).not.toMatch(ANCHOR);
    // And the block date is still there, because that half was never route-specific.
    expect(prompt).toContain('[2023/05/20]');
  });

  it('renders no anchor on the multi-session route, which has no date parameter at all', () => {
    // `multi-session` is the one route with neither half: no anchor, because `buildSessionPrompt`
    // takes no date, and this is the only remaining place `PREREG-DATE-FRAME`'s mechanism could
    // act. Whether it *would* act is the open question; that it is absent is a fact about the code.
    const { prompt } = buildSessionPrompt(
      'How many times did I run in May?',
      [sessionOf([DATED])],
      {
        maxChars: 4000,
      },
    );
    expect(prompt).not.toMatch(ANCHOR);
    expect(prompt).not.toMatch(/resolve every relative expression/i);
    expect(prompt).toContain('[2023/05/20]');
  });
});
