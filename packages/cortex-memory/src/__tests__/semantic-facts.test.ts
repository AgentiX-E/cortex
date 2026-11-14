/**
 * The fact source: what an authorised substitution becomes, and the four cases where it becomes nothing.
 *
 * ## Why these tests are about refusal as much as about construction
 *
 * `semanticUpdateFrom` returns a unit for a pair of records that support a relation, and `null` for a pair that
 * does not. The `null` cases are not error handling — they are the module's claim about what counts as a
 * knowledge update, and each one is a case where a unit **could** be built and would be wrong:
 *
 * - no date on one end: a reader cannot order the two values, so the block would state two unrelated facts;
 * - the same instant on both: that is a contradiction, not an update, and `revision.ts` reports it as a refuted
 *   `uniqueness` rather than letting an id break the tie;
 * - the same text twice: a substitution that replaces an answer with itself, which `agrees` already refused one
 *   layer up;
 * - a record that is only a dateline: there is no sentence to anchor on, so the update could never be found by
 *   a later window and would be a line that is never rendered.
 *
 * The module's value is the boundary, so the tests spend most of their length on it.
 */

import { describe, expect, it } from 'vitest';

import {
  assembleSemanticUpdate,
  semanticUpdateFrom,
  updateAppliesTo,
  type SemanticUpdate,
} from '../semantic-facts.js';
import type { KnowledgeFact } from '@agentix-e/cortex-core';
import type { SupersessionVerdict } from '../supersede.js';

type Replace = Extract<SupersessionVerdict, { kind: 'replace' }>;

const EARLY = '[2023/01/15 (Sun) 09:10] user: I am at 20 dozen at the moment.';
const LATE = '[2023/03/12 (Sun) 11:40] user: I am at 30 dozen at the moment.';
// The renderer's own shape: `formatEvidence` labels each turn `${index + 1}. ` and separates them with a
// blank line. A fixture that skipped either would be testing a window the product never sends — which is how
// the splitter's numbered-line defect survived every test of it.
const EARLY_RECORD = `1. ${EARLY}`;
const LATE_RECORD = `2. ${LATE}`;
const EVIDENCE = `${EARLY_RECORD}\n\n${LATE_RECORD}`;

const EARLY_AT = Date.UTC(2023, 0, 15, 9, 10);
const LATE_AT = Date.UTC(2023, 2, 12, 11, 40);

