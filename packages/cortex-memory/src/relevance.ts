/**
 * Query-term relevance: the signal that makes session selection a statement about the question.
 *
 * ## The measurement this repairs
 *
 * `selectSessionBudget` ranks sessions by `bestValue`, the highest `turn.value` in each. That is a correct
 * ranking rule, and with the values admission actually produces it is **not a ranking at all**. A turn's value
 * is `confidence * sourceTrust * (0.5 + 0.5 * recency)`, admission stamps `lastAccessedAt = createdAt = now`,
 * so `recency = exp(0) = 1` for every turn of one admission, and with `sourceTrust` at its default `0.5` and
 * no `confidenceFor` supplied every admitted turn carries exactly `0.5`. Measured directly on the synthetic
 * set (24 turns, one question): `distinct values: [0.5]`, `bestValue: 0.5` for all 24 sessions.
 *
 * So `bestValue` ties across the board and the sort falls through to its tie-break, `session.index` — arrival
 * order. A budget then keeps whichever sessions arrived first. The multi-session route was measured at
 * `all-gold 8.3%` while covering at least one gold turn for 91.7% of questions, which is exactly that shape:
 * the store holds the evidence and the selection spends the budget on the wrong sessions.
 *
 * ## Why this lives here, and why it is not `confidenceFor`
 *
 * `confidence.ts` records the alternative it rejected: word overlap with the question "is a better quality
 * proxy", but `AdmissionOptions.confidenceFor` is `(turn) => number` with no question in scope, so an overlap
 * signal would have to widen that signature or close over the question. Both are real, and the reason to
 * refuse them is that a mechanism verified through a signal reaching outside its own interface is not
 * verified.
 *
 * This module takes the third option that was not available then: the question enters at the **session
 * budget**, where ranking by session already happens and where the question is already a parameter of the
 * enclosing call. Nothing closes over anything — `lexicalRelevance(question, turn)` is a pure function of its
 * two arguments, the same discipline `PromptOptions.relevanceFor` follows.
 *
 * ## What makes the signal admissible
 *
 * The four criteria are `confidence.ts`'s, and they are the same criteria because they are properties of a
 * measurement rather than of one callback:
 *
 * 1. **deterministic** — same pair, same value, on every run and machine;
 * 2. **content-only** — a function of the two strings, never of an ordinal or a clock;
 * 3. **I/O-free and model-free** — no embedding, no LLM. That is what lets `cortex-memory` keep its
 *    `cortex-core`-only dependency, and it is why the adapter that uses this signal declares
 *    `build: 'none'` rather than `'embedding'`;
 * 4. **bounded and non-degenerate** — in `[0, 1]`, and not constant over a real context.
 *
 * ## The two terms, and why it is not one
 *
 * Coverage — the share of the question's content terms present in the turn — is the term that finds evidence.
 * On its own it has a known failure: a long turn mentioning every word of the question scores as well as the
 * one turn that states the answer, and multi-session questions are precisely the ones whose contexts contain
 * long turns.
 *
 * Order — the share of the question's adjacent term pairs that appear adjacent in the turn, in the same order
 * — is the term that separates those two. It is weak on its own (a turn that repeats one pair scores `1`), and
 * it is not weak as a tie-break, which is the only role the weight gives it.
 *
 * The weights are `0.85 / 0.15` and they are a **decision, not a fit**: coverage dominates because it is the
 * term with a defensible reading ("this turn mentions what was asked"), and order is a bonus that cannot
 * promote a turn mentioning nothing. A fitted weight would need a tuning corpus, and a corpus is the thing
 * whose answers this signal must not encode.
 */

/**
 * Words removed before matching.
 *
 * Function words only — articles, copulas, prepositions, pronouns, auxiliaries. Question words (`when`,
 * `where`, `how many`, `first`, `last`) and numerals are **kept**: they are the discriminating content of
 * temporal and counting questions, and dropping them is the classic way a lexical signal becomes blind to a
 * whole capability. `confidence.ts`'s `completeness` family is exactly the one that would suffer.
 *
 * Deliberately a small literal set rather than a corpus-derived list. A list fitted to a benchmark's term
 * distribution is a list that encodes the benchmark.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'was',
  'we',
  'were',
  'what',
  'which',
  'while',
  'who',
  'whom',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/**
 * How much of the score comes from term coverage.
 *
 * Stated as its own constant so the complementary weight is not a second literal that can disagree with it.
 */
const COVERAGE_WEIGHT = 0.85;

/**
 * Split a string into matchable terms, in order.
 *
 * Splitting is on `/[^a-z0-9]+/` after lowercasing, so `alice's` becomes `alice` and `s`, apostrophes don't
 * join words that were never joined, and hyphenated compounds become their parts. Digits survive: a date, a
 * price and a count are content, and a tokeniser that drops them makes every temporal and counting question
 * look like an empty question.
 *
 * `length >= 2` drops the single letters the split produces (`s`, `t`, `d`), which carry no meaning and would
 * otherwise inflate coverage for every turn of a contraction-heavy context.
 *
 * Returns duplicates. Coverage needs the distinct set and order needs the sequence, and building one from the
 * other would make the two terms read the same input differently.
 */
function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/**
 * How relevant `turn` is to `question`, in `[0, 1]`.
 *
 * `0` when the question carries no content terms, because there is nothing to match and a non-zero value
 * would be a score for a question that was never asked. `0` is also what a turn sharing no term scores, and
 * those two cases are genuinely the same answer: no evidence.
 *
 * A question that repeats a term is counted once for coverage — `set` semantics, because a question asking
 * "when when" is one question — and every occurrence for order, because adjacency is positional.
 */
export function lexicalRelevance(question: string, turn: string): number {
  const asked = terms(question);
  if (asked.length === 0) return 0;

  const wanted = [...new Set(asked)];
  const seen = new Set(terms(turn));

  let covered = 0;
  for (const term of wanted) {
    if (seen.has(term)) covered += 1;
  }
  const coverage = covered / wanted.length;

  // Adjacency over the distinct sequence: a question that repeats a term should not have its order score
  // diluted by the repetition, and the pairs that matter are the pairs it asks in.
  const presented = terms(turn);
  const adjacent = new Set<string>();
  for (let index = 0; index + 1 < presented.length; index += 1) {
    adjacent.add(`${presented[index]} ${presented[index + 1]}`);
  }

  let pairs = 0;
  let hit = 0;
  for (let index = 0; index + 1 < wanted.length; index += 1) {
    pairs += 1;
    if (adjacent.has(`${wanted[index]} ${wanted[index + 1]}`)) hit += 1;
  }
  // A one-term question has no pairs, and `hit / pairs` would be `0/0`. The order term is then taken to be the
  // coverage term, so the score is exactly `coverage` and never above it: a question that could not express an
  // order must not be scored as though it had expressed one. Reporting `0` instead would sink every
  // single-term question below every two-term one for a reason that is about the question's length, not the
  // turn's content.
  const order = pairs === 0 ? coverage : hit / pairs;

  return COVERAGE_WEIGHT * coverage + (1 - COVERAGE_WEIGHT) * order;
}
