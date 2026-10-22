/**
 * The output guard, tested where it can hurt: what it lets through, and what it wrongly stops.
 *
 * ## The two numbers that decide whether this layer survives
 *
 * A guard that misses a leak is a false promise; a guard that blocks ordinary answers is a feature
 * people switch off, after which it protects nothing. So the suite measures both, on the same sixty
 * utterances the rest of the triage layer uses:
 *
 *   * every published fact may be quoted in a draft (0 false blocks), and
 *   * every gold-private fact is stopped when a draft quotes it (12/12).
 *
 * Neither number is a claim about paraphrase, which this layer cannot see. That is stated in the
 * module docstring of `output-guard.ts` and again here, because it is the claim most likely to be
 * overstated by a reader who only looks at the numbers.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MemoryStorage } from '../../__tests__/support/memory-storage.js';
import { FederatedStorage } from '../../federation/federated-storage.js';
import { ReadSideAssembler } from '../../federation/read-side.js';
import { OutputGuard, type OutputScan } from '../output-guard.js';
import { RULE_TABLE, type TriageRule } from '../rules.js';
import { TriageWriter } from '../writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type LabelledRow = { id: string; text: string; gold: 'private' | 'shared' | 'defer' };

function labels(): LabelledRow[] {
  const file = JSON.parse(readFileSync(join(HERE, 'fixtures', 'triage-labels.json'), 'utf8')) as {
    rows: LabelledRow[];
  };
  return file.rows;
}

const guard = new OutputGuard();

/** Findings of one kind, which is what most assertions are actually about. */
function kinds(scan: OutputScan): string[] {
  return scan.findings.map((finding) => finding.kind);
}

describe('O1: a shared draft that restates a private fact', () => {
  it('blocks it, and says which rule and where', () => {
    const draft = 'Sure. By the way, your mortgage payment went up by 200 dollars this month.';
    const scan = guard.scan(draft, { task: 'shared' });

    expect(scan.verdict).toBe('blocked');
    const [finding] = scan.findings;
    expect(finding?.kind).toBe('private-scope');
    expect(finding?.rule).toBe('money');
    expect(finding?.policy).toMatch(/amounts, income, budget, debt/);
    // The span has to point at the sentence, not at the draft: a caller highlighting the whole
    // answer would be telling the user nothing.
    expect(draft.slice(finding?.span[0], finding?.span[1])).toContain('mortgage');
  });

  it('leaves an ordinary organisational answer alone', () => {
    // The false-block direction. If this ever goes red, the guard is on its way to being turned off.
    const scan = guard.scan('We decided the roadmap moves to Q3, and the sprint ends Thursday.', {
      task: 'shared',
      requireCitation: false,
    });
    expect(scan.verdict).toBe('clear');
    expect(scan.findings).toEqual([]);
  });

  it('excuses a shared fact that mentions money, and names the row that says so', () => {
    // A shared answer may legitimately quote a shared fact. Without this, the first draft about an
    // approved budget would be blocked, someone would disable the guard, and the layer would be gone.
    const scan = guard.scan('The approved budget is 50,000 dollars for the quarter.', {
      task: 'shared',
      requireCitation: false,
      window: [
        {
          origin: 'shared',
          key: 'budget-fact',
          value: {
            id: 'budget-fact',
            text: 'The approved budget is 50,000 dollars for the quarter.',
          },
        },
      ],
    });

    expect(scan.verdict).toBe('clear');
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]?.excusedBy).toBe('budget-fact');
    // Kept in the report rather than dropped: the reader is entitled to see that a sentence looked
    // like a violation and why it is not one.
    expect(scan.findings[0]?.kind).toBe('private-scope');
  });

  it('does not excuse the same sentence from a private row', () => {
    // Only a *shared* row can excuse: a private row with the same words is exactly the leak.
    const scan = guard.scan('The approved budget is 50,000 dollars for the quarter.', {
      task: 'shared',
      requireCitation: false,
      window: [
        {
          origin: 'private',
          key: 'mine',
          value: { id: 'mine', text: 'The approved budget is 50,000 dollars for the quarter.' },
        },
      ],
    });
    expect(scan.verdict).toBe('blocked');
    expect(scan.findings[0]?.excusedBy).toBeUndefined();
  });

  it('blocks the same sentence when the caller supplied no window at all', () => {
    // A caller with no window has nothing to appeal to. That is the right default and a loud one
    // for a caller that simply forgot to pass it.
    const scan = guard.scan('We approved 50,000 dollars for the quarter.', {
      task: 'shared',
      requireCitation: false,
    });
    expect(scan.verdict).toBe('blocked');
  });

  it('names an excusing row that carries no id', () => {
    // A row without a key is still a row -- the router says so, and the excuse has to survive it.
    const scan = guard.scan('We approved 50,000 dollars for the quarter.', {
      task: 'shared',
      requireCitation: false,
      window: [
        {
          origin: 'shared',
          value: { text: 'We approved 50,000 dollars for the quarter.' },
        },
      ],
    });
    expect(scan.verdict).toBe('clear');
    expect(scan.findings[0]?.excusedBy).toBe('<no id>');
  });

  it('ignores a row whose value is not an object at all', () => {
    // Rows are `unknown` by contract; a string, a number or null in that position must not throw
    // inside the guard, and must not excuse anything either.
    const scan = guard.scan('We approved 50,000 dollars for the quarter.', {
      task: 'shared',
      requireCitation: false,
      window: [
        { origin: 'shared', key: 'scalar', value: 'We approved 50,000 dollars for the quarter.' },
        { origin: 'shared', key: 'null', value: null },
      ],
    });
    expect(scan.verdict).toBe('blocked');
  });

  it('ignores a row with no text when deciding whether to excuse', () => {
    const scan = guard.scan('We approved 50,000 dollars for the quarter.', {
      task: 'shared',
      requireCitation: false,
      window: [{ origin: 'shared', key: 'opaque', value: { embedding: [0.1] } }],
    });
    expect(scan.verdict).toBe('blocked');
  });
});

