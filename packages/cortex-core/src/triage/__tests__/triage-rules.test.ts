/**
 * The rule table, held against three kinds of evidence.
 *
 * 1. **Its own shape.** Ordering, unique ids, stateless patterns -- the properties that make the
 *    fail-closed argument true rather than merely intended.
 * 2. **Synthetic samples, one per rule.** Every rule must be able to fire. A table read by eye
 *    looks complete; three of its eight rules never fire on the real corpus at all, which the last
 *    describe block states out loud instead of leaving to a reader's optimism.
 * 3. **Sixty hand-labelled utterances, and thirteen rows a CI run once published by mistake.**
 *    The counts are asserted, so a rule change is a deliberate act with a visible cost.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RULE_TABLE,
  RuleTableError,
  assertRuleTable,
  classify,
  destinationOf,
  type TriageRule,
} from '../rules.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type LabelledRow = {
  id: string;
  text: string;
  gold: 'private' | 'shared' | 'defer';
  category: string;
};

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8')) as T;
}

const LABELS = fixture<{ rows: LabelledRow[]; policy: string; limits: string }>(
  'triage-labels.json',
);
const REGRESSIONS = fixture<{
  rows: { id: string; text: string; truncated?: boolean }[];
}>('triage-regressions.json');

/**
 * A Wilson score upper bound -- the same definition `docs/04` quotes, reproduced here rather than
 * imported so that a change to the document's numbers cannot silently pass through this test.
 *
 * The reason it exists at all: a zero is not a zero rate. 0 of 12 is consistent with a true rate as
 * high as 24%, so "no leaks observed" and "no leaks" are different claims and only the first is
 * available from this corpus.
 */
function wilsonUpper(successes: number, n: number, z = 1.959_963_984_540_054): number {
  if (n === 0) return 1;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / denominator);
}

/** One sentence that must fire each rule, written to be recognisable rather than clever. */
const SAMPLES: Record<string, string> = {
  credential: 'My passport number and the api key for the staging cluster are in the vault.',
  'strong-pii': 'Send the invoice to dana.reyes@example.com or call +44 20 7946 0958.',
  money: 'The mortgage is 1,240 dollars a month and I cannot afford the second one.',
  health: 'My GP changed the prescription after the blood pressure reading came back at 138.',
  family: 'My daughter starts school in September and my wife is travelling that week.',
  'career-status':
    'I was promoted to staff engineer last quarter and then resigned from the board.',
  'third-party': 'My manager asked me to keep the reorganisation quiet for now.',
  'org-knowledge': 'We decided the onboarding checklist moves into the shared workspace.',
};

/** Sentences that contain a rule's keywords but must not fire it, with the reason. */
const TRAPS: { text: string; notRule: string; why: string }[] = [
  {
    text: 'We raised funds for the food bank at the team-building day.',
    notRule: 'career-status',
    why: '"raise" was firing on fundraising; the word sense is a pay review, not a collection',
  },
  {
    text: 'I have a few meetings scheduled at work, and I need to finish a report by Friday.',
    notRule: 'org-knowledge',
    why: 'a personal to-do that happens at work is not an organisational object',
  },
];

