/**
 * The floor a class has to clear, computed by the test the reading actually uses -- and the second
 * floor that has been ordering the queue instead.
 *
 * ## The defect this file exists to name
 *
 * `AUDIT-FAILURE-CLASSES.md` §4 ranks the queue by "ceiling against floor", and the floor in that
 * table is `2.8016 * sqrt(p(1-p)/n)` -- the **unpaired** two-proportion minimum detectable effect at
 * 80% power. Every dispatch in this campaign is read by a **paired** test: the same 500 questions
 * answered by two arms that differ in one field, with `T2` written as "McNemar p <= 0.05" and `T1`
 * requiring `b >= 6, c <= 1`. The two numbers are not the same quantity and on this corpus they are
 * not close:
 *
 * | population | unpaired floor | McNemar floor at `c = 0` |
 * | --- | ---: | ---: |
 * | `multi-session`, n = 121 | **9.5 questions** (7.87 points) | **6 questions** (4.96 points) |
 * | the whole suite, n = 500 | **15.8 questions** (3.16 points) | **6 questions** (1.20 points) |
 *
 * So the queue has been ordered by an instrument that demands 1.6 to 2.6 times what the registered
 * criterion does. §198.4 concluded "not one class clears the floor" and named that as "the
 * arithmetic reason five rounds of single-lever dispatches produced no certifiable reading". The
 * arithmetic was right and the *instrument* was wrong: a class of six questions is certifiable
 * today, and six is the size of five of the classes that table marked `no`.
 *
 * ## Why both numbers are printed rather than the wrong one deleted
 *
 * They answer different questions and a later reader needs both. The unpaired floor answers "how
 * many questions would a *different* population of questions need, to show this difference without
 * pairing" -- which is what a competitor comparison is, because two systems cannot be run on the
 * same run. The paired floor answers "how many questions must *move*, given that every other
 * question is held fixed by construction" -- which is what a one-field dispatch is. A dispatch is
 * the second thing, and the campaign has never run the first thing.
 *
 * ## The second check, which is not about arithmetic at all
 *
 * `tools/spec-reachability-groups.json` froze a ceiling on control `42533236864` and its own header
 * says it was frozen "before the round-62 `reviewPass: spec` dispatch". That dispatch never
 * happened, and the arm it would be read against has moved twice since -- `layered` and
 * `verbatim-acts`. Re-counting the frozen groups against the adopted arm is this file's second job,
 * and the answer is that the populations shrank:
 *
 * | group | frozen | still failing on the adopted arm |
 * | --- | ---: | ---: |
 * | `question-vocabulary` | 8 | **4** |
 * | `history-only` | 4 | **0** |
 * | `unreachable` | 5 | 3 |
 * | `no-numeric-gold` | 3 | 2 |
 *
 * A ceiling is a population, and a population measured against an older arm is not a ceiling for
 * the newer one. The registered ceiling of 12 decayed to 4, which is below the paired floor of 6:
 * **the queued dispatch could not have produced a certifiable reading even if it repaired every
 * question it could reach.** That is `refused`, not `pending`, and the refusal is the reason this
 * round spent nothing.
 *
 * ## What this file refuses
 *
 * Three states, each of which produces a plausible number about nothing:
 *
 * 1. A group id that the artifact does not contain. Counting it as failing inflates a ceiling;
 *    counting it as passing erases one.
 * 2. A class larger than its population, or a loss count not smaller than the gain count it is read
 *    against -- `c >= b` is not a win and its floor is not a floor.
 * 3. A verdict computed against no population at all (`n <= 0`), which is the shape
 *    `room-census.mjs` refuses as "a share of nothing".
 *
 * ## Self-test
 *
 * `--self-test` asserts the floor table at pinned values (`c = 0..3` read 6, 8, 10, 12), that the
 * exact p at `(6, 0)` is `0.03125` and at `(5, 0)` is `0.0625` -- the two numbers the whole
 * argument turns on -- that the unpaired floor at `MR`'s denominator reads 7.87, and that **the two
 * floors disagree** on a six-question class, which is the fixture that would fail if someone made
 * the paired branch an alias of the unpaired one. It also refuses a group with a missing id and
 * refuses a decayed group's ceiling.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A refusal is a state in which the number would describe nothing. Rendered, never thrown past main. */