describe('a private task', () => {
  it('may repeat the user own facts, because that is the product working', () => {
    const scan = guard.scan('Your mortgage is 1,200 dollars a month.', {
      task: 'private',
      requireCitation: false,
    });
    expect(scan.verdict).toBe('clear');
    expect(scan.findings).toEqual([]);
  });

  it('still refuses to echo a credential, because the draft is stored and pasted', () => {
    const scan = guard.scan('Your password is correct-horse-battery-staple.', {
      task: 'private',
      requireCitation: false,
    });
    expect(scan.verdict).toBe('blocked');
    expect(kinds(scan)).toEqual(['never-retained']);
    expect(scan.findings[0]?.rule).toBe('credential');
  });

  it('never excuses a credential, even when a shared row contains it', () => {
    // Nothing should be able to whitelist a secret; the excuse path is for scope findings only.
    const scan = guard.scan('The key is sk-live-9f2b41c7d0e8.', {
      task: 'shared',
      requireCitation: false,
      window: [
        {
          origin: 'shared',
          key: 'leaked',
          value: { id: 'leaked', text: 'The key is sk-live-9f2b41c7d0e8.' },
        },
      ],
    });
    expect(scan.verdict).toBe('blocked');
    expect(scan.findings[0]?.excusedBy).toBeUndefined();
  });
});

describe('O2: attribution', () => {
  const window = [
    {
      origin: 'shared' as const,
      key: 'a',
      value: { id: 'a', text: 'We decided the roadmap moves to Q3.' },
    },
  ];

  it('accepts a citation that resolves inside the window', () => {
    const scan = guard.scan('We decided the roadmap moves to Q3 [[a]].', {
      task: 'shared',
      window,
    });
    expect(scan.verdict).toBe('clear');
  });

  it('flags a citation that resolves nowhere, and quotes the id', () => {
    const scan = guard.scan('We decided the roadmap moves to Q3 [[b]].', {
      task: 'shared',
      window,
    });
    expect(scan.verdict).toBe('blocked');
    expect(kinds(scan)).toEqual(['unknown-citation']);
    expect(scan.findings[0]?.excerpt).toBe('b');
  });

  it('flags a shared answer with no citation at all', () => {
    // Not because prose must be footnoted, but because "here is what the team knows" with no source
    // cannot be checked by the person reading it.
    const scan = guard.scan('The roadmap moved to Q3.', { task: 'shared', window });
    expect(scan.verdict).toBe('blocked');
    expect(kinds(scan)).toEqual(['unattributed']);
  });

  it('lets a caller that genuinely does not want citations say so', () => {
    const scan = guard.scan('The roadmap moved to Q3.', {
      task: 'shared',
      window,
      requireCitation: false,
    });
    expect(scan.verdict).toBe('clear');
  });

  it('does not require citations of a private answer by default', () => {
    const scan = guard.scan('You moved the roadmap to Q3.', { task: 'private' });
    expect(scan.verdict).toBe('clear');
  });

  it('reads a citation with surrounding whitespace, and one that is empty', () => {
    const spaced = guard.scan('Roadmap [[ a ]].', { task: 'shared', window });
    expect(spaced.verdict).toBe('clear');

    // `[[]]` cites nothing. It is not an unknown citation -- there is no id to look up -- and it
    // does not satisfy the requirement either, so the draft is still unattributed.
    const empty = guard.scan('Roadmap [[]].', { task: 'shared', window });
    expect(kinds(empty)).toEqual(['unattributed']);
  });
});

