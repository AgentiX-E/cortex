import { describe, expect, it } from 'vitest';

import { scoreA3, type A3Trial } from '../a3.js';
import { planReview, renderA3ReviewPage, resumeKey, type ReviewCard } from '../review-page.js';

/**
 * The page is an instrument, so it is tested like one.
 *
 * The assertions that matter are not "does it contain the words". They are: does the data survive
 * the round trip through a `<script>` element (the user's sentence is arbitrary text), does the
 * order alternate (otherwise fatigue is confounded with the treatment), and does the JSONL this page
 * exports actually satisfy `scoreA3` (otherwise a person's twenty judgements are discarded at the
 * last step, which is the worst possible place to lose them).
 */

const CARDS: ReviewCard[] = [
  {
    cardId: 'c1',
    source: 'I moved to Berlin in March and I work at Acme on payments.',
    atoms: ['I moved to Berlin in March', 'I work at Acme on payments'],
  },
  {
    cardId: 'c2',
    source: 'The bookshop reopens next month.',
    atoms: ['The bookshop reopens next month.'],
  },
  {
    cardId: 'c3',
    source: 'I keep notes on paper and I read on the train.',
    atoms: ['I read on the train.'],
  },
];

function page(overrides: Partial<Parameters<typeof renderA3ReviewPage>[0]> = {}): string {
  return renderA3ReviewPage({
    cards: CARDS,
    promptVersion: 'triage-proposer/v2',
    profile: 'local qwen dtype=q4 inference-network=none',
    ...overrides,
  });
}

/** The JSON blob, parsed the way the client parses it. */
function payload(html: string): {
  resumeKey: string;
  pairCount: number;
  steps: { cardId: string; arm: string; source: string; atoms: string[]; index: number }[];
  revealGold: boolean;
} {
  const start = html.indexOf('id="a3-data">') + 'id="a3-data">'.length;
  const end = html.indexOf('</script>', start);
  return JSON.parse(html.slice(start, end)) as never;
}

describe('planReview', () => {
  it('alternates which arm comes first, so fatigue lands on both', () => {
    const { pairs } = planReview(CARDS);
    expect(pairs.map((pair) => pair.first)).toEqual(['source', 'atoms', 'source']);
  });

  it('drops a card with no atoms instead of showing an empty second arm', () => {
    const { pairs, skipped } = planReview([
      ...CARDS,
      { cardId: 'c4', source: 'nothing to split', atoms: [] },
    ]);
    expect(pairs).toHaveLength(3);
    expect(skipped.map((card) => card.cardId)).toEqual(['c4']);
  });
});

describe('resumeKey', () => {
  it('changes with the prompt, because two prompts are two reviews', () => {
    const base = { cards: CARDS, profile: 'p' };
    const first = resumeKey({ ...base, promptVersion: 'v2' });
    const second = resumeKey({ ...base, promptVersion: 'v3' });
    expect(first).not.toBe(second);
  });

  it('is stable for the same experiment, and changes when the cards do', () => {
    const one = resumeKey({ cards: CARDS, promptVersion: 'v2', profile: 'p' });
    const two = resumeKey({ cards: CARDS, promptVersion: 'v2', profile: 'different profile line' });
    expect(two).toBe(one);
    const three = resumeKey({ cards: CARDS.slice(1), promptVersion: 'v2', profile: 'p' });
    expect(three).not.toBe(one);
  });
});

