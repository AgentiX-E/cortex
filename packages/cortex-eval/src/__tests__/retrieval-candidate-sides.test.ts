/**
 * Tests for `retrievalCandidateSides`: the non-oracle side derivation.
 *
 * Why this exists
 * ---------------
 * B7's annotation producer needs TWO sides to label candidates, and the memory
 * system never receives the ground truth (docs §14.5). The question-only path
 * that `candidateSides` already has cannot substitute: measured, it returns ONE
 * side with the candidates merged, and `discriminateContext` refuses to annotate
 * with fewer than two. So "supply no truth" was not a weaker path but an inert
 * one (docs §16.4).
 *
 * `retrievalCandidateSides` is the third channel: both sides come from what the
 * system already has at inference time -- the retrieved turns and the answer the
 * baseline arm produced. Neither is truth, so an A/B run this way measures a
 * deployable system rather than one with the answer supplied.
 *
 * The property these tests pin
 * ----------------------------
 * The one that matters is the CONTRAST: given input where the question-only path
 * yields a single side, this function must yield two. A test suite that only
 * asserted "returns some sides" would pass on an implementation that is really
 * `candidateSides` with a new name -- inert in exactly the same way, and
 * indistinguishable from the outside. The contrast test is therefore first.
 *
 * The second property is that it never reads `groundTruth`. That cannot be
 * asserted by output alone, because an implementation could consult truth and
 * produce a correct-looking result; it is asserted by the function's signature,
 * which takes no truth parameter at all, plus a test that the same input with a
 * truth-shaped extra field present produces the same output.
 */
import { describe, expect, it } from 'vitest';

import {
  candidateSides,
  contentTerms,
  discriminateContext,
  retrievalCandidateSides,
  type TurnLike,
} from '../candidate-context.js';

const DATE = '2023/06/02';

/** A dated turn in the shape the module parses. */
function turn(role: 'user' | 'assistant', content: string, index: number, date = DATE): TurnLike {
  return { index, text: `[${date}] ${role}: ${content}` };
}

/**
 * The fixture the channel-B null result was measured on, in the same shape.
 *
 * A two-candidate question, with both candidates present in the retrieved turns
 * so that a real divergence exists to find. If the sides cannot be separated
 * here, they cannot be separated anywhere.
 */
function twoCandidateRetrieval(): {
  question: string;
  retrieved: TurnLike[];
  answer: string;
} {
  return {
    question: 'Which bike did I ride to the coast, the cargo bike or the racing bike?',
    retrieved: [
      turn('user', 'I took the cargo bike to the coast last week.', 0),
      turn('user', 'The racing bike stayed in the garage that whole month.', 1),
      turn('user', 'I rode the racing bike to the coast for the race.', 2),
      turn('assistant', 'That sounds like a memorable trip.', 3),
    ],
    answer: 'the racing bike',
  };
}

