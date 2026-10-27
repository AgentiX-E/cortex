/**
 * Score a session as one unit, then project that score onto the turns it contains.
 *
 * ## Why this module exists rather than a fourth `relevanceUnits` value
 *
 * `relevanceUnits: session` ranks **turns** and then takes the largest prefix of whole sessions
 * that fits. The reference pipeline does a different thing: it scores a **session** — its
 * concatenated text, **one embedding** — and keeps the top-k sessions. Run `39699987781` measured
 * the first operation losing 11 questions against the turn unit (`MEASURE-MR-UNITS.md` §2), and that
 * result says nothing about the second, which this arm could not express at all because
 * `relevanceFor(question, turn)` is keyed by turn.
 *
 * ## Why projection, and what it buys
 *
 * A session's score, written onto each of its turns, makes `relevanceUnits: session`'s existing rule
 * — "rank sessions by their best-scoring turn" — **be** session ranking, with `CortexMemory`'s
 * budget code untouched. That is what makes `PREREG-MR-SESSION-CHANNEL.md` a single-variable
 * registration: the ordering changes, the selection does not. A version that also rewrote the
 * selection would move two things and could attribute the result to neither.
 *
 * The price is that a score is now constant inside a session, which is exactly wrong for a question
 * answered by one turn. That is why the signal is route-scoped to `multi-session`: on the flat,
 * temporal, knowledge-update, abstention and assistant routes the turn-scored index stays
 * byte-identical, and those four capabilities are the internal control that says so.
 *
 * ## Why the joined text is not the rendered prompt
 *
 * A session's text here is its turns joined by a newline — the same separator the session prompt
 * uses to separate evidence blocks — and **not** a truncated or role-filtered view. Scoring and
 * presentation are separate decisions: `evidenceRoles` and `maxTurnChars` decide what the reader
 * sees, and letting either of them into the index would make the ranking depend on a switch the
 * registration holds fixed.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { cosineSimilarity } from '@agentix-e/cortex-core';
import type { RelevanceIndex } from './relevance-index.js';

/**
 * One question with the session boundaries its `context` was flattened from.
 *
 * `sessions` is required, and the requirement is the point: a caller holding only `context` cannot
 * use this builder, and a builder that fell back to turn scoring would put `retrieval-session` in an
 * artifact whose scores came from somewhere else — which reads as evidence that the session channel
 * does nothing.
 */
export type SessionRelevanceCase = {
  readonly question: string;
  readonly context: readonly string[];
  readonly sessions: readonly (readonly string[])[];
};

/** How to build the index. */
type SessionRelevanceOptions = {
  /**
   * How many **sessions** per question carry a score. Defaults to
   * {@link DEFAULT_SESSION_RELEVANCE_TOP_K}.
   *
   * The unit here is a session, not a turn — that is the whole difference from
   * `relevance-index.ts`, whose `topK` counts turns. At LongMemEval-S's session length a session
   * holds roughly ten turns, so the same number buys about ten times the evidence.
   */
  readonly topK?: number;
};

/** Sessions scored per question when the caller names no width. */
const DEFAULT_SESSION_RELEVANCE_TOP_K = 32;

/**
 * The floor a turn answers with when the index did not score it.
 *
 * Deliberately the same value `relevance-index.ts` uses, and deliberately not imported from it:
 * that constant is private there, and exporting it would make one module's internal sentinel part
 * of two modules' contracts. The two are asserted equal by this module's test, so a change to one
 * that forgets the other fails rather than silently ranking unscored turns above scored ones.
 */
const UNSCORED_RELEVANCE = -2;

/**
 * Build the index: one embedding per session, projected onto that session's turns.
 *
 * Every case is validated before anything is embedded, so a malformed case fails in milliseconds
 * rather than after a full haystack has been paid for.
 */