class Refusal extends Error {}

/**
 * `C(n, k)` for the small `n` this file uses, in exact integers so the p-values are exact too.
 *
 * Exactness matters more than it looks: the argument in this file turns on `0.03125` against
 * `0.0625`, and a floating-point gamma function returns `0.03125000000000001` and `0.06250000000000001`
 * for those, which is fine for a comparison and useless for a pinned assertion.
 */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 0; i < k; i += 1) value = (value * (n - i)) / (i + 1);
  return Math.round(value);
}

/**
 * The exact two-sided McNemar p for `b` gains and `c` losses.
 *
 * The exact binomial rather than the chi-squared approximation, because the counts a one-field
 * dispatch produces are 5 to 20 and the approximation is worst exactly there. Two-sided by
 * doubling the lower tail, which is the convention `T2` was written against.
 */
export function mcnemarExact(b, c) {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new Refusal(`mcnemar needs two non-negative integers, read b=${b} c=${c}`);
  }
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k += 1) tail += choose(n, k);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/**
 * The smallest number of gains that certifies, given this many losses.
 *
 * "Certifies" means `mcnemarExact(b, c) <= alpha`, which is `T2` verbatim. The floor is not a power
 * calculation: with a deterministic reader the only randomness in a paired comparison is *which*
 * questions a mechanism happens to move, so the honest question is a sign test on the discordant
 * pairs and that is what this returns.
 *
 * `b` is required to exceed `c`, because a floor is the smallest **win**: a reading with more losses
 * than gains is not certified at any sample size, and returning a number for it would let a table
 * print a floor beside a mechanism that lost.
 */
export function pairedFloor(c, alpha = 0.05) {
  if (!Number.isInteger(c) || c < 0)
    throw new Refusal(`losses must be a non-negative integer, read ${c}`);
  for (let b = c + 1; b <= 400; b += 1) {
    if (mcnemarExact(b, c) <= alpha) return b;
  }
  throw new Refusal(`no gain count below 400 certifies ${c} losses at alpha=${alpha}`);
}

/**
 * The unpaired two-proportion minimum detectable effect, in **points**, for a population of `n` at
 * accuracy `p`.
 *
 * `z` is `1.96 + 0.8416` -- the two-sided 5% critical value plus the 80% power quantile -- which is
 * the constant `MEASURE-RESOLUTION-WALL.md` and `AUDIT-FAILURE-CLASSES.md` §4 both use. Kept as a
 * parameter so a reader can see that this number is a *choice of power*, not a property of the data.
 */
export function unpairedFloor(accuracy, n, z = 2.8016) {
  if (!(n > 0)) throw new Refusal(`a floor needs a population, read n=${n}`);
  if (!(accuracy > 0 && accuracy < 1))
    throw new Refusal(`accuracy must be inside (0,1), read ${accuracy}`);
  return 100 * z * Math.sqrt((accuracy * (1 - accuracy)) / n);
}

/** A class of `k` questions in a population of `n`, in points. The ceiling of a perfect mechanism. */
export function classCeiling(k, n) {
  if (!(n > 0)) throw new Refusal(`a ceiling needs a population, read n=${n}`);
  if (!Number.isInteger(k) || k < 0 || k > n)
    throw new Refusal(`a class of ${k} cannot live in ${n}`);
  return (100 * k) / n;
}

/**
 * Both floors and the verdict they imply, for one class.
 *
 * The verdict is the paired one, and the unpaired figure is printed beside it so that the
 * disagreement is visible rather than described. `ceiling` is what a **perfect** mechanism would
 * earn; a class whose ceiling is below the floor cannot certify no matter how well it works, which
 * is the check `AUDIT-FAILURE-CLASSES.md` §4 was trying to make.
 */
