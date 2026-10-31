/**
 * The judge audit's own tests.
 *
 * ## What is being protected here
 *
 * A false-accept rate is only worth publishing if every case in it is *provably* wrong and if the
 * judge could not have met the substituted token in the conversation. Both are properties of the
 * planner, not of the judge, so they are asserted here without a model and without a key — the same
 * division `competitor-harness` uses, and the reason this instrument can be reviewed by someone who
 * cannot run it.
 *
 * The failure this prevents is specific and quiet: a perturbation that leaves the gold answer intact
 * would produce a *correct* answer, the judge would say yes, and the yes would be counted as a false
 * accept. The rate would rise for a reason that has nothing to do with the judge.
 */
import { describe, it, expect } from 'vitest';

import { planAudit, summariseAudit } from '../judge-audit.js';

// Derived from the function the tool calls rather than imported: `AuditSource` is not exported (the
// export census refuses a type nothing outside its module consumes), and a test that needed an extra
// `export` to compile would be asking the package to advertise a surface for its own convenience.
type AuditSource = Parameters<typeof planAudit>[0][number];

function source(overrides: Partial<AuditSource> & { questionId: string }): AuditSource {
  return {
    question: 'How many days until the delivery?',
    gold: '18 days',
    conversation: 'The user said the parcel arrives in 18 days. Nothing else was mentioned.',
    answer: 'It will arrive in 18 days.',
    ...overrides,
  };
}

const SOURCES: AuditSource[] = [
  source({ questionId: 'q1' }),
  source({
    questionId: 'q2',
    question: 'Where did Rachel move?',
    gold: 'Rachel moved to Berlin.',
    conversation: 'Rachel said she was leaving Lisbon for a new job.',
    answer: 'Rachel moved to Berlin.',
  }),
  source({
    questionId: 'q3',
    question: 'Which book did Marcus finish?',
    gold: 'Marcus finished Dune.',
    conversation: 'Marcus mentioned reading science fiction on the train.',
    answer: 'Marcus finished Dune.',
  }),
];

describe('every planned case is wrong by construction', () => {
  it('never leaves the gold answer intact inside the perturbed answer', () => {
    // The one invariant a false-accept rate rests on. Where the original contained the gold, the
    // perturbed text must not — otherwise the judge would be right to accept it.
    for (const auditCase of planAudit(SOURCES)) {
      if (!auditCase.original.includes(auditCase.gold)) continue;
      expect(auditCase.answer).not.toContain(auditCase.gold);
    }
  });

  it('never introduces a token the conversation already contains', () => {
    // A swapped entity the user had actually mentioned could be another true fact, and a yes would
    // be right for a reason the instrument cannot see. Excluding it removes that explanation.
    const byId = new Map(SOURCES.map((entry) => [entry.questionId, entry]));
    for (const auditCase of planAudit(SOURCES)) {
      const conversation = byId.get(auditCase.questionId)!.conversation;
      expect(conversation).not.toContain(auditCase.introduced);
    }
  });

  it('changes the answer in every case, and names what it introduced', () => {
    for (const auditCase of planAudit(SOURCES)) {
      expect(auditCase.answer).not.toBe(auditCase.original);
      expect(auditCase.introduced.length).toBeGreaterThan(0);
    }
  });

  it('refuses to emit a case whose borrowed gold contains this question gold', () => {
    // `cross-gold` borrows a real gold. If one gold contains the other, the borrowed answer is
    // correct for this question and a "yes" on it would be a true accept counted as a false one.
    const nested: AuditSource[] = [
      source({ questionId: 'a', gold: '18 days', answer: 'It will arrive in 18 days.' }),
      source({
        questionId: 'b',
        question: 'When does the parcel arrive?',
        gold: 'the parcel arrives in 18 days from Tuesday',
        conversation: 'unrelated',
        answer: 'the parcel arrives in 18 days from Tuesday',
      }),
    ];
    const crossGold = planAudit(nested).filter((auditCase) => auditCase.kind === 'cross-gold');
    expect(crossGold).toEqual([]);
  });
});

describe('the plan is a function of the corpus and nothing else', () => {
  it('produces the same cases twice', () => {
    // A published rate has to be reproducible from the artifact alone, so no case may depend on a
    // clock, on a random draw, or on object iteration order.
    expect(planAudit(SOURCES)).toEqual(planAudit(SOURCES));
    // Order of the input must not change what is audited, only the order it is listed in. This is
    // the property that lets a second reader rebuild the same cases from a differently-sorted
    // artifact — and `cross-gold` borrows by sorted id, so a stable set is not automatic.
    const byCase = (cases: ReturnType<typeof planAudit>) =>
      [...cases].sort((a, b) =>
        `${a.questionId}:${a.kind}`.localeCompare(`${b.questionId}:${b.kind}`),
      );
    expect(byCase(planAudit([...SOURCES].reverse()))).toEqual(byCase(planAudit(SOURCES)));
  });

  it('emits every kind that the corpus can support', () => {
    const kinds = new Set(planAudit(SOURCES).map((auditCase) => auditCase.kind));
    expect(kinds).toEqual(new Set(['number-swap', 'entity-swap', 'cross-gold']));
  });

  it('emits nothing rather than a bogus case when the corpus supports nothing', () => {
    // A gold with no number and no name is not auditable by substitution. Emitting "the same answer
    // with a full stop" would be a case that always passes and drags the rate toward zero.
    const plain: AuditSource[] = [
      source({
        questionId: 'only',
        gold: 'it depends',
        answer: 'it depends',
        conversation: 'nothing useful was said',
      }),
    ];
    expect(planAudit(plain)).toEqual([]);
  });

  it('skips a number the conversation already mentions, and takes the next candidate', () => {
    // 18 * 7 + 13 = 139. If the conversation had said "139" the case would be unanswerable, so the
    // planner has to fall through to 18 * 3 + 101 = 155 rather than emit it anyway.
    const collides: AuditSource[] = [
      source({
        questionId: 'c',
        conversation: 'The user mentioned 139 in another sentence.',
        answer: '18 days',
      }),
    ];
    const planned = planAudit(collides).filter((auditCase) => auditCase.kind === 'number-swap');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.introduced).toBe('155');
  });
});