describe('the channel C contrast: two sides where the question-only path yields one', () => {
  it('THE REGRESSION TEST: yields >= 2 sides where candidateSides yields exactly 1', () => {
    // This is the whole point of the function. Channel B (question only) returns
    // one merged side, so `discriminateContext` declines to annotate and the
    // feature is inert. If this test passes, channel C is a different animal; if
    // it fails, channel C is channel B renamed and the design (docs §16) is
    // falsified.
    const { question, retrieved, answer } = twoCandidateRetrieval();

    // The baseline: the existing non-oracle fallback, measured to produce one.
    const questionOnly = candidateSides({ question });
    expect(questionOnly.length).toBe(1);

    // Channel C: must do better on the same input, or it is not a new channel.
    const fromRetrieval = retrievalCandidateSides({ question, retrieved, answer });
    expect(fromRetrieval.length).toBeGreaterThanOrEqual(2);
  });

  it('makes discriminateContext annotate, where the question-only path cannot', () => {
    // The contrast expressed at the level that matters -- whether the feature
    // actually produces labels. `annotated: false` here would mean the new sides
    // are well-formed but useless, which the count assertion above cannot catch.
    const { question, retrieved, answer } = twoCandidateRetrieval();

    const viaQuestionOnly = discriminateContext(retrieved, { question });
    expect(viaQuestionOnly.annotated).toBe(false);

    const viaRetrieval = discriminateContext(retrieved, {
      question,
      sidesOverride: retrievalCandidateSides({ question, retrieved, answer }),
    });
    expect(viaRetrieval.annotated).toBe(true);
    expect(viaRetrieval.clusters.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the sides carry a discriminator each, and are drawn from the retrieval', () => {
  // A side is `[modifier, head]`, and the HEAD IS INTENTIONALLY SHARED: the two
  // candidates are alternatives for one slot, so they agree on the word naming
  // the slot ("bike") and differ on the word identifying the alternative
  // ("cargo" / "racing"). `distinguishingTokens` makes the same decision in the
  // measurement layer -- it subtracts shared tokens to FIND the discriminators,
  // and the pair it then tests for containment still contains the shared head.
  //
  // What must hold instead is that each side contains a token the other side
  // does not, because a pair that shares every token is one candidate written
  // twice: it would place a turn on both sides, `sideForTurn` would return -1,
  // and every turn would be dropped from every cluster.

  it('gives each competing side a term the other side does not have', () => {
    const { question, retrieved, answer } = twoCandidateRetrieval();
    const sides = retrievalCandidateSides({ question, retrieved, answer });
    expect(sides.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < sides.length; i += 1) {
      for (let j = 0; j < sides.length; j += 1) {
        if (i === j) continue;
        const onlySomething = sides[i]!.some((term) => !sides[j]!.includes(term));
        expect(onlySomething).toBe(true);
      }
    }
  });

  it('reads the modifiers out of the turns, not out of the question', () => {
    // The original implementation clustered on the question's framing terms and
    // annotated zero of 17 real questions. The assertion is deliberately about
    // the modifier, not every term: the head is shared between the two sides, so
    // it cannot be evidence for either one.
    const { question, retrieved, answer } = twoCandidateRetrieval();
    const sides = retrievalCandidateSides({ question, retrieved, answer });
    expect(sides.map((side) => side[0])).toEqual(['cargo', 'racing']);
    const turnText = retrieved.map((t) => t.text.toLowerCase()).join(' ');
    for (const side of sides) {
      const modifier = side[0]!;
      expect(turnText).toContain(modifier);
    }
  });

  it('never returns the answer as its own side, because the answer is one candidate', () => {
    // The `answer` is the baseline arm's output. It is available at inference
    // time so using it is not oracle-assisted, but it must be placed ON one side
    // of the competition rather than forming a side of its own -- an answer-only
    // side would claim a competition where there is none, since the value that
    // already exists is not an alternative to itself.
    //
    // Measured: `answer` is 'the racing bike' and the sides are
    // [["cargo","bike"], ["racing","bike"]]. `racing` is the answer's modifier
    // and appears exactly once in the sides, alongside the shared head -- which
    // is the whole competition, not an answer-only side.
    const { question, retrieved, answer } = twoCandidateRetrieval();
    const sides = retrievalCandidateSides({ question, retrieved, answer });
    const answerTerms = new Set(contentTerms(answer));
    const answerModifier = [...answerTerms].filter((term) =>
      sides.some((side) => side.includes(term)),
    );
    // 'the racing bike' carries no content word belonging to the competition
    // beyond its own modifier and the shared head.
    expect(answerModifier.sort()).toEqual(['bike', 'racing']);
    // The answer must not become a THIRD side of its own, which would claim a
    // competition the retrieval does not contain.
    expect(sides.length).toBeLessThanOrEqual(2);
  });
});

describe('more than two alternatives are narrowed to the pair the system committed to', () => {
  /**
   * A retrieval naming THREE alternatives for one slot. `discriminateContext`
   * labels a binary choice, so a third side would make every label ambiguous;
   * the answer is what tells the function which two matter.
   */
  function threeCandidateRetrieval(): { question: string; retrieved: TurnLike[] } {
    return {
      question: 'Which bike did I ride to the coast, the cargo, racing or touring bike?',
      retrieved: [
        turn('user', 'I took the cargo bike to the coast last week.', 0),
        turn('user', 'The racing bike stayed in the garage that whole month.', 1),
        turn('user', 'I rode the racing bike to the coast for the race.', 2),
        turn('user', 'The touring bike is the newest of the three.', 3),
      ],
    };
  }

  it('keeps the alternative the answer names plus one other, not the first two', () => {
    // `touring` is alphabetically LAST and appears once. A picker that ignored
    // the answer would return cargo and racing, discarding the one alternative
    // the system actually chose -- and the clustering would then label turns for
    // a candidate the arm never produced.
    const { question, retrieved } = threeCandidateRetrieval();
    const sides = retrievalCandidateSides({ question, retrieved, answer: 'the touring bike' });
    expect(sides).toHaveLength(2);
    expect(sides.map((side) => side[0])).toContain('touring');
    expect(sides.map((side) => side[1])).toEqual(['bike', 'bike']);
  });

  it('falls back to the first two by modifier when the answer names no alternative', () => {
    // The system answered something outside the competition ("my new bike"),
    // so it points at none of the three. Taking the first two by modifier is the
    // only deterministic choice left, and determinism is required: an A/B run
    // that reorders its sides between runs cannot be bisected.
    const { question, retrieved } = threeCandidateRetrieval();
    const sides = retrievalCandidateSides({ question, retrieved, answer: 'my new bike' });
    expect(sides).toHaveLength(2);
    expect(sides.map((side) => side[0])).toEqual(['cargo', 'racing']);
  });

  it('pairs the named alternative with a real other, not with itself', () => {
    // The mirror of the first case: the answer picks the survivor, and the
    // "other" it is paired with must be a real alternative. This is the arm where
    // the pair is not the first two, so it also pins that the search for the
    // partner cannot return the winner.
    const { question, retrieved } = threeCandidateRetrieval();
    const sides = retrievalCandidateSides({ question, retrieved, answer: 'the racing bike' });
    expect(sides).toHaveLength(2);
    expect(sides.map((side) => side[0]).sort()).toEqual(['cargo', 'racing']);
  });

  it('declines to be guided when the answer names more than one alternative', () => {
    // A hedged answer naming two of the three alternatives is not a commitment,
    // so it must not be treated as one. Measured: with the answer
    // 'racing and touring bike' the result is [cargo, racing] -- the answer's
    // mention of `touring` is ignored and the alphabetical pair stands.
    //
    // The tempting simplification is `mentioned.length >= 1`, which lets a
    // partial mention steer the choice. It returns [racing, cargo] here: the
    // answer's FIRST-listed alternative wins the survivor slot, so which two
    // sides come back depends on the ORDER OF A HEDGE rather than on evidence.
    const retrieved = [
      turn('user', 'I rode the cargo bike to the coast.', 0),
      turn('user', 'The racing bike stayed in the garage.', 1),
      turn('user', 'I rode the racing bike to the coast for the race.', 2),
      turn('user', 'The touring bike is the newest of the three.', 3),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which bike did I ride?',
      retrieved,
      answer: 'racing and touring bike',
    });
    expect(sides.map((side) => side[0])).toEqual(['cargo', 'racing']);
  });

  it('still takes its cue from an answer that names exactly one alternative', () => {
    // The complement: a commitment IS a decision, and it decides which two
    // survive. Without this the test above would also pass on an implementation
    // that ignored the answer altogether.
    const retrieved = [
      turn('user', 'I rode the cargo bike to the coast.', 0),
      turn('user', 'The racing bike stayed in the garage.', 1),
      turn('user', 'I rode the racing bike to the coast for the race.', 2),
      turn('user', 'The touring bike is the newest of the three.', 3),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which bike did I ride?',
      retrieved,
      answer: 'touring bike',
    });
    expect(sides.map((side) => side[0])).toContain('touring');
  });
});

describe('two equally competitive slots are resolved deterministically', () => {
  it('breaks a tie on the slot name, so the choice is not iteration order', () => {
    // Both `bike` and `car` hold exactly two alternatives, so neither wins on
    // count. The tie-break must be on the head word: `Map` iteration order is
    // insertion order, which follows the order the spans happened to be
    // discovered, and a sides list that depended on that would change when the
    // retriever reordered its turns.
    const retrieved = [
      turn('user', 'I rode the cargo bike to the coast.', 0),
      turn('user', 'I rode the cargo bike again on Sunday.', 1),
      turn('user', 'The racing bike stayed in the garage.', 2),
      turn('user', 'The blue car needed a service.', 3),
      turn('user', 'The blue car was serviced in June.', 4),
      turn('user', 'The red car was in the shop.', 5),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which did I take?',
      retrieved,
      answer: 'the racing bike',
    });
    // 'bike' sorts before 'car', so the bike slot wins regardless of the order
    // the turns arrived in.
    expect(sides.map((side) => side[1])).toEqual(['bike', 'bike']);

    const reversed = [...retrieved].reverse();
    const fromReversed = retrievalCandidateSides({
      question: 'Which did I take?',
      retrieved: reversed,
      answer: 'the racing bike',
    });
    expect(fromReversed).toEqual(sides);
  });
});