export function decide({ classN, population, losses = 0, accuracy = null }) {
  if (!Number.isInteger(classN) || classN < 1)
    throw new Refusal(`class size must be a positive integer, read ${classN}`);
  if (!Number.isInteger(population) || population < 1)
    throw new Refusal(`population must be a positive integer, read ${population}`);
  if (classN > population) throw new Refusal(`a class of ${classN} cannot live in ${population}`);
  if (!Number.isInteger(losses) || losses < 0)
    throw new Refusal(`losses must be a non-negative integer, read ${losses}`);
  const ceiling = classCeiling(classN, population);
  const floor = pairedFloor(losses);
  const floorPoints = classCeiling(floor, population);
  const p = accuracy ?? null;
  return {
    classN,
    population,
    losses,
    ceiling,
    floor,
    floorPoints,
    unpaired: p === null ? null : unpairedFloor(p, population),
    certifiable: classN >= floor,
  };
}

/**
 * Which of a frozen group's ids are still wrong in this artifact.
 *
 * The refusal on a missing id is the point of the function. A group is a *population*, and a
 * population that has lost members to a corpus change or a renamed id is a population nobody
 * counted -- the `room-census` rule, applied to a set of question ids instead of a set of routes.
 */
export function remaining(group, byId) {
  const stillFailing = [];
  const passed = [];
  const absent = [];
  for (const id of group.ids) {
    const row = byId.get(id);
    if (row === undefined) absent.push(id);
    else if (row.correct) passed.push(id);
    else stillFailing.push(id);
  }
  if (absent.length > 0) {
    throw new Refusal(
      `group ${group.name} names ${absent.length} id(s) this artifact does not contain (${absent.slice(0, 3).join(', ')}); ` +
        'a ceiling over a population it cannot see is not a ceiling',
    );
  }
  return { stillFailing, passed, absent };
}

/** The grouped rows of an evidence report, by question id. */
function byQuestionId(report) {
  const rows = report.questions ?? report.records ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Refusal('the artifact carries no `questions` array; nothing to count');
  }
  const map = new Map();
  for (const row of rows) {
    if (typeof row?.questionId !== 'string' || typeof row?.correct !== 'boolean') {
      throw new Refusal('a question row is missing `questionId` or `correct`');
    }
    map.set(row.questionId, row);
  }
  return map;
}

/** The report body, whether it is an artifact, a merged evidence file, or a bare array of rows. */
function readRows(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(parsed)) return byQuestionId({ questions: parsed });
  return byQuestionId(parsed);
}

/**
 * The decay table: each frozen group's ceiling on the arm it was frozen for, beside what is left of
 * it on the arm it will be read against.
 *
 * The frozen ceiling is not re-derived here and cannot be: it came from `measure-spec-ceiling.ts`,
 * which needs the corpus and the real executor. What is derived is the **remainder**, and the
 * comparison is the reading.
 */
export function decay(groups, byId) {
  const capability = groups?.source?.capability;
  if (typeof capability !== 'string') {
    throw new Refusal('the group file does not name the capability it was frozen on');
  }
  // The denominator is the population the groups were drawn from, read from the artifact rather than
  // written here: a ceiling in points is a share of a population, and a hardcoded 121 beside an
  // artifact of 500 questions is exactly the "share of nothing" this file refuses elsewhere.
  let population = 0;
  for (const row of byId.values()) if (row.capability === capability) population += 1;
  if (population === 0) {
    throw new Refusal(
      `the artifact has no ${capability} questions; the groups were frozen on that route`,
    );
  }
  const rows = [];
  for (const group of groups.groups) {
    const { stillFailing, passed } = remaining(group, byId);
    rows.push({
      name: group.name,
      frozen: group.ids.length,
      remaining: stillFailing.length,
      repaired: passed.length,
      ceiling: classCeiling(stillFailing.length, population),
      ids: stillFailing,
    });
  }
  return { capability, population, rows };
}

const USAGE =
  'usage: queue-floor.mjs --self-test | --artifact <report.json> --groups <groups.json> [--accuracy p] | ' +
  '--class <n> --population <n> [--losses <c>] [--accuracy p]\n';

