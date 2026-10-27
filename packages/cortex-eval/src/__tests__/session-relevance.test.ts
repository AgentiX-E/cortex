/**
 * A session scored as one unit, projected onto the turns it contains.
 *
 * ## The operation this exists for, and why it is not `relevanceUnits: session`
 *
 * `relevanceUnits: session` ranks **turns** and then takes the largest prefix of whole sessions
 * that fits. The reference pipeline does something else: it scores a **session** — its concatenated
 * text, one embedding — and takes the top-k sessions. The two share a name and they are different
 * operations, and run `39699987781` measured the first one losing 11 questions against the turn unit
 * (`MEASURE-MR-UNITS.md` §2). The second was never expressible here because
 * `relevanceFor(question, turn)` is scored per turn.
 *
 * ## Why projection and not a new option on the budget
 *
 * A session score projected onto every turn of that session makes the existing "rank sessions by
 * their best-scoring turn" rule **be** session ranking, with the budget code untouched. That matters
 * beyond convenience: `PREREG-MR-SESSION-CHANNEL.md` is a single-variable registration, and a version
 * that also rewrote the selection would move two things at once.
 *
 * The cost is that a score is now constant within a session. That is exactly wrong for a question
 * whose answer is one turn of one session, which is why the signal is route-scoped to
 * `multi-session` and every other route keeps the turn-scored index byte-identical.
 *
 * ## What each assertion below protects
 *
 * The first is the control (a round trip that works). The second is the mechanism: two turns of one
 * session must be **equal**, because that equality is what makes the existing budget rank sessions.
 * The rest are the ways a case can be malformed, each refused rather than defaulted — a silent
 * fallback would produce an artifact that says `retrieval-session` while grading with the turn index.
 */
import { describe, it, expect } from 'vitest';
import { buildSessionRelevanceIndex } from '../session-relevance.js';
import { tableEmbedding } from './test-embedding.js';

/**
 * Two sessions, the first on-topic and the second not, with a query that points at the first.
 *
 * The vectors are exact rather than approximate: `tableEmbedding` reads from this table and embeds
 * anything absent to the zero vector, so cosines are 1 and 0 and nothing in between is a rounding
 * artefact.
 */
const QUESTION = 'how many projects have I led';
const SESSION_TEXT = {
  /** The on-topic session, as the index joins it. */
  onTopic: 'user: I led the migration project\nuser: and the billing one',
  offTopic: 'user: my sourdough starter is finally active',
};

function embedding() {
  return tableEmbedding(
    {
      [QUESTION]: [1, 0],
      [SESSION_TEXT.onTopic]: [1, 0],
      [SESSION_TEXT.offTopic]: [0, 1],
    },
    2,
  );
}

function cases() {
  return [
    {
      question: QUESTION,
      context: [
        'user: I led the migration project',
        'user: and the billing one',
        SESSION_TEXT.offTopic,
      ],
      sessions: [
        ['user: I led the migration project', 'user: and the billing one'],
        [SESSION_TEXT.offTopic],
      ],
    },
  ];
}

describe('a session score is constant across its own turns', () => {
  it('control: an on-topic session scores 1 and an off-topic one scores 0', async () => {
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 2 });
    expect(index.questions).toBe(1);
    expect(index.topK).toBe(2);
    const onTopic = index.relevanceFor(QUESTION, 'user: I led the migration project');
    const offTopic = index.relevanceFor(QUESTION, SESSION_TEXT.offTopic);
    expect(onTopic).toBeCloseTo(1, 6);
    expect(offTopic).toBeCloseTo(0, 6);
  });

  it('gives every turn of one session the identical score, which is the mechanism', async () => {
    // Not "close to": identical. `relevanceUnits: session` ranks a session by its best-scoring
    // turn, so if the two turns differed by even a rounding step the ranking would be decided by
    // which turn happened to win a comparison the session score already settled.
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 2 });
    expect(index.relevanceFor(QUESTION, 'user: I led the migration project')).toBe(
      index.relevanceFor(QUESTION, 'user: and the billing one'),
    );
  });

  it('counts scored pairs as turns, not sessions, because the budget spends turns', async () => {
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 2 });
    // Two turns in the on-topic session, one in the other.
    expect(index.scoredPairs).toBe(3);
  });
});