describe('the table as a table', () => {
  it('passes its own validation', () => {
    expect(() => assertRuleTable(RULE_TABLE)).not.toThrow();
  });

  it('puts every private rule before every shared rule', () => {
    // Stated as an assertion rather than trusted, because the ordering *is* the fail-closed
    // argument: one shared rule moved above a private one publishes the sentences where both fire.
    const scopes = RULE_TABLE.map((rule) => rule.scope);
    const firstShared = scopes.indexOf('shared');
    expect(firstShared).toBeGreaterThan(0);
    expect(scopes.slice(firstShared).every((scope) => scope === 'shared')).toBe(true);
  });

  it('has unique ids, because the id is what a disputed decision is attributed to', () => {
    const ids = RULE_TABLE.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has exactly one shared rule, which is the whole publishing surface', () => {
    // If this number grows, the false-share rate is no longer governed by one pattern and the
    // three-thousand-row measurement in docs/04 stops applying to the table as it now stands.
    expect(RULE_TABLE.filter((rule) => rule.scope === 'shared')).toHaveLength(1);
  });

  describe('refuses a table that cannot hold the boundary', () => {
    const base: TriageRule = { id: 'base', scope: 'private', policy: 'p', pattern: /x/i };
    const shared: TriageRule = { id: 'open', scope: 'shared', policy: 'p', pattern: /y/i };

    it('rejects a private rule placed after a shared one', () => {
      expect(() => assertRuleTable([shared, base])).toThrow(RuleTableError);
      expect(() => assertRuleTable([shared, base])).toThrow(/inverse of fail-closed/);
    });

    it('rejects a duplicate id', () => {
      expect(() => assertRuleTable([base, { ...base, pattern: /z/i }])).toThrow(
        /duplicate rule id/,
      );
    });

    it('rejects an empty id', () => {
      expect(() => assertRuleTable([{ ...base, id: '' }])).toThrow(/empty id/);
    });

    it('rejects an unknown scope', () => {
      const broken = { ...base, scope: 'public' } as unknown as TriageRule;
      expect(() => assertRuleTable([broken])).toThrow(/unknown scope/);
    });

    it('rejects a rule with no policy sentence', () => {
      expect(() => assertRuleTable([{ ...base, policy: '   ' }])).toThrow(/no policy sentence/);
    });

    it('rejects a global pattern, because test() would then remember where it was', () => {
      // The defect this prevents is invisible to every test that classifies a sentence once: with
      // /g, the second call on the same text starts at lastIndex and silently answers "no match".
      expect(() => assertRuleTable([{ ...base, pattern: /x/gi }])).toThrow(/lastIndex/);
      expect(() => assertRuleTable([{ ...base, pattern: /x/y }])).toThrow(/lastIndex/);
    });
  });
});

describe('each rule can fire', () => {
  it('has a sample for every rule in the table', () => {
    // A rule with no sample is a rule nobody has ever seen fire. The map is asserted against the
    // table in both directions so that adding a rule without a sample fails here.
    expect(Object.keys(SAMPLES).sort()).toEqual(RULE_TABLE.map((rule) => rule.id).sort());
  });

  it.each(Object.entries(SAMPLES))('%s fires on its own sample', (id, text) => {
    const decision = classify(text);
    expect(decision.rule).toBe(id);
    const rule = RULE_TABLE.find((candidate) => candidate.id === id);
    expect(decision.scope).toBe(rule?.scope);
    expect(decision.policy).toBe(rule?.policy);
  });

  it.each(TRAPS)('does not fire $notRule on "$text"', ({ text, notRule }) => {
    expect(classify(text).rule).not.toBe(notRule);
  });

  it('never reaches a state where the table is empty', () => {
    // An empty table would classify everything as `defer`, which is safe and useless. Asserted
    // because "safe" is the kind of property that hides a regression to a no-op.
    const empty = classify('anything at all', []);
    expect(empty).toEqual({ scope: 'defer', rule: null, policy: null });
  });
});

describe('ordering is the fail-closed argument, tested across the whole table', () => {
  // For every private rule: a sentence that fires it, with an organisational tail appended. The
  // tail must actually match the shared rule -- otherwise the test would pass on sentences where
  // nothing competed, which is the shape of a test that cannot fail.
  const privateRules = RULE_TABLE.filter((rule) => rule.scope === 'private');

  it.each(privateRules.map((rule) => rule.id))(
    '%s wins over the shared rule when both match',
    (id) => {
      const text = `${SAMPLES[id]} We decided this at the project retro.`;
      const shared = RULE_TABLE.find((rule) => rule.scope === 'shared');
      expect(shared?.pattern.test(text), 'the shared rule must match, or there is no contest').toBe(
        true,
      );

      const decision = classify(text);
      expect(decision.rule).toBe(id);
      expect(destinationOf(decision)).toBe('private');
    },
  );

  it('routes a purely organisational sentence to the shared store', () => {
    const decision = classify(SAMPLES['org-knowledge'] ?? '');
    expect(decision.scope).toBe('shared');
    expect(destinationOf(decision)).toBe('shared');
  });

  it('sends a deferral home privately', () => {
    // The single most important line in the write path: a decision nobody made is not consent.
    expect(destinationOf({ scope: 'defer', rule: null, policy: null })).toBe('private');
  });
});