function renderDecay({ capability, population, rows }, accuracy) {
  const lines = [];
  const floorGains = pairedFloor(0);
  const floorPoints = classCeiling(floorGains, population);
  lines.push(
    `${capability}: ${population} questions in the artifact; ` +
      `paired floor ${floorGains} gains = ${floorPoints.toFixed(2)} points (McNemar, c = 0)`,
  );
  lines.push('');
  lines.push('group                  frozen  remaining  repaired  ceiling  floor  verdict');
  for (const row of rows) {
    const verdict = row.remaining === 0 ? 'empty' : row.ceiling >= floorPoints ? 'ok' : 'refused';
    lines.push(
      `${row.name.padEnd(22)} ${String(row.frozen).padStart(6)} ${String(row.remaining).padStart(10)} ` +
        `${String(row.repaired).padStart(9)} ${row.ceiling.toFixed(2).padStart(8)} ` +
        `${floorPoints.toFixed(2).padStart(5)} ${verdict.padStart(8)}`,
    );
  }
  if (accuracy !== null) {
    lines.push('');
    lines.push(
      `unpaired floor for comparison: ${unpairedFloor(accuracy, population).toFixed(2)} points`,
    );
  }
  lines.push('');
  lines.push(
    'a group whose remaining ceiling is below the floor is REFUSED, not pending: no mechanism, however ' +
      'perfect, can certify on a population that small',
  );
  return lines;
}

function selfTest() {
  // The two numbers the whole argument turns on, at exact values.
  if (mcnemarExact(6, 0) !== 0.03125)
    throw new Error(`self-test: p(6,0) must be 0.03125, read ${mcnemarExact(6, 0)}`);
  if (mcnemarExact(5, 0) !== 0.0625)
    throw new Error(`self-test: p(5,0) must be 0.0625, read ${mcnemarExact(5, 0)}`);
  if (mcnemarExact(0, 0) !== 1) throw new Error('self-test: an empty comparison is not evidence');

  // The floor table, pinned. These four numbers are quoted in the audit note, so a change to the
  // convention has to break something.
  const table = [0, 1, 2, 3].map((c) => pairedFloor(c));
  const expected = [6, 8, 10, 12];
  if (JSON.stringify(table) !== JSON.stringify(expected)) {
    throw new Error(
      `self-test: floor table must read ${expected.join('/')}, read ${table.join('/')}`,
    );
  }

  // Monotone in the losses, because a reading that loses more must gain more to certify.
  for (let c = 0; c < 6; c += 1) {
    if (pairedFloor(c + 1) <= pairedFloor(c))
      throw new Error(`self-test: floor is not monotone at c=${c}`);
  }

  // The unpaired floor at MR's own denominator: 2.8016 * sqrt(.893*.107/121) * 100 = 7.87 points,
  // which is 9.5 questions of 121. The audit note quotes both, so both are held.
  const small = unpairedFloor(0.893, 121);
  if (Math.abs(small - 7.87) > 0.02)
    throw new Error(`self-test: unpaired floor at MR must read ~7.87, read ${small.toFixed(2)}`);
  if (Math.abs((small / 100) * 121 - 9.53) > 0.05) {
    throw new Error(
      `self-test: that floor must be ~9.5 questions of 121, read ${(((small / 100) * 121) | 0).toFixed(2)}`,
    );
  }

  // A bigger population resolves a smaller effect. Without this direction the whole "the suite floor
  // is smaller than the route floor" claim would be unmoored.
  if (!(unpairedFloor(0.935, 500) < unpairedFloor(0.935, 121))) {
    throw new Error('self-test: a larger population must have a smaller unpaired floor');
  }

  // **The fixture that gives this file its point.** A class of six in MR: certifiable under the
  // paired test, not under the unpaired one. If someone made one branch an alias of the other, this
  // is the assertion that goes red.
  const six = decide({ classN: 6, population: 121, losses: 0, accuracy: 0.893 });
  if (!six.certifiable)
    throw new Error('self-test: a six-question class must certify under the paired floor');
  if (!(six.unpaired > six.ceiling)) {
    throw new Error(
      `self-test: the unpaired floor must reject the same class (floor ${six.unpaired.toFixed(2)} vs ceiling ${six.ceiling.toFixed(2)})`,
    );
  }

  // And the boundary: five does not certify, so the floor is a floor and not a mood.
  if (decide({ classN: 5, population: 121, losses: 0 }).certifiable) {
    throw new Error('self-test: a five-question class must not certify');
  }

  // Refusals. Each of these would otherwise print a number about nothing.
  const refusals = [
    () => decide({ classN: 9, population: 5 }),
    () => decide({ classN: 3, population: 0 }),
    () => decide({ classN: 3, population: 10, losses: -1 }),
    () => pairedFloor(-1),
    () => unpairedFloor(0.9, 0),
    () => classCeiling(4, 2),
  ];
  for (const [index, attempt] of refusals.entries()) {
    let refused = false;
    try {
      attempt();
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refused = true;
    }
    if (!refused) throw new Error(`self-test: refusal ${index} did not fire`);
  }

  // `remaining` refuses a group it cannot see in full, and reports the split when it can.
  const byId = new Map([
    ['a', { correct: false }],
    ['b', { correct: true }],
    ['c', { correct: false }],
  ]);
  const split = remaining({ name: 'fixture', ids: ['a', 'b', 'c'] }, byId);
  if (split.stillFailing.length !== 2 || split.passed.length !== 1) {
    throw new Error('self-test: a three-id group over three rows must split 2/1');
  }
  let threw = false;
  try {
    remaining({ name: 'fixture', ids: ['a', 'zz'] }, byId);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    threw = true;
  }
  if (!threw) throw new Error('self-test: a group naming an absent id must be refused');

  // The decay reading: a frozen group of eight of which four still fail has a ceiling of 4, which is
  // below the paired floor. `decide` must say so rather than print a ceiling as if it were a reach.
  const decayed = decide({ classN: 4, population: 121, losses: 0 });
  if (decayed.certifiable)
    throw new Error('self-test: a decayed group below the floor must not read certifiable');

  process.stdout.write(
    'self-test: p(6,0)=0.03125, floor table 6/8/10/12, unpaired 7.87 points = 9.5 questions, ' +
      'six certifies and five does not, 6 refusals, 1 absent-id refusal, 1 decayed group\n',
  );
}