describe('the top-k is measured in sessions here, not turns', () => {
  it('at topK=1 keeps the on-topic session whole and drops the other entirely', async () => {
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 1 });
    expect(index.candidatesFor(QUESTION).size).toBe(2);
    expect(index.candidatesFor(QUESTION).has(SESSION_TEXT.offTopic)).toBe(false);
    // A turn the index did not score answers with the floor rather than throwing -- the same
    // contract `relevance-index.ts` already documents, and the selection ranks every admitted turn.
    expect(index.relevanceFor(QUESTION, SESSION_TEXT.offTopic)).toBeLessThan(0);
  });

  it('returns the ranked order best-first, sessions grouped', async () => {
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 2 });
    const ranked = index.rankedCandidatesFor(QUESTION);
    expect(ranked).toHaveLength(3);
    expect(ranked[2]).toBe(SESSION_TEXT.offTopic);
  });
});

describe('a malformed case is refused rather than defaulted', () => {
  it('refuses a case with no `sessions`, because the turn index is not a substitute', async () => {
    // The failure this prevents: a caller that built cases the old way gets an artifact line saying
    // `retrieval-session` while the scores came from turn similarity. That reads as evidence the
    // session channel does nothing.
    // Cast rather than typed: `SessionRelevanceCase.sessions` is required, so a TypeScript caller
    // cannot omit it and this branch exists for the callers the type does not see — a JS caller,
    // and a case deserialised from an artifact written before the field existed. Asserting it here
    // is what turns "the type saves us" into "the runtime also refuses".
    const bad = [{ question: QUESTION, context: ['a', 'b'] }] as unknown as readonly {
      readonly question: string;
      readonly context: readonly string[];
      readonly sessions: readonly (readonly string[])[];
    }[];
    await expect(buildSessionRelevanceIndex(embedding(), bad, { topK: 2 })).rejects.toThrow(
      /sessions/i,
    );
  });

  it('refuses when `sessions.flat()` disagrees with `context`', async () => {
    await expect(
      buildSessionRelevanceIndex(
        embedding(),
        [
          {
            question: QUESTION,
            context: ['user: I led the migration project', 'user: and the billing one'],
            sessions: [['user: I led the migration project']],
          },
        ],
        { topK: 2 },
      ),
    ).rejects.toThrow(/flat|context/i);
  });

  it('refuses when the flatten has the right length but the wrong turns', async () => {
    // The length check above catches a case that lost or gained a turn. This one catches a case whose
    // turn count is right and whose **contents** are not -- a caller that reordered sessions, or
    // rebuilt the flat list from a different render. Without it the index would score one body of
    // text and project the score onto another, and every downstream count would look healthy.
    await expect(
      buildSessionRelevanceIndex(
        embedding(),
        [
          {
            question: QUESTION,
            context: ['user: I led the migration project', 'user: and the billing one'],
            sessions: [['user: and the billing one', 'user: I led the migration project']],
          },
        ],
        { topK: 2 },
      ),
    ).rejects.toThrow(/differs at turn/i);
  });

  it('refuses a case with an empty session list rather than scoring nothing', async () => {
    await expect(
      buildSessionRelevanceIndex(embedding(), [{ question: QUESTION, context: [], sessions: [] }], {
        topK: 2,
      }),
    ).rejects.toThrow(/session/i);
  });

  it('refuses a topK below 1, which would rank no session at all', async () => {
    await expect(buildSessionRelevanceIndex(embedding(), cases(), { topK: 0 })).rejects.toThrow(
      /topK/i,
    );
  });
});