describe('a slot must be established by the retrieval before its modifiers compete', () => {
  it('declines when both alternatives are named in a single turn, even with a trailing word', () => {
    // The shape that produced channel B's five-word merge: one sentence naming
    // two values. A slot is something the retrieval RETURNS TO, and one turn
    // cannot show a return -- so this is two values in a sentence, not two
    // candidates in a context.
    //
    // The trailing word matters. Without it, `racing` would be the turn's LAST
    // content token, so `racing bike` would never form as a span (`i + 1` runs
    // off the end) and the case would be declined by the span loop rather than by
    // the recurrence requirement -- the guard would look load-bearing while
    // being unreachable. Measured: with the trailing word present, removing the
    // recurrence requirement yields `[["cargo","bike"]]`, a ONE-SIDE result,
    // which breaks the contract the next test states.
    const retrieved = [turn('user', 'The cargo bike and the racing bike both work fine.', 0)];
    expect(
      retrievalCandidateSides({ question: 'Which bike?', retrieved, answer: 'the cargo bike' }),
    ).toEqual([]);
  });

  it('declines when one modifier is repeated, because one value is not a competition', () => {
    // Recursion alone is not a competition: the slot must hold at least TWO
    // DISTINCT modifiers. `cargo bike` twice is one candidate mentioned twice,
    // and reporting it as a pair would invite the reader to choose between a
    // value and itself.
    const retrieved = [
      turn('user', 'I took the cargo bike to the coast.', 0),
      turn('user', 'The cargo bike needed a new chain.', 1),
    ];
    expect(
      retrievalCandidateSides({ question: 'Which bike?', retrieved, answer: 'the cargo bike' }),
    ).toEqual([]);
  });

  it('accepts two alternatives named once each, which is a real competition', () => {
    // The complement, and the case I initially got wrong in the other direction.
    // Two turns naming two different alternatives IS the retrieval raising a
    // choice -- it is the same fixture shape the channel-B measurement was taken
    // on. Requiring a modifier to RECUR would discard it, which is the original
    // bug; the requirement is that the retrieval names more than one thing that
    // fills the slot, and these two turns do.
    const retrieved = [
      turn('user', 'I took the cargo bike to the coast.', 0),
      turn('user', 'The racing bike was in the garage.', 1),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which bike did I take to the coast?',
      retrieved,
      answer: 'the cargo bike',
    });
    expect(sides.map((side) => side[0])).toEqual(['cargo', 'racing']);
  });
});

