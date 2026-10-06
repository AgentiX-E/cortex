/**
 * A per-turn confidence signal, computed from the turn itself.
 *
 * ## Why this module exists
 *
 * `admission.ts` owns the *mechanism* by which per-turn confidence reaches the
 * value function (`AdmissionOptions.confidenceFor`). It deliberately owns no
 * *signal*: a real quality estimate is lexical overlap, retrieval rank, or an
 * embedding score, and none of those can be computed inside `cortex-memory` --
 * the package depends on `cortex-core` only and reads no embedding model, so
 * measuring turn quality there would make the composition layer depend on a
 * retrieval mechanism it is meant to sit above.
 *
 * That left one question unanswered, and it is a question a benchmark arm has to
 * answer: **what does the arm pass?** §49.1 established that the next
 * registration cannot be "same wiring, different threshold" -- variation has to
 * come from somewhere -- and a registration whose variation is a private helper
 * inside an arm is a variation no test can reach and no reader can audit. So the
 * signal is a module in `src/**`, inside the coverage boundary, and the arm
 * passes *it* rather than an inline closure.
 *
 * ## What makes a signal admissible here
 *
 * The constraint this project holds every measurement to is attribution: a number
 * that moved has to be attributable to the mechanism under test. A confidence
 * signal therefore has to be
 *
 * 1. **deterministic** -- same turn, same value, on every run and every machine,
 *    or the arm's delta contains the signal's noise;
 * 2. **content-only** -- a function of the turn, never of its position, or the
 *    gate becomes a statement about ordering and the arm about the dataset's
 *    turn ordering;
 * 3. **I/O-free and model-free** -- no embedding call, no LLM call. An embedding
 *    here would make the "cognitive layer" arm differ from the baseline arm by a
 *    retrieval mechanism as well as by the value gate, which is exactly the
 *    conflation `rerank.ts` describes for the protected head;
 * 4. **bounded and non-degenerate** -- in `[0, 1]`, and not constant over a real
 *    context, because a constant signal cannot discriminate any more than a
 *    constant value could. §49 is the measurement of that failure.
 *
 * Criterion 4 is the one worth spelling out, because it is the criterion a
 * plausible-looking implementation fails. `confidenceFromLength` below is
 * monotone in `min(1, length / saturation)` and a real context contains turns on
 * both sides of saturation, so it varies. A variant that returned
 * `Math.min(1, turn.length / 10_000)` satisfies criteria 1-3 and, over any context
 * whose turns are shorter than ten thousand characters, is constant -- a signal
 * that looks like one and discriminates nothing. So does any variant whose
 * saturation the dataset never reaches, which is the general form: **a signal that
 * varies only on inputs the run never contains is a constant signal in the run it
 * is graded on.** The tests assert variation against a real-shaped context rather
 * than against the formula, because that is the only place the distinction shows.
 *
 * ## Why length, and what it is and is not
 *
 * Length is the weakest defensible signal, and it is chosen for that reason. It
 * needs no model, no vocabulary, and no tuning corpus; it cannot be accused of
 * encoding the benchmark's answers; and it is legible -- a reader can verify by
 * eye that a longer turn scores higher. It is **not** a claim that length
 * predicts relevance in general, and the arm's artifact records which signal it
 * ran under so a later registration can replace it and compare.
 *
 * The alternative considered was word overlap with the question. It is a better
 * quality proxy and it was rejected here for a specific reason: admission's
 * callback signature is `(turn) => number`, with no question in scope, so an
 * overlap signal requires either widening that signature or having the signal
 * close over the question. Both are real options; neither belongs in the round
 * that establishes the mechanism, because a mechanism verified through a signal
 * that has to reach outside its own interface is not yet verified.
 */

/**
 * Turn length at which confidence saturates, in UTF-16 code units.
 *
 * `2_000` rather than a smaller number because it is also
 * `DEFAULT_MAX_TURN_CHARS` on the reference side: turns are truncated to that
 * length before admission there, so saturating at the same point keeps this
 * signal's resolution inside the range where turn text actually differs. A
 * saturation below the truncation point would score every long turn identically
 * for a reason that is an artifact of the other pipeline's limit.
 *
 * Exported for no one, and that is the census gate's verdict rather than an
 * oversight: its only callers are the tests below, and the census excludes test
 * files from the caller count by design, so an `export` here would advertise a
 * consumer that does not exist. The tests reach it through `__tests__`'s direct
 * import rather than through the barrel for the same reason.
 */
const SATURATION_CHARS = 2_000;

/**
 * Confidence as monotone saturation over turn length: `min(1, length / 2000)`.
 *
 * Monotone with a floor at `0`, so an empty turn carries no confidence and a turn
 * at or past saturation carries full confidence. The two endpoints are both
 * reachable in a real context, which is what makes the resulting values spread
 * across `(0, 1]` rather than sitting at one point.
 *
 * Deliberately **not** offset to avoid `0`: an empty turn genuinely carries no
 * evidence, and a floor of `0` is what `AdmissionOptions.confidenceFor` documents.
 * Offsetting it would be a tuning decision made to avoid an edge case, which is
 * how a signal acquires a constant nobody can explain.
 */
export function confidenceFromLength(turn: string): number {
  return Math.min(1, turn.length / SATURATION_CHARS);
}