describe('the excerpt a person has to read', () => {
  it('clips a long match and marks it', () => {
    // A rule can match far more than a dialog can show, and a truncated string with no marker reads
    // as the whole sentence.
    const draft = `Next step: 1,200 dollars, ${'and '.repeat(80)}then done.`;
    const scan = guard.scan(draft, { task: 'shared', requireCitation: false });
    const excerpt = scan.findings[0]?.excerpt ?? '';
    expect(excerpt.endsWith('…')).toBe(true);
    expect(Array.from(excerpt)).toHaveLength(121);
  });

  it('trims the sentence it reports, including spaces a draft left around punctuation', () => {
    const scan = guard.scan('One.    I paid 5 dollars   . Two.', {
      task: 'shared',
      requireCitation: false,
    });
    expect(scan.findings[0]?.excerpt).toBe('I paid 5 dollars');
    const [start, end] = scan.findings[0]?.span ?? [0, 0];
    expect('One.    I paid 5 dollars   . Two.'.slice(start, end)).toBe('I paid 5 dollars');
  });

  it('collapses whitespace, so a multi-line match stays one row in a table', () => {
    const scan = guard.scan('I spent\n\n  350 dollars on it.', {
      task: 'shared',
      requireCitation: false,
    });
    // The whole sentence, with the line break folded to a space: a wrapped draft must not produce a
    // five-word excerpt.
    expect(scan.findings[0]?.excerpt).toBe('I spent 350 dollars on it');
  });
});

describe('the guard is a function of its input', () => {
  it('gives the same answer twice, which a stateful pattern would not', () => {
    // `firstMatch` copies the rule with a `g` flag to get offsets. A copy that leaked its
    // `lastIndex` back into the table would make the second scan disagree with the first.
    const draft = 'Your mortgage is 1,200 dollars and your salary is 4,000 dollars.';
    const first = guard.scan(draft, { task: 'shared', requireCitation: false });
    const second = guard.scan(draft, { task: 'shared', requireCitation: false });
    expect(second).toEqual(first);
    // The table itself must still classify, i.e. the copy did not mutate it.
    expect(RULE_TABLE.every((rule) => !rule.pattern.global)).toBe(true);
  });

  it('takes a custom table, so a caller can scan for its own policy', () => {
    const internal: TriageRule = {
      id: 'internal-only',
      scope: 'private',
      policy: 'internal codename',
      pattern: /project bluebird/i,
    };
    const scan = new OutputGuard([internal]).scan('Project Bluebird ships in May.', {
      task: 'shared',
      requireCitation: false,
    });
    expect(scan.findings[0]?.rule).toBe('internal-only');
    // And it does not carry the shipped rules along: a guard is the table it was given.
    expect(scan.findings).toHaveLength(1);
  });

  it('reports an empty draft as unattributed rather than crashing', () => {
    const scan = guard.scan('', { task: 'shared' });
    expect(kinds(scan)).toEqual(['unattributed']);
  });
});

describe('measured on the sixty labelled utterances', () => {
  async function publishedWindow(): Promise<{ key: string; value: { text: string } }[]> {
    const local = new MemoryStorage();
    const shared = new MemoryStorage();
    const federation = new FederatedStorage({ private: local, shared });
    const writer = new TriageWriter(federation);

    for (const row of labels()) await writer.admit(row.text, { id: row.id });
    const window = await new ReadSideAssembler(federation).assemble({ task: 'shared' });
    return window.map((row) => ({
      key: row.key ?? '',
      value: row.value as { text: string },
    }));
  }

  it('blocks every gold-private sentence quoted in a shared draft', async () => {
    const rows = labels();
    const blocked = rows
      .filter((row) => row.gold === 'private')
      .filter(
        (row) =>
          guard.scan(`Here is what I remember: ${row.text}`, {
            task: 'shared',
            requireCitation: false,
          }).verdict === 'blocked',
      );

    expect(blocked).toHaveLength(12);
  });

  it('blocks none of the facts that were actually published', async () => {
    // The false-block number, measured against the window rather than against the labels: a draft
    // quoting something the writer put in the shared store must never be refused.
    const window = await publishedWindow();
    expect(window.length).toBeGreaterThan(0);

    const refused = window.filter(
      (row) =>
        guard.scan(`The team knows this: ${row.value.text}`, {
          task: 'shared',
          requireCitation: false,
          window: window.map((entry) => ({
            origin: 'shared' as const,
            key: entry.key,
            value: entry.value,
          })),
        }).verdict === 'blocked',
    );

    expect(refused).toEqual([]);
  });
});
