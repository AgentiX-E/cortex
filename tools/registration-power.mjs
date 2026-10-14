#!/usr/bin/env node
/**
 * What a per-capability threshold is allowed to be.
 *
 * ## Why this exists
 *
 * Three registrations in a row wrote a numeric threshold without deriving it, and each
 * one produced a verdict that was an artefact of the number:
 *
 *   - §13.17's P1 was `gold-in-carried >= 0.80` with `carried` undefined, so two readings
 *     of the same artifact gave 99.6% and 10.8% and neither was wrong;
 *   - §13.20's P2' was registered as a prediction when §13.20's own text says it is a
 *     control, so its outcome could not be scored either way;
 *   - §13.21's P2'' asserted `within 3pp` for four capabilities whose per-question
 *     granularity is 0.67pp to 3.33pp, so on KU -- 72 questions, observed 0.8611 -- the
 *     band was 0.66 binomial standard deviations wide and the prediction had to fail.
 *
 * A per-capability accuracy on `n` questions is a sample proportion, and its resolution
 * and its noise are arithmetic, not judgement. This prints them so a registration can
 * cite them. The output is deliberately three numbers and not a p-value: the question a
 * registration asks is "how far can this move without meaning anything", and the answer
 * is a band the reader can check by hand.
 *
 * ## What it is not
 *
 * It is not a significance test for the headline. That comparison is paired and lives in
 * the artifact as McNemar's exact test over the discordant pairs, which is the right
 * instrument for two systems answering the same questions. This is for the *secondary*
 * claims -- the controls, and the per-capability readings a run is localised by.
 *
 * Usage:  node tools/registration-power.mjs <n> <observed-proportion> [sd-multiple]
 *
 * Example: `node tools/registration-power.mjs 72 0.8611 1.5`
 */

/** One question's worth of accuracy, in percentage points. */
export function granularityPoints(n) {
  return 100 / n;
}

/** The binomial standard deviation of a sample proportion, in percentage points. */
export function sdPoints(n, p) {
  return 100 * Math.sqrt((p * (1 - p)) / n);
}

/**
 * The half-width of a band at `k` standard deviations, in percentage points.
 *
 * `k = 1.5` is the default this repository registers at, and the choice is a statement
 * rather than a convention: a control band exists to detect leakage, and the smallest
 * leak that would matter in this campaign is TR's 27.56-point movement under §13.20, so
 * any band well below that is sensitive enough. At `k = 1.5` the four controls of §13.22
 * are 4.0 to 6.8 points wide, which detects a leak of eight points upward and would have
 * caught the three-point claim being made against a four-and-a-half-point noise floor.
 */
export function bandPoints(n, p, k = 1.5) {
  return k * sdPoints(n, p);
}

/** True when a registered band is narrower than the noise it is meant to bound. */
export function isUnderpowered(n, p, band) {
  return band < sdPoints(n, p);
}

function main(argv) {
  const [rawN, rawP, rawK] = argv;
  const n = Number(rawN);
  const p = Number(rawP);
  const k = rawK === undefined ? 1.5 : Number(rawK);

  if (!Number.isInteger(n) || n <= 0) throw new Error('n must be a positive integer');
  if (!(p > 0 && p < 1)) throw new Error('the observed proportion must lie strictly in (0, 1)');
  if (!(k > 0)) throw new Error('the standard-deviation multiple must be positive');

  const granularity = granularityPoints(n);
  const sd = sdPoints(n, p);
  const band = bandPoints(n, p, k);
  const alreadyUnderpowered = isUnderpowered(n, p, granularity * 2);

  console.log(`n = ${n} questions, observed ${(p * 100).toFixed(2)}%`);
  console.log(`  one question            = ${granularity.toFixed(2)}pp`);
  console.log(`  binomial sd             = ${sd.toFixed(2)}pp   (moves of this size are noise)`);
  console.log(`  band at ${k} sd          = +/-${band.toFixed(2)}pp`);
  console.log(
    `  registered as a band of ${(granularity * 2).toFixed(2)}pp (+/- 2 questions) it would be ` +
      `${granularity * 2 < sd ? 'UNDERPOWERED' : 'detectable'}`,
  );
  console.log(
    `  a movement beyond +/-${band.toFixed(2)}pp is worth attributing; a movement inside it is not`,
  );
  console.log(
    alreadyUnderpowered
      ? '  NOTE: a two-question band on this capability is narrower than one sd. Register the sd multiple.'
      : '',
  );
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`registration-power: ${error.message}`);
    process.exit(2);
  }
}