describe('the reading is arithmetic on verdicts, and refuses a partial one', () => {
  const cases = planAudit(SOURCES);

  it('counts accepts over cases, per kind, and the control separately', () => {
    const verdicts = cases.map((auditCase) => ({ accepted: auditCase.kind === 'cross-gold' }));
    const control = cases.map(() => ({ accepted: true }));
    const reading = summariseAudit(cases, verdicts, control);

    expect(reading.cases.total).toBe(cases.length);
    expect(reading.cases.accepted).toBe(cases.filter((c) => c.kind === 'cross-gold').length);
    expect(reading.byKind['cross-gold'].rate).toBe(1);
    expect(reading.byKind['number-swap'].rate).toBe(0);
    expect(reading.control.rate).toBe(1);
  });

  it('reports a Wilson upper bound rather than the raw ratio', () => {
    // The number that matters: with no accepts at all the bound is not zero, and an audit that
    // reports 0% is claiming more than it measured.
    const verdicts = cases.map(() => ({ accepted: false }));
    const reading = summariseAudit(cases, verdicts, verdicts);
    expect(reading.cases.rate).toBe(0);
    expect(reading.cases.upper).toBeGreaterThan(0);
    expect(reading.cases.upper).toBeLessThan(1);
  });

  it('refuses a verdict list that does not cover every case', () => {
    expect(() =>
      summariseAudit(
        cases,
        cases.slice(1).map(() => ({ accepted: false })),
        [],
      ),
    ).toThrow(/partial reading is not a rate/);
  });

  it('reports exactly zero for a kind no case exercised, instead of dividing by zero', () => {
    const onlyCross = cases.filter((auditCase) => auditCase.kind === 'cross-gold');
    const reading = summariseAudit(
      onlyCross,
      onlyCross.map(() => ({ accepted: false })),
      [],
    );
    expect(reading.byKind['number-swap']).toEqual({ total: 0, accepted: 0, rate: 0, upper: 1 });
  });
});

describe('the two failures a real artifact produced, kept as cases', () => {
  it('destroys every occurrence of the gold, not just the first', () => {
    // Question `75499fd8` answers "…it would suit a Golden Retriever like Max…" and closes with
    // "Golden Retriever" on its own line. Replacing the first occurrence left the gold intact at the
    // end, so the judge would have been RIGHT to accept the case and the audit would have counted it
    // as a false accept. Both occurrences have to go.
    const twice: AuditSource[] = [
      source({
        questionId: 'twice',
        question: 'What kind of dog does the user have?',
        gold: 'Golden Retriever',
        conversation: 'The user mentioned Max, a dog, and a nylon collar.',
        answer: 'It would suit a Golden Retriever like Max.\n\nGolden Retriever',
      }),
      // A second source only so the replacement pool holds a name this question never mentions. The
      // pool is built from every gold in the corpus, which is what keeps the substitute plausible.
      source({
        questionId: 'pool',
        question: 'Which library did the user visit?',
        gold: 'Kensington Library',
        conversation: 'The user borrowed two novels.',
        answer: 'Kensington Library',
      }),
    ];
    const planned = planAudit(twice).filter(
      (auditCase) => auditCase.kind === 'entity-swap' && auditCase.questionId === 'twice',
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]!.answer).not.toContain('Golden Retriever');
    expect(planned[0]!.answer).toContain(planned[0]!.introduced);
  });

  it('handles a one-character gold without telling a number from its digits', () => {
    // Gold `"3"` is real in this dataset, and `"34".includes("3")` is true — so a substring-based
    // invariant would have rejected every numeric swap on a count question, which is precisely the
    // family the MR capability is made of. The invariant has to be word-boundary aware.
    const count: AuditSource[] = [
      source({
        questionId: 'count',
        question: 'How many bikes does the user own?',
        gold: '3',
        conversation: 'The user talked about riding to work.',
        answer: '3',
      }),
    ];
    const planned = planAudit(count).filter((auditCase) => auditCase.kind === 'number-swap');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.introduced).toBe('34');
    expect(planned[0]!.answer).toBe('34');
  });

  it('does not run the token pass on top of the gold pass', () => {
    // The first version of the substitution applied both and produced "344" for the case above: a
    // number that appears in no conversation, and a second uncontrolled variable inside a case whose
    // only job is to move one token.
    const count: AuditSource[] = [
      source({
        questionId: 'c2',
        question: 'How many?',
        gold: '3',
        conversation: 'nothing',
        answer: '3',
      }),
    ];
    const planned = planAudit(count).find((auditCase) => auditCase.kind === 'number-swap')!;
    expect(planned.answer).not.toContain('344');
  });
});