describe('the sixty labelled utterances', () => {
  const rows = LABELS.rows;
  const classified = rows.map((row) => ({ row, decision: classify(row.text) }));

  it('classifies every row deterministically', () => {
    // Stateful regexes answer differently on a second pass. `assertRuleTable` refuses `/g`, and
    // this is the behavioural half of that check: same input, same output, twice.
    for (const { row, decision } of classified) {
      expect(classify(row.text)).toEqual(decision);
    }
  });

  it('decides 19 of 60, which is 31.7% -- the rule layer is a minority path', () => {
    // Was 16 (26.7%) until the card queue's first measurement found three ordinary exercise and
    // diet sentences that no rule caught. The widening is `walk|sugar|calorie|intake` in `health`,
    // justified by the policy and measured on three corpora before it shipped -- see the comment in
    // `rules.ts` and docs/04 section 9.9.
    const decided = classified.filter(({ decision }) => decision.scope !== 'defer');
    expect(decided).toHaveLength(19);
    expect(((decided.length / rows.length) * 100).toFixed(1)).toBe('31.7');
  });

  it('shares nothing that was labelled private, and says what that is worth', () => {
    const goldPrivate = classified.filter(({ row }) => row.gold === 'private');
    const leaked = goldPrivate.filter(({ decision }) => destinationOf(decision) === 'shared');

    expect(goldPrivate).toHaveLength(12);
    expect(leaked).toHaveLength(0);
    // The bound is the claim. 0/12 is compatible with a true rate near one in four, so this corpus
    // can price a *mechanism* but cannot certify a rate -- that is what the next test is for.
    expect(wilsonUpper(0, goldPrivate.length)).toBeCloseTo(0.2425, 4);
  });

  it('reaches only half of what is legitimately shareable, which is why cards exist', () => {
    const goldShared = classified.filter(({ row }) => row.gold === 'shared');
    const reached = goldShared.filter(({ decision }) => destinationOf(decision) === 'shared');

    expect(goldShared).toHaveLength(8);
    expect(reached).toHaveLength(4);
    // The other four become cards. `docs/04` prices the queue's ceiling at 8/8 with zero leakage,
    // which is the number that makes the queue worth building rather than a nicety.
    expect(goldShared.length - reached.length).toBe(4);
  });
});

describe('the rules that this corpus never exercises', () => {
  it('names them, instead of letting a green run imply the whole table is measured', () => {
    // This is the lesson from POC-6, applied one level up: before reporting "the rule layer holds",
    // count which rules the corpus gave a chance to fail. Nothing here is a defect -- credentials
    // and regulated identifiers simply do not appear in LongMemEval conversations -- but reading
    // "60/60 classified" as "8/8 rules tested" would be a bound over a mechanism that never ran.
    const fired = new Set(
      LABELS.rows.map((row) => classify(row.text).rule).filter((id): id is string => id !== null),
    );
    expect([...fired].sort()).toEqual(['family', 'health', 'money', 'org-knowledge']);
    expect(
      RULE_TABLE.map((rule) => rule.id)
        .filter((id) => !fired.has(id))
        .sort(),
    ).toEqual(['career-status', 'credential', 'strong-pii', 'third-party']);
    // Those four are covered by `describe('each rule can fire')` and by the CI corpus in `docs/04`
    // (3,000 identifier-bearing rows, one publication after two rule rounds), not here.
    //
    // `third-party` joined this list by accident rather than by design: the one row it used to fire
    // here is "a 5 km walk with my colleagues", which also matches `health`, and `health` precedes
    // it. The scope is private either way, so no reading moved -- but the audit trail now says
    // `health` about a sentence whose point is a friend. That is the kind of attribution drift a
    // rule table accumulates while every metric stays still.
  });
});

describe('rows that were published by mistake, once', () => {
  it('keeps every judgeable row private, and counts the one it cannot judge', () => {
    const judgeable = REGRESSIONS.rows.filter((row) => row.truncated !== true);
    const skipped = REGRESSIONS.rows.length - judgeable.length;

    expect(REGRESSIONS.rows).toHaveLength(13);
    expect(skipped).toBe(1);

    const stillPublished = judgeable.filter((row) => classify(row.text).scope === 'shared');
    expect(stillPublished.map((row) => row.id)).toEqual([]);
    expect(judgeable).toHaveLength(12);
  });

  it('names why the skipped row is skipped rather than dropping it', () => {
    // The row's identifier fell past the 160-character cut in the report that recorded it, so the
    // string in this fixture cannot exercise the pattern that condemned it. It stays in the file
    // with its reason: deleting it would make the gate look complete, and counting it as a pass
    // would make it look earned.
    const truncated = REGRESSIONS.rows.filter((row) => row.truncated === true);
    expect(truncated.map((row) => row.id)).toEqual(['pii01216']);
    expect(truncated[0]?.text).not.toMatch(/\d{4,}/);
  });
});