describe('a turn text appearing in two sessions resolves deterministically', () => {
  it('takes the score of the highest-ranked session that contains it', async () => {
    // `relevanceFor` is keyed by turn TEXT, and the same text can sit in two sessions whose
    // *joined* texts differ -- so the two occurrences carry different scores even though the turn's
    // own vector is one value. Here the duplicate is alone in the first session (joined text
    // `shared`, off-topic, score 0) and shares the second with another turn (joined text
    // `shared\nx`, on-topic, score 1).
    //
    // The winner is the **higher-ranked** session, not the earlier one, and that is the semantics
    // the projection promises: a turn's score is "how relevant is the session that best represents
    // it", and a session that ranks first represents everything it holds. Position would say the
    // opposite -- that whichever copy happened to appear first wins, including a worse one.
    //
    // The choice is deterministic rather than incidental: sessions are sorted by score with the
    // session's position as the tie-break, so two runs holding the same cases score the same turn
    // the same way. An index that left this to `Map` insertion order would be discovered by
    // comparing two runs that were supposed to be identical.
    const shared = 'the shared turn';
    const index = await buildSessionRelevanceIndex(
      tableEmbedding(
        {
          [QUESTION]: [1, 0],
          [shared]: [0, 1],
          [`${shared}\nx`]: [1, 0],
        },
        2,
      ),
      [
        {
          question: QUESTION,
          context: [shared, shared, 'x'],
          sessions: [[shared], [shared, 'x']],
        },
      ],
      { topK: 2 },
    );
    expect(index.relevanceFor(QUESTION, shared)).toBeCloseTo(1, 6);
  });
});

describe('an empty session contributes nothing and does not throw', () => {
  it('skips it while scoring the others', async () => {
    const index = await buildSessionRelevanceIndex(
      embedding(),
      [
        {
          question: QUESTION,
          context: [SESSION_TEXT.onTopic],
          sessions: [[], [SESSION_TEXT.onTopic]],
        },
      ],
      { topK: 2 },
    );
    expect(index.relevanceFor(QUESTION, SESSION_TEXT.onTopic)).toBeCloseTo(1, 6);
    expect(index.scoredPairs).toBe(1);
  });
});

describe('the contract the selection relies on: total, never throwing', () => {
  it('answers with a floor for a question the index never scored', async () => {
    // `CortexMemory` ranks every admitted turn, most of which a top-k index does not hold, so a miss
    // is a value rather than an error. The same contract `relevance-index.ts` documents, and the two
    // modules have to agree on it or the selection's fallback would differ by which signal ran.
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 2 });
    expect(index.relevanceFor('a question nobody asked', 'user: I led the migration project')).toBe(
      -2,
    );
    expect(index.candidatesFor('a question nobody asked').size).toBe(0);
    expect(index.rankedCandidatesFor('a question nobody asked')).toEqual([]);
  });

  it('answers with a floor for a turn the index did not score under a scored question', async () => {
    const index = await buildSessionRelevanceIndex(embedding(), cases(), { topK: 1 });
    expect(index.relevanceFor(QUESTION, 'a turn from nowhere')).toBe(-2);
  });

  it('defaults the width to 32 sessions when the caller names none', async () => {
    // The default is what an artifact will report for a run whose dispatch left the width blank, so
    // it is a value a reader compares across runs and not an implementation detail.
    const index = await buildSessionRelevanceIndex(embedding(), cases());
    expect(index.topK).toBe(32);
  });

  it('breaks a score tie by session position, so two runs order identically', async () => {
    // Two sessions with the SAME joined text score identically; the tie-break is what keeps the
    // ranking a function of the case rather than of the sort implementation.
    const same = 'the identical session';
    const index = await buildSessionRelevanceIndex(
      tableEmbedding({ [QUESTION]: [1, 0], [same]: [1, 0] }, 2),
      [
        {
          question: QUESTION,
          context: [same, same],
          sessions: [[same], [same]],
        },
      ],
      { topK: 2 },
    );
    // One scored turn, because the two sessions hold the same text and the map is keyed by text --
    // and the tie-break is what made the first of the two the one that set it.
    expect(index.scoredPairs).toBe(1);
    expect(index.relevanceFor(QUESTION, same)).toBeCloseTo(1, 6);
  });
});
