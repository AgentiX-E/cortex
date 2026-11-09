#!/usr/bin/env node
/**
 * Where the evidence budget binds, read out of an artifact's own `goldOverlap.goldRanks`.
 *
 * The cost axis has 52% of headroom to `Zep`'s 4,400 tokens, and the natural explanation was that
 * the character budget cuts gold turns the ranking had already found -- which would make "send fewer
 * turns" a free saving. The archived artifacts refute it:
 *
 *   recall   pool / total     95.9%   the ranking surfaces almost every gold turn somewhere
 *   kept     carried / pool   91.7%   the budget drops 8% of what the ranking offered
 *   end-to-end carried / total 87.9%
 *
 * So the budget is not what loses the evidence. **Depth is.** At K=20 the ranking covers 51.5% of
 * gold, which is why every attempt to shrink the window has cost accuracy (`A3`'s 24,000 room cost
 * 2.65 points) and why the per-route allocation stopped at 8% of remaining room: below about 40
 * turns this ranking cannot keep the answers it is given.
 *
 * That inverts the next step. The 52% is not reachable by spending less; it is reachable only by
 * making the ranking put gold nearer the front, which is the variable MemStrata's own ablation priced
 * at 7.6 points and this arm has never measured at a fixed depth.
 *
 * One accounting rule is load-bearing. The multi-session route assembles whole sessions, so turns
 * arrive that the ranking never offered; `carried` then exceeds `pool` and `carried / pool` reads
 * above 100%. That is a bypass, not a retention rate, and this tool reports it as one rather than
 * printing a percentage of something it cannot name.
 */
import { readFileSync } from 'node:fs';

/**
 * Coverage of gold at each requested depth.
 *
 * @param {readonly number[]} ranks each gold turn's position in the ranking, or -1 when the ranking
 *                                 never surfaced it
 * @param {readonly number[]} depths
 * @returns {{total: number, never: number, coverage: Record<string, number | null>}}
 */
export function depthCurve(ranks, depths) {
  const total = ranks.length;
  const never = ranks.filter((rank) => rank < 0).length;
  const coverage = {};
  for (const depth of depths) {
    // `null` rather than `0`, because "nothing was measured" and "nothing was found" are different
    // statements and every count in this repository is written to keep them apart.
    coverage[String(depth)] =
      total === 0 ? null : ranks.filter((rank) => rank >= 0 && rank < depth).length / total;
  }
  return { total, never, coverage };
}

/**
 * The shallowest depth whose coverage reaches `target`, or `null` when none does.
 *
 * `null` rather than the pool depth, because a gold turn at rank -1 is unreachable at every depth:
 * reporting the pool size would name a depth that does not deliver the target.
 *
 * @param {readonly number[]} ranks
 * @param {number} target in (0, 1]
 * @returns {number | null}
 */
export function depthForCoverage(ranks, target) {
  if (!(target > 0 && target <= 1)) throw new Error(`target must be in (0, 1], got ${target}`);
  const reachable = ranks.filter((rank) => rank >= 0);
  const need = Math.ceil(target * ranks.length);
  if (reachable.length < need) return null;
  // The answer is the `need`-th smallest rank plus one: a gold at rank r is inside depth r + 1.
  const sorted = [...reachable].sort((a, b) => a - b);
  return sorted[need - 1] + 1;
}

/**
 * Per-capability census: how much gold the ranking found, how much the budget kept, and whether the
 * delivery path bypassed the ranking entirely.
 *
 * @param {readonly object[]} records question records carrying `capability` and `goldOverlap`
 */
export function censusByCapability(records) {
  const rows = {};
  const blank = () => ({
    questions: 0,
    total: 0,
    carried: 0,
    pool: 0,
    never: 0,
    bypassed: 0,
    recall: null,
    kept: null,
    endToEnd: null,
  });
  for (const record of records) {
    const overlap = record.goldOverlap;
    if (!overlap || typeof overlap.total !== 'number' || overlap.total === 0) continue;
    const key = record.capability ?? 'unknown';
    const row = (rows[key] ??= blank());
    row.questions += 1;
    row.total += overlap.total;
    row.carried += overlap.carried;
    // `pool` is absent on artifacts written before the ranking was passed in, and that absence is
    // not a zero: those records support recall and end-to-end but not kept.
    if (typeof overlap.pool === 'number') {
      row.pool += overlap.pool;
      row.never += overlap.total - overlap.pool;
      if (overlap.carried > overlap.pool) row.bypassed += overlap.carried - overlap.pool;
    }
  }
  for (const row of Object.values(rows)) {
    row.recall = row.total === 0 ? null : row.pool / row.total;
    // A row where more gold arrived than the ranking offered has no retention rate: the extra turns
    // came from session assembly, and `carried / pool` there is a ratio above one, not a proportion.
    row.kept = row.pool === 0 || row.carried > row.pool ? null : row.carried / row.pool;
    row.endToEnd = row.total === 0 ? null : row.carried / row.total;
  }
  return rows;
}

