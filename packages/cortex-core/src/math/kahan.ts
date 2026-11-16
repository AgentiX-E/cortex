/**
 * Compensated (Kahan) summation.
 *
 * ## Why this one function stays in the product package
 *
 * The rest of the statistics this repository needs -- `mean`, `variance`,
 * `welchTTest`, `wilsonScoreInterval` and the incomplete-beta machinery under
 * `studentTCdf` -- moved to `cortex-eval` (`#25`), because the only consumers are
 * the harness's paired readings. This one did not: `vector.ts` computes a
 * magnitude with it, and a magnitude is on the product's retrieval path rather
 * than on the instrument's.
 *
 * The move was decided by measurement rather than by tidiness. Before it, the
 * product barrel exported twelve statistics of which **eleven** had no consumer
 * outside `cortex-eval` -- an API surface that advertised a capability the
 * product did not have. `tools/export-census.py` reported each of them as
 * `exported-unreferenced`, and the classification was right: an export nobody
 * outside one dev-dependency imports is a claim about the package, not a
 * feature of it.
 *
 * ## Why the loop is here rather than duplicated
 *
 * `mean` in `cortex-eval/src/stats.ts` needs a Kahan sum, and that file imports
 * this one rather than carrying a second copy. Two implementations of one
 * numerical routine is the failure mode the whole campaign is built against: they
 * agree today, and the first edit to either makes two paths report different sums
 * for the same input with nothing in the artifact to say which ran.
 */

/**
 * The sum of `values`, with compensation for floating-point cancellation.
 *
 * The naive loop loses low-order bits whenever a running total is much larger
 * than the value being added -- which is the ordinary case for the magnitudes
 * here (a vector of squares whose entries span several decades). The compensation
 * term `c` carries the residue of each addition forward, so the returned sum is
 * the exact sum rounded once rather than the result of `n` independent roundings.
 */
export function kahanSum(values: Iterable<number>): number {
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const y = v - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}