describe('the contested slot is the one with the most alternatives', () => {
  it('prefers the slot several alternatives compete for over a two-alternative one', () => {
    // A retriever that mentions both bikes and both cars. The bike slot holds
    // THREE modifiers and the car slot two, so the question the retrieval is
    // actually raising is the three-way one. Preferring the slot with FEWER
    // alternatives resolves the question against whichever choice is least
    // contested, which is the opposite of what the pairs are for.
    const retrieved = [
      turn('user', 'I rode the cargo bike to the coast.', 0),
      turn('user', 'The racing bike stayed in the garage.', 1),
      turn('user', 'The touring bike is my newest one.', 2),
      turn('user', 'The blue car needed a service.', 3),
      turn('user', 'The blue car was serviced in June.', 4),
      turn('user', 'The red car was in the shop.', 5),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which did I take?',
      retrieved,
      answer: 'the racing bike',
    });
    // Every side is drawn from the three-way bike slot, not the two-way car one.
    expect(sides.map((side) => side[1])).toEqual(['bike', 'bike']);
    expect(sides.map((side) => side[0])).toContain('racing');
  });
});

describe('a non-empty result always carries a full pair', () => {
  it('returns either zero sides or at least two, never exactly one', () => {
    // The contract `discriminateContext` depends on: fewer than two sides means
    // no competition. A one-side result is the worst of both worlds -- the caller
    // sees a non-empty answer, treats it as a competition, and clusters every
    // turn that mentions a single value as if it discriminated.
    //
    // Swept over retrieval shapes rather than asserted on one, because the
    // condition is about the RANGE of the function, not a case.
    const shapes: TurnLike[][] = [
      [],
      [turn('user', 'ok', 0)],
      [turn('user', 'I took the cargo bike to the coast.', 0)],
      [
        turn('user', 'I took the cargo bike to the coast.', 0),
        turn('user', 'The racing bike was there.', 1),
      ],
      twoCandidateRetrieval().retrieved,
      [turn('assistant', 'The cargo bike sounds lovely.', 0)],
    ];
    for (const retrieved of shapes) {
      const sides = retrievalCandidateSides({
        question: 'Which bike did I take?',
        retrieved,
        answer: 'the cargo bike',
      });
      expect(sides.length === 0 || sides.length >= 2).toBe(true);
    }
  });
});

