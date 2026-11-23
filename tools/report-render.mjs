/**
 * The two lines of a table that were printing claims the run had not made.
 *
 * ## The capability cell
 *
 * Run `45096017960` printed the product arm as `0/6 a6/6` on `ABS` and `0/6 a4/6` on `IE`, while the row above it
 * said `80.0% (24/30)`. The two are not contradictory -- `found/measured` is retrieval and `a…` is reading -- but the
 * left half is **zero by construction** for a system that answers its own questions: `CortexProductProvider.search`
 * returns `[]` because the product has no ranked-list endpoint, so `found` is 0 on every family and the cell reads
 * "it found nothing" about a system that answered 24 of 30.
 *
 * The table above that block already refuses this exact claim for its own recall columns
 * (`score.answerer === 'self' ? '—' : pct(score.recallAtK)`), with the reason written beside it. The capability
 * block was written later and the argument did not travel with it. Extracting the cell is what makes the two agree:
 * both now read one rule, and the rule is testable through a seam instead of through a printed table that needs a
 * paid run to produce.
 *
 * ## The configuration footer
 *
 * The same run's footer said `reader/judge=none`. Its own JSON says `reader: deepseek-chat (chain-of-note/con,
 * temp=0, one request)` and the same for the judge, because reading is what the stage does. The strings were
 * literals in the footer, so they described a retrieval-only table under a table of graded answers.
 *
 * A line that names the run has to be built from the run. Both functions here take the values and return the text,
 * so a wrong name is a red test rather than a paragraph nobody re-reads.
 */

/**
 * @param {{ answerer?: string, byCapability?: Record<string, { found: number, measured: number, correct?: number, read?: number }> }} score
 * @param {string} capability
 * @returns {string}
 */
export function capabilityCell(score, capability) {
  const bucket = score.byCapability?.[capability];
  if (bucket === undefined) return '—';
  // `found` is unmeasured, not zero. A self-answering system's retrieval is its navigation, and the pages it read are
  // a reasoning trace rather than a result set: the same sentence the recall columns of the table above already say.
  const retrieval = score.answerer === 'self' ? '—' : `${bucket.found}/${bucket.measured}`;
  return bucket.read === 0 ? retrieval : `${retrieval} a${bucket.correct}/${bucket.read}`;
}

/**
 * The delivered-context column, which is `meanContextChars / 4` — and undefined for an arm with no hit list.
 *
 * `null-floor` prints `0` here and should: it searched and found nothing, and zero is the measurement. A
 * self-answering arm also computes zero, because the column is derived from the hits it returns and it returns none
 * — but its context was its own prompt, which is a different quantity and is reported by `llm/q`. Printing `0` for
 * it says "delivered nothing" about a system that delivered 4,903 turns to itself.
 *
 * @param {{ answerer?: string, meanContextChars?: number }} score
 * @returns {string}
 */
export function contextTokensCell(score) {
  if (score.answerer === 'self') return '—';
  return String(Math.round((score.meanContextChars ?? 0) / 4));
}

/**
 * The line under the table that says which configuration produced it.
 *
 * `differing` comes from `comparability()` between this stage and a retrieval-only run of the same arms -- the
 * fields a reader has to account for when placing these numbers beside the retrieval table. It replaced
 * `comparability(config, config)`, whose `differing` was always `[]` and whose grade was always `A`: a value
 * compared with itself cannot fail, and a guard that cannot fail is not a guard.
 *
 * @param {{ limit: number, mode: string, reader: string, judge: string, differing?: readonly string[] }} run
 * @returns {string}
 */
export function configurationLine(run) {
  const changed = run.differing === undefined || run.differing.length === 0 ? 'nothing' : run.differing.join(', ');
  return (
    `\nconfiguration: k=${run.limit}, mode=${run.mode}, reader=${run.reader}, judge=${run.judge}\n` +
    `stages: reading vs retrieval-only differs in ${changed}\n`
  );
}