describe('the rendered page', () => {
  it('carries both presentations for every card, in the planned order', () => {
    const data = payload(page());
    expect(data.pairCount).toBe(3);
    expect(data.steps).toHaveLength(6);
    // Card 0 shows the sentence first, card 1 shows the atoms first.
    expect(data.steps.slice(0, 2).map((step) => step.arm)).toEqual(['source', 'atoms']);
    expect(data.steps.slice(2, 4).map((step) => step.arm)).toEqual(['atoms', 'source']);
    expect(data.steps[0]?.source).toBe(CARDS[0]?.source);
    expect(data.steps[3]?.atoms).toEqual(CARDS[1]?.atoms);
  });

  it('names the prompt and the profile on the page, not only in the file name', () => {
    const html = page();
    expect(html).toContain('triage-proposer/v2');
    expect(html).toContain('local qwen dtype=q4');
  });

  it('survives a sentence that tries to close the script element', () => {
    // The card text is the user's, and one of the things a user can type is `</script>`. If the JSON
    // blob is emitted with plain `JSON.stringify`, the element ends there and the rest of the
    // sentence becomes markup -- in a file that is opened from disk with full access to itself.
    const hostile = '</script><script>alert(1)</script>';
    const html = page({ cards: [{ cardId: 'x', source: hostile, atoms: [hostile] }] });
    const data = payload(html);
    expect(data.steps[0]?.source).toBe(hostile);
    expect(data.steps[0]?.atoms).toEqual([hostile]);
    // Exactly two script elements: the data blob and the client. The payload added none.
    expect(html.match(/<script/g) ?? []).toHaveLength(2);
  });

  it('escapes the sentence in the rendered instructions as well as in the data', () => {
    const html = page({
      cards: [{ cardId: 'x', source: '<img src=x onerror=alert(1)>', atoms: ['a'] }],
    });
    expect(html).not.toContain('<img src=x');
  });

  it('loads nothing from the network', () => {
    // A page opened from `file://` that fetches a stylesheet is a page that does not work offline,
    // and a review tool that needs a server is a review that does not happen.
    const html = page();
    for (const forbidden of ['src="http', 'href="http', 'fetch(', 'XMLHttpRequest', 'import(']) {
      expect(html, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the fixture label out of the page unless it is asked for', () => {
    // The label is rendered by the client from the payload, so the assertion is on the payload and
    // not on the document: the script's own template string always contains the words "fixture
    // label", and asserting on the document would test the template rather than the decision.
    const labelled: ReviewCard[] = [{ ...CARDS[0]!, gold: 'private' }];
    const off = payload(page({ cards: labelled }));
    expect(off.revealGold).toBe(false);
    expect(JSON.stringify(off)).not.toContain('private');

    const on = payload(page({ cards: labelled, revealGold: true }));
    expect(on.revealGold).toBe(true);
    expect(JSON.stringify(on)).toContain('private');
  });

  it('says how many cards were left out, rather than silently dropping them', () => {
    // A card with no atoms cannot be shown under the second arm. Dropping it without a word would
    // make the review look like it covered every card the file had.
    const html = page({
      cards: [...CARDS, { cardId: 'c4', source: 'nothing to split', atoms: [] }],
    });
    expect(html).toContain('1 card(s) had no atoms');
    expect(payload(html).pairCount).toBe(3);
  });

  it('refuses to render a review with nothing to compare', () => {
    expect(() => page({ cards: [{ cardId: 'x', source: 's', atoms: [] }] })).toThrow(
      /no reviewable pair/,
    );
  });
});

describe('the JSONL the page exports', () => {
  /**
   * The round trip that has to hold: page -> JSONL line -> `scoreA3`.
   *
   * A page that exports almost the right shape loses twenty judgements at the last step, and the
   * person who made them has no way to know. So the schema is asserted by *scoring* it, not by
   * comparing keys.
   */
  it('scores when every card is accepted under both presentations', () => {
    // Twenty pairs, because that is the pre-registered count: below it `scoreA3` refuses to report
    // anything but `underpowered`, which is the behaviour the first version of this test walked into.
    const many: ReviewCard[] = Array.from({ length: 20 }, (_, index) => ({
      cardId: `c${index}`,
      source: `sentence ${index}`,
      atoms: [`sentence ${index}`],
    }));
    const decisions: A3Trial[] = [];
    for (const card of many) {
      decisions.push({ cardId: card.cardId, arm: 'source', decision: 'accept', elapsedMs: 1200 });
      decisions.push({ cardId: card.cardId, arm: 'atoms', decision: 'accept', elapsedMs: 900 });
    }
    // Exactly what the page writes into `#a3-json`: one `JSON.stringify` per decision.
    const lines = decisions.map((trial) => JSON.stringify(trial));
    const parsed = lines.map((line) => JSON.parse(line) as A3Trial);
    const result = scoreA3(parsed);
    expect(result.verdict).toBe('no-difference');
    expect(result.pairCount).toBe(20);
  });

  it('scores an edit as an accept, which is what the page says it does', () => {
    const decisions: A3Trial[] = [
      { cardId: 'c1', arm: 'source', decision: 'dismiss' },
      { cardId: 'c1', arm: 'atoms', decision: 'edit', editedTo: 'I work at Acme on payments' },
    ];
    const result = scoreA3(decisions.map((trial) => JSON.parse(JSON.stringify(trial)) as A3Trial));
    // One pair, one discordant, and one pair is below the pre-registered count of twenty.
    expect(result.verdict).toBe('underpowered');
    expect(result.arms[1].edited).toBe(1);
  });
});