const DEPTHS = [5, 10, 20, 30, 40, 60, 80, 120, 160];

function main(argv) {
  const path = argv[0];
  if (!path) throw new Error('usage: evidence-depth-curve.mjs <report.json>');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const records = report.questions ?? [];
  const census = censusByCapability(records);
  const ranksBy = {};
  const allRanks = [];
  for (const record of records) {
    const ranks = record.goldOverlap?.goldRanks;
    if (!Array.isArray(ranks)) continue;
    (ranksBy[record.capability ?? 'unknown'] ??= []).push(...ranks);
    allRanks.push(...ranks);
  }

  const pct = (value) => (value === null ? '     —' : `${(value * 100).toFixed(1)}%`);
  const pad = (value, width) => String(value).padEnd(width);

  const lines = [];
  lines.push(`${records.length} question(s); gold accounting by capability`);
  lines.push('');
  lines.push(
    `${pad('cap', 8)}${pad('n', 5).padStart(5)}${pad('gold', 7).padStart(7)}` +
      `${pad('recall', 9).padStart(9)}${pad('kept', 8).padStart(8)}${pad('e2e', 8).padStart(8)}` +
      `${pad('bypass', 8).padStart(8)}`,
  );
  const order = [...Object.keys(census)].sort();
  const total = {
    questions: 0,
    total: 0,
    carried: 0,
    pool: 0,
    bypassed: 0,
    recall: 0,
    kept: 0,
    endToEnd: 0,
  };
  for (const key of [...order, 'ALL']) {
    const source =
      key === 'ALL'
        ? order.reduce(
            (acc, name) => {
              const row = census[name];
              for (const field of ['questions', 'total', 'carried', 'pool', 'bypassed'])
                acc[field] += row[field];
              return acc;
            },
            { questions: 0, total: 0, carried: 0, pool: 0, bypassed: 0 },
          )
        : census[key];
    // Recomputed here only for the synthetic ALL row, which no record carries; every named row
    // reads what `censusByCapability` decided, so `kept` cannot be a rate above one in one place
    // and absent in another.
    const combined = key === 'ALL';
    const recall = source.total === 0 ? null : source.pool / source.total;
    const kept =
      source.pool === 0 || source.carried > source.pool ? null : source.carried / source.pool;
    const e2e = source.total === 0 ? null : source.carried / source.total;
    if (combined) Object.assign(total, { recall, kept, endToEnd: e2e, bypassed: source.bypassed });
    lines.push(
      `${pad(key, 8)}${pad(source.questions, 5).padStart(5)}${pad(source.total, 7).padStart(7)}` +
        `${pct(recall).padStart(9)}${pct(kept).padStart(8)}${pct(e2e).padStart(8)}` +
        `${String(source.bypassed ?? 0).padStart(8)}`,
    );
  }

  lines.push('');
  lines.push(
    `coverage of gold at ranking depth K — ${pct(total.recall)} of gold is inside the pool, so a ` +
      `miss at depth is the budget and a miss at -1 is the ranking`,
  );
  lines.push(
    `${pad('cap', 8)}${pad('gold', 6).padStart(6)}` +
      DEPTHS.map((depth) => `${`K${depth}`.padStart(7)}`).join('') +
      `${'never'.padStart(8)}${'K@90%'.padStart(8)}`,
  );
  for (const key of [...order, 'ALL']) {
    const ranks = key === 'ALL' ? allRanks : (ranksBy[key] ?? []);
    const curve = depthCurve(ranks, DEPTHS);
    const ninety = depthForCoverage(ranks, 0.9);
    lines.push(
      `${pad(key, 8)}${pad(curve.total, 6).padStart(6)}` +
        DEPTHS.map((depth) => pct(curve.coverage[String(depth)]).padStart(7)).join('') +
        `${pct(curve.total === 0 ? null : curve.never / curve.total).padStart(8)}` +
        `${String(ninety ?? 'unreachable').padStart(8)}`,
    );
  }

  lines.push('');
  const shallow = depthCurve(allRanks, [20]).coverage['20'];
  lines.push(
    `reading: at depth 20 this ranking covers ${pct(shallow)} of gold, so the budget cannot shrink ` +
      `without dropping answers. The 52% of cost headroom is a ranking problem, not a budget one.`,
  );
  if (total.bypassed) {
    lines.push(
      `note: ${total.bypassed} carried gold turn(s) arrived without the ranking offering them ` +
        `(session assembly), so kept is reported as — where it would exceed 100%.`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