function replace(overrides: Partial<Replace> = {}): Replace {
  return {
    kind: 'replace',
    value: '30 dozen',
    record: 1,
    authorised: {
      later: { text: LATE_RECORD, date: '2023/03/12 (Sun) 11:40', at: LATE_AT },
      earlier: { text: EARLY_RECORD, date: '2023/01/15 (Sun) 09:10', at: EARLY_AT },
    },
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof semanticUpdateFrom>[0]> = {}) {
  return semanticUpdateFrom({
    evidence: EVIDENCE,
    frameId: 'semantic:1',
    question: 'How many dozen am I at now?',
    first: '20 dozen',
    verdict: replace(),
    ...overrides,
  });
}

/** The order a reader meets the two facts in, which is the claim the unit makes. */
function texts(update: SemanticUpdate): readonly string[] {
  const byId = new Map(update.unit.facts.map((fact) => [fact.id, fact.text]));
  return update.factIds.map((id) => byId.get(id)!);
}

describe('what an authorised substitution becomes', () => {
  it('states both values and the relation, newer first', () => {
    const update = build();
    expect(update).not.toBeNull();
    expect(texts(update!)).toEqual(['30 dozen', '20 dozen']);
    expect(update!.unit.edges).toHaveLength(1);
    const edge = update!.unit.edges[0]!;
    expect(edge.type).toBe('supersedes');
    expect(edge.from).toBe(update!.factIds[0]);
    expect(edge.to).toBe(update!.factIds[1]);
    expect(edge.origin).toBe('derived');
  });

  it('dates each value from the record it was authorised by, so the order is a fact and not a sort', () => {
    const update = build()!;
    const byId = new Map(update.unit.facts.map((fact) => [fact.id, fact]));
    expect(byId.get(update.factIds[0]!)!.at).toBe(LATE_AT);
    expect(byId.get(update.factIds[1]!)!.at).toBe(EARLY_AT);
  });

  it('puts both facts on one slot, which is what makes them comparable at all', () => {
    const update = build()!;
    const slots = new Set(
      update.unit.facts.map((fact) => `${fact.subject}\u0000${fact.predicate}`),
    );
    expect(slots.size).toBe(1);
    // The subject is the question, not a guessed entity: a guessed subject would let two unrelated questions
    // share a slot, and `deriveSupersedes` would then order values that answer different things.
    expect(update.unit.facts[0]!.subject).toBe('How many dozen am I at now?');
  });

  it('anchors on the record body, not on the rendered header', () => {
    // The header carries a position (`1. `) and the dataset's dateline, both of which change between two
    // renderings of one turn. An anchor that included them would match nothing on the second question --
    // the inert-option failure, arrived at from the data rather than from the code.
    expect(build()!.anchor).toBe('I am at 30 dozen at the moment.');
  });

  it('types both facts as a state, which is the only type a later value can supersede', () => {
    // `deriveSupersedes` refuses to supersede an immutable fact, and `isImmutable` is decided by the type: an
    // `event` whose sentence reads as past is protected, because somebody going to Paris in March is not undone
    // by them going to Rome in June. A fact source that typed these as events would build a unit that renders
    // two statements and no relation — and on the vocabulary this module would be claiming the update is a
    // happening rather than a value that changed.
    const update = build()!;
    expect(update.unit.facts.map((fact) => fact.type)).toEqual(['state', 'state']);
  });

  it('keeps the sentence, and points every span at the words the fact actually used', () => {
    // The campaign measured replacing text with atoms at -19.62 points and never retracted it, so the frame is
    // the evidence verbatim and every fact's span points into it. Asserting the span is non-empty was the weak
    // form and a mutation walked through it: a span of `[0, 1)` is non-empty and points at the first character
    // of the window rather than at the fact. The envelope has to cover every word the fact borrowed, which is
    // what `locate` promises and what an audit reads the span for.
    const update = build()!;
    expect(update.unit.frame.text).toBe(EVIDENCE);
    for (const fact of update.unit.facts) {
      const covered = update.unit.frame.text
        .slice(fact.sourceSpan.start, fact.sourceSpan.end)
        .toLowerCase();
      for (const word of fact.text.toLowerCase().split(/\s+/)) {
        expect(covered).toContain(word);
      }
    }
  });
});

describe('the four pairs that are not an update', () => {
  it('refuses a pair with no date on the newer record', () => {
    const verdict = replace();
    expect(
      semanticUpdateFrom({
        evidence: EVIDENCE,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        verdict: {
          ...verdict,
          authorised: { ...verdict.authorised, later: { text: LATE_RECORD, date: null, at: null } },
        },
      }),
    ).toBeNull();
  });

  it('refuses a pair with no date on the older record', () => {
    const verdict = replace();
    expect(
      semanticUpdateFrom({
        evidence: EVIDENCE,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        verdict: {
          ...verdict,
          authorised: {
            ...verdict.authorised,
            earlier: { text: EARLY_RECORD, date: null, at: null },
          },
        },
      }),
    ).toBeNull();
  });

  it('refuses a pair whose previous answer could not be located at all', () => {
    const verdict = replace();
    expect(
      semanticUpdateFrom({
        evidence: EVIDENCE,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        verdict: { ...verdict, authorised: { ...verdict.authorised, earlier: null } },
      }),
    ).toBeNull();
  });

  it('refuses two values on one instant, which is a contradiction and not an update', () => {
    const verdict = replace();
    expect(
      semanticUpdateFrom({
        evidence: EVIDENCE,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        // `deriveSupersedes` refuses to order these and `revision.ts` reports a refuted `uniqueness`; a module
        // that built a unit here would be picking a winner by id on the caller's behalf.
        verdict: {
          ...verdict,
          authorised: {
            later: { text: LATE_RECORD, date: '2023/03/12 (Sun) 11:40', at: EARLY_AT },
            earlier: verdict.authorised.earlier,
          },
        },
      }),
    ).toBeNull();
  });

  it('refuses a newer record that is not later, because the ordering check is upstream and this is the guard', () => {
    const verdict = replace();
    expect(
      semanticUpdateFrom({
        evidence: EVIDENCE,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        verdict: {
          ...verdict,
          authorised: {
            later: { text: LATE_RECORD, date: '2023/03/12 (Sun) 11:40', at: EARLY_AT - 1 },
            earlier: verdict.authorised.earlier,
          },
        },
      }),
    ).toBeNull();
  });

  it('refuses a record whose content is only a dateline, because nothing could ever anchor on it', () => {
    const verdict = replace();
    const headerOnly = '[2023/03/12 (Sun) 11:40] user: ';
    expect(
      semanticUpdateFrom({
        evidence: `${EARLY_RECORD}\n\n2. ${headerOnly}`,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        verdict: {
          ...verdict,
          authorised: {
            later: { text: headerOnly, date: '2023/03/12 (Sun) 11:40', at: LATE_AT },
            earlier: verdict.authorised.earlier,
          },
        },
      }),
    ).toBeNull();
  });

  it('refuses an empty question, because the slot would be the same slot for every question', () => {
    expect(build({ question: '   ' })).toBeNull();
  });
});

describe('when an update is about a window', () => {
  const update = build()!;

  it('applies when the window still carries the record it was authorised by', () => {
    expect(updateAppliesTo(update, [EARLY, LATE])).toBe(true);
  });

  it('does not apply to a window that carries neither, which is what keeps a benchmark from leaking across questions', () => {
    expect(updateAppliesTo(update, ['[2023/04/01 (Sat) 08:00] user: I bought a bicycle.'])).toBe(
      false,
    );
  });

  it('does not apply to a window that carries only the older record', () => {
    // The value the update is about is not in this window. Saying "the newer one is 30 dozen" beside evidence
    // that never mentions it would be the store answering from a window it was not given.
    expect(updateAppliesTo(update, [EARLY])).toBe(false);
  });
});

describe('the pairs whose unit the kernel refuses, and why this module reports them as no update', () => {
  it('refuses a record with no header at all, because there is no sentence boundary to find', () => {
    // `anchorOf`'s `match === null` branch: a record rendered without the `[date] speaker:` header. The
    // adjudicator never produces one — its own split requires the bracket — so this is the guard against a
    // caller handing this module a record from somewhere else.
    const verdict = replace();
    expect(
      semanticUpdateFrom({
        evidence: EVIDENCE,
        frameId: 'f',
        question: 'q',
        first: '20 dozen',
        verdict: {
          ...verdict,
          authorised: {
            later: { text: 'no header at all', date: '2023/03/12 (Sun) 11:40', at: LATE_AT },
            earlier: verdict.authorised.earlier,
          },
        },
      }),
    ).toBeNull();
  });

  it('refuses a pair whose two texts fold to the same string, because a restatement is not an update', () => {
    // `agrees` refuses this one layer up; a module that built a unit anyway would call `deriveSupersedes` with
    // two identical texts and get no edge, and a unit with no edge renders two facts and no relation — the
    // shape a reader cannot order.
    expect(build({ first: '30 dozen' })).toBeNull();
  });

  it('refuses a pair the kernel will not ground, rather than storing a fact the evidence does not carry', () => {
    // `buildKnowledgeUnit` refuses a fact whose words are not in the frame. This is the branch that keeps a
    // composed answer — one the reader wrote rather than copied — from becoming a stored claim: `locate`
    // returns the whole frame for it, and grounding is what notices that the words are not there.
    expect(build({ first: 'a figure the evidence never states' })).toBeNull();
  });
});

describe('the ledger, because an edge is not a refutation', () => {
  /** The fact the block must serve, and the one it must not. */
  function pair(update: SemanticUpdate): { current: KnowledgeFact; stale: KnowledgeFact } {
    const byId = new Map(update.unit.facts.map((fact) => [fact.id, fact]));
    return {
      current: byId.get(update.factIds[0]!)!,
      stale: byId.get(update.factIds[1]!)!,
    };
  }

  it('derives a ledger for both facts, so there is something for a revision to write on', () => {
    // This is the defect that made the rest of the wiring pointless for one round. `deriveSupersedes` produced
    // the edge, `renderBlocks` drew it, and both facts went into the block with no assumptions at all — so
    // `reviseLedger`'s `apply` found no `persistence` to rewrite, returned each fact untouched, and the block
    // served the superseded value on its own `fact:` line. The mechanism was imported, called, and inert.
    const { current, stale } = pair(build()!);
    for (const fact of [current, stale]) {
      expect(fact.assumptions?.map((assumption) => assumption.kind)).toEqual([
        'persistence',
        'uniqueness',
      ]);
    }
  });

  it('opens both ledgers at the instant the substitution was authorised, not at the epoch', () => {
    // `deriveAssumptions` opens every assumption at `frame.at ?? 0`. With no `frame.at` each one opened at the
    // epoch, so `assumptionPenalty` read a 2023 statement against a 2026 clock and reported `aged` for every
    // unit this module can build — invisible, because `penalty.reason` is not rendered, which is precisely why
    // it is asserted here rather than left to an artifact. Both facts entered one ledger at one moment: the
    // later record's.
    const update = build()!;
    const { current, stale } = pair(update);
    expect(update.unit.frame.at).toBe(LATE_AT);
    expect(update.learnedAt).toBe(LATE_AT);
    for (const fact of [current, stale]) {
      for (const assumption of fact.assumptions ?? []) expect(assumption.openedAt).toBe(LATE_AT);
    }
  });

  it('refutes the value that was replaced and confirms the one that replaced it', () => {
    // `revision.ts`'s own header states the failure this asserts against: *a system where an edge says "B
    // replaced A" while A's persistence says "still open" contradicts itself in a way no reader can resolve.*
    // The ledger is the half that resolves it, and until E2 nothing ran it.
    const { current, stale } = pair(build()!);
    const persistence = (fact: KnowledgeFact) =>
      fact.assumptions?.find((assumption) => assumption.kind === 'persistence');
    expect(persistence(stale)).toMatchObject({ status: 'refuted', contradict: 1, support: 0 });
    expect(persistence(current)).toMatchObject({ status: 'confirmed', support: 1, contradict: 0 });
  });

  it('serves one fact and withholds one, and the ratio is the instrument', async () => {
    // `served` alone cannot fail: a block that printed both ends would report `served: 2` and look healthier
    // than a correct one. `withheld` is the number that goes to zero when the revision stops writing, which is
    // the exact state the path was in before this round.
    const block = assembleSemanticUpdate(build()!);
    expect(block.served).toBe(1);
    expect(block.withheld).toBe(1);
    const text = block.lines.join('\n');
    expect(text).toContain('fact:     30 dozen  [state]');
    expect(text).toContain('status:   replaces "20 dozen"');
    expect(text).not.toContain('fact:     20 dozen');
    // The ledger is stated, not merely applied: a reader is told the surviving value's persistence was
    // confirmed by the replacement rather than left open.
    expect(text).toContain('assumed:  confirmed');
  });

  it('omits the frame, because the frame here is the whole rendered window', () => {
    // `assemble` renders through `renderBlocks`, which states the frame by default. This caller's frame is the
    // entire evidence, which the prompt already carries verbatim above the block — so the default would spend
    // the evidence budget printing a copy of the evidence.
    expect(assembleSemanticUpdate(build()!).lines.join('\n')).not.toContain('frame:');
  });
});