export async function buildSessionRelevanceIndex(
  embedding: EmbeddingModel,
  cases: readonly SessionRelevanceCase[],
  options: SessionRelevanceOptions = {},
): Promise<RelevanceIndex> {
  const topK = options.topK ?? DEFAULT_SESSION_RELEVANCE_TOP_K;
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error(
      `session relevance topK must be a positive integer, got ${String(options.topK)}. A width of 0 ` +
        'scores no session, which leaves every turn unscored while the artifact still claims a ranking.',
    );
  }

  for (const entry of cases) {
    validate(entry);
  }

  const scores = new Map<string, Map<string, number>>();
  const ranked = new Map<string, string[]>();
  let scoredPairs = 0;

  for (const entry of cases) {
    const sessionTexts = entry.sessions.map((turns) => turns.join('\n'));
    // An empty session embeds as the empty string, which cosines to 0 against everything. It is
    // kept in the array so the index stays aligned with `sessions`, and it scores nothing because
    // there is no turn to project onto -- skipping it here would shift every later index.
    const vectors = await embedding.embed([entry.question, ...sessionTexts]);
    const query = vectors[0]!;

    const scored: { readonly index: number; readonly score: number }[] = [];
    for (let i = 0; i < entry.sessions.length; i++) {
      if (entry.sessions[i]!.length === 0) continue;
      scored.push({ index: i, score: cosineSimilarity(query, vectors[i + 1]!) });
    }
    // Sorted by score, then by session position, so two sessions that score identically are
    // ordered by where they appeared rather than by whatever the sort happened to do.
    scored.sort((left, right) => right.score - left.score || left.index - right.index);

    const byTurn = new Map<string, number>();
    const order: string[] = [];
    for (const { index, score } of scored.slice(0, topK)) {
      for (const turn of entry.sessions[index]!) {
        // First occurrence **in rank order** wins. The same turn text can sit in two sessions whose
        // *joined* texts differ, so the two occurrences carry different scores even though the
        // turn's own vector is one value; `relevanceFor` is keyed by text and can express one.
        // Rank order is the right one: a turn's score means "how relevant is the session that best
        // represents it", and the session ranked first represents everything it holds. Position
        // would say the opposite -- that whichever copy appeared first wins, including a worse one.
        //
        // Determinism, not preference: `scored` is sorted by score with the session's position as
        // the tie-break, so two runs holding the same cases resolve the duplicate identically. Left
        // to `Map` insertion order it would be discovered by comparing two runs that were supposed
        // to be identical.
        if (byTurn.has(turn)) continue;
        byTurn.set(turn, score);
        order.push(turn);
      }
    }
    scores.set(entry.question, byTurn);
    ranked.set(entry.question, order);
    scoredPairs += byTurn.size;
  }

  return {
    questions: cases.length,
    scoredPairs,
    topK,
    relevanceFor(question: string, turn: string): number {
      return scores.get(question)?.get(turn) ?? UNSCORED_RELEVANCE;
    },
    candidatesFor(question: string): ReadonlySet<string> {
      return new Set(ranked.get(question) ?? []);
    },
    rankedCandidatesFor(question: string): readonly string[] {
      return [...(ranked.get(question) ?? [])];
    },
  };
}

/**
 * Refuse a case that cannot be scored as sessions.
 *
 * Three separate refusals, because they are three separate mistakes a caller can make and the
 * message has to say which one it was:
 *
 * 1. **No `sessions`.** The old shape. Falling back to turns would mislabel the artifact.
 * 2. **`sessions.flat()` disagrees with `context`.** Both come from one loader
 *    (`loadLongMemEval` sets `context: sessions.flat()`), so disagreement means a hand-built case,
 *    and a misaligned case attributes a score to the wrong session.
 * 3. **No session at all.** Scoring nothing is not the same as scoring badly, and an index that
 *    silently holds nothing makes every turn look irrelevant rather than unscored.
 */
function validate(entry: SessionRelevanceCase): void {
  const sessions: unknown = (entry as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    throw new Error(
      `session relevance needs \`sessions\` on every case; question ${JSON.stringify(entry.question)} ` +
        'has none. Returning turn scores here would put `retrieval-session` in an artifact whose ' +
        'scores came from the turn index.',
    );
  }
  if (sessions.length === 0) {
    throw new Error(
      `session relevance needs at least one session; question ${JSON.stringify(entry.question)} has ` +
        'an empty list, which would score nothing and read as "no evidence".',
    );
  }
  const flattened = (sessions as readonly (readonly string[])[]).flat();
  if (flattened.length !== entry.context.length) {
    throw new Error(
      `session relevance needs \`sessions\` whose \`flat()\` equals \`context\`; question ` +
        `${JSON.stringify(entry.question)} yields ${String(flattened.length)} turns from its sessions ` +
        `and ${String(entry.context.length)} in its context.`,
    );
  }
  for (let i = 0; i < flattened.length; i++) {
    if (flattened[i] !== entry.context[i]) {
      throw new Error(
        `session relevance needs \`sessions\` whose \`flat()\` equals \`context\`; question ` +
          `${JSON.stringify(entry.question)} differs at turn ${String(i)}.`,
      );
    }
  }
}