describe('degenerate input is declined rather than guessed', () => {
  it('returns no sides when there is nothing retrieved', () => {
    // An empty context has no divergence to find. Returning one side here would
    // let `discriminateContext` label nothing anyway, but returning a MALFORMED
    // pair would assert a competition that does not exist.
    expect(
      retrievalCandidateSides({ question: 'Which bike?', retrieved: [], answer: 'the bike' }),
    ).toEqual([]);
  });

  it('returns no sides when only one candidate is present in the retrieval', () => {
    // One candidate is not a competition. The honest answer is to decline, the
    // same decision `discriminateContext` makes for fewer than two sides.
    const retrieved = [
      turn('user', 'I took the cargo bike to the coast.', 0),
      turn('user', 'The cargo bike needed a new chain.', 1),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which bike did I ride to the coast?',
      retrieved,
      answer: 'the cargo bike',
    });
    expect(sides.length).toBeLessThan(2);
  });

  it('returns no sides when the retrieval contains no content terms at all', () => {
    const retrieved = [turn('user', 'ok', 0), turn('user', 'yes', 1)];
    expect(
      retrievalCandidateSides({ question: 'What?', retrieved, answer: 'ok' }).length,
    ).toBeLessThan(2);
  });

  it("ignores assistant turns, which carry the reader's voice not the user's facts", () => {
    // `sideForTurn` already refuses assistant turns, so a side made only of
    // assistant vocabulary would parse to nothing and produce a cluster with no
    // turns. Excluding them here keeps the sides and the clustering consistent.
    const retrieved = [
      turn('assistant', 'The cargo bike sounds lovely.', 0),
      turn('assistant', 'The racing bike is faster.', 1),
    ];
    const sides = retrievalCandidateSides({
      question: 'Which bike did I ride?',
      retrieved,
      answer: 'the cargo bike',
    });
    expect(sides.length).toBeLessThan(2);
  });
});

describe('determinism and stability', () => {
  it('returns the same sides for the same input, across calls', () => {
    // Sides that reorder between runs would make an A/B non-reproducible and a
    // failure impossible to bisect.
    const { question, retrieved, answer } = twoCandidateRetrieval();
    const first = retrievalCandidateSides({ question, retrieved, answer });
    const second = retrievalCandidateSides({ question, retrieved, answer });
    expect(second).toEqual(first);
  });

  it('is insensitive to the order of the retrieved turns', () => {
    // Retrieval order is a property of the retriever, not of the candidates. If
    // the sides depended on it, the same question could score differently
    // depending on a ranking change B7 has nothing to do with.
    const { question, retrieved, answer } = twoCandidateRetrieval();
    const shuffled = [retrieved[2], retrieved[0], retrieved[3], retrieved[1]] as TurnLike[];
    const baseline = retrievalCandidateSides({ question, retrieved, answer });
    const reordered = retrievalCandidateSides({ question, retrieved: shuffled, answer });
    // Compare as sets of terms: identity of the sides, not their order.
    const normalize = (sides: readonly (readonly string[])[]) =>
      sides.map((side) => [...side].sort().join('|')).sort();
    expect(normalize(reordered)).toEqual(normalize(baseline));
  });

  it('produces no duplicate terms inside a side', () => {
    const { question, retrieved, answer } = twoCandidateRetrieval();
    for (const side of retrievalCandidateSides({ question, retrieved, answer })) {
      expect(new Set(side).size).toBe(side.length);
    }
  });
});

describe('the function is structurally non-oracle', () => {
  it('takes no ground-truth parameter, so it cannot consult one', () => {
    // Asserted through the signature rather than the output: an implementation
    // could read a truth value and produce a correct-looking result, so no output
    // assertion can prove absence. The parameter list is the proof.
    const { question, retrieved, answer } = twoCandidateRetrieval();
    const extra = { question, retrieved, answer, groundTruth: 'the cargo bike' };
    const withTruth = retrievalCandidateSides(extra);
    const withoutTruth = retrievalCandidateSides({ question, retrieved, answer });
    // A truth field smuggled in changes nothing, because none is read.
    expect(withTruth).toEqual(withoutTruth);
  });
});