function main(argv) {
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  try {
    const classN = flag('--class', undefined);
    if (classN !== undefined) {
      const result = decide({
        classN: Number(classN),
        population: Number(flag('--population', undefined)),
        losses: Number(flag('--losses', '0')),
        accuracy: flag('--accuracy', undefined) === undefined ? null : Number(flag('--accuracy')),
      });
      process.stdout.write(
        `class ${result.classN} of ${result.population} = ${result.ceiling.toFixed(2)} points ceiling\n` +
          `paired floor at ${result.losses} loss(es): ${result.floor} gains = ${result.floorPoints.toFixed(2)} points\n` +
          `unpaired floor at ${result.population}: ${result.unpaired === null ? 'n/a' : `${result.unpaired.toFixed(2)} points`}\n` +
          `verdict: ${result.certifiable ? 'certifiable' : 'refused'}\n`,
      );
      return result.certifiable ? 0 : 1;
    }

    const artifact = flag('--artifact', undefined);
    const groupsPath = flag('--groups', undefined);
    if (artifact === undefined || groupsPath === undefined) {
      process.stderr.write(USAGE);
      return 1;
    }
    const byId = readRows(artifact);
    const groups = JSON.parse(readFileSync(groupsPath, 'utf8'));
    const reading = decay(groups, byId);
    const accuracy = flag('--accuracy', undefined);
    process.stdout.write(
      `${renderDecay(reading, accuracy === undefined ? null : Number(accuracy)).join('\n')}\n`,
    );
    const floorPoints = classCeiling(pairedFloor(0), reading.population);
    return reading.rows.some((row) => row.remaining > 0 && row.ceiling < floorPoints) ? 1 : 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
}

// Entry-point guard: this file is imported by `repo-gates.test.ts` and by ad-hoc readings, and a CLI
// that runs on import would print usage into every one of them. The comparison is on the resolved URL
// rather than on `argv[1]`'s basename, so a symlinked or relative invocation still runs it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
