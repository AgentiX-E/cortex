#!/usr/bin/env node
/**
 * Which published number may be quoted beside which, and what the spread is when a system is
 * read more than once.
 *
 * ## The problem this exists for
 *
 * LongMemEval-S is a 500-question roster and at least six published systems report a score on
 * it, ranging from 51.8 to 94.4. A table of those numbers sorted descending is the most natural
 * artifact to build and the least useful one: the top four sit within five points, which is
 * less than the effect of changing the answer model, and one system in this ledger is on record
 * at 90.2, 79.8 and 71.2 depending on who ran it. Sorted together they invite a reader to
 * conclude something about the systems when what moved was the harness.
 *
 * So the unit of comparability is a group, not a dataset. Two numbers are ordered only when
 * they agree on all of:
 *
 *   dataset, variant, answer model, judge, harness
 *
 * The first two say what was asked, the middle two say who answered and who marked it, and the
 * last says whose pipeline decided what reached the answer model at all. Any one of them
 * differing makes an ordering an artifact of the difference.
 *
 * ## What `--check` is allowed to refuse
 *
 * Only things that are wrong by construction. A group whose members disagree about the answer
 * model is not a group -- it is two groups sharing a name -- and that is an error. A system read
 * differently by two harnesses is not an error: it is the finding, and the tool prints the
 * spread rather than failing on it. Confusing those two would make the tool refuse the evidence
 * it exists to collect.
 *
 * ## What it deliberately does not do
 *
 * It does not compute a rank across groups, and `--gap` refuses to place this repository's score
 * in a group it does not belong to. The temptation is to say "83.0 would be second in the
 * same-harness table", and that sentence is false: second place in a table whose judge is
 * GPT-4o-mini says nothing about a number produced by a different judge on a different answer
 * model. The honest statement is what `--gap` prints instead -- the distance to the nearest
 * group, and the reason it cannot be closed by arithmetic.
 *
 * ## Usage
 *
 *   node tools/competitor-ledger.mjs                 # one table per comparability group
 *   node tools/competitor-ledger.mjs --check         # invariants; exit 1 on a broken entry
 *   node tools/competitor-ledger.mjs --json          # the same reading as data
 *   node tools/competitor-ledger.mjs --gap 83.0      # where this repository stands, and why
 *   node tools/competitor-ledger.mjs --spread        # how far one system's readings travel
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(HERE, 'competitor-ledger.json');

/** The four provenances, and nothing else. A fifth value would be a number with no owner. */
const KINDS = new Set(['self', 'third', 'harness', 'ours']);

/** Every field a comparable entry must state. `answerModel`/`judge` may be the string `unknown`, which is
 * a claim about the publication rather than a gap in this file: several vendors do not say. */
const REQUIRED = [
  'system',
  'score',
  'dataset',
  'variant',
  'answerModel',
  'judge',
  'harness',
  'kind',
  'source',
];

/**
 * The five-tuple that decides comparability.
 *
 * `harness` is part of it rather than derived from `answerModel`/`judge`, because two harnesses
 * can share both and still differ in what they retrieve, how they truncate, and what they call a
 * correct answer. Grouping on the tuple is therefore coarser than grouping on the pair, which is
 * the safe direction: it can split a table that was in fact comparable, and it cannot merge two
 * that were not.
 */
export function groupKey(entry) {
  return [entry.dataset, entry.variant, entry.answerModel, entry.judge, entry.harness].join('|');
}

/** Groups by `dataset|variant|harness`, the coarser key a reader thinks in, and keeps the members. */
export function byHarness(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = [entry.dataset, entry.variant, entry.harness].join('|');
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

/**
 * The validation rules, returned rather than thrown so `--check` can report every problem at once.
 *
 * A tool that stops at the first bad entry makes the author fix them one restart at a time, and an
 * author who has to restart five times deletes the check.
 */
export function problems(entries) {
  const found = [];
  entries.forEach((entry, index) => {
    const where =
      `entries[${index}] ${entry.system ?? '(no system)'} ${entry.harness ?? ''}`.trim();
    for (const field of REQUIRED) {
      const value = entry[field];
      if (value === undefined || value === null || value === '') {
        found.push(`${where}: missing ${field}`);
      }
    }
    if (entry.kind !== undefined && !KINDS.has(entry.kind)) {
      found.push(
        `${where}: kind ${JSON.stringify(entry.kind)} is not one of ${[...KINDS].join('/')}`,
      );
    }
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) {
      found.push(`${where}: score is not a number`);
    } else if (entry.score < 0 || entry.score > 100) {
      // A percentage outside the range is a decimal in percent's clothing, which is the one
      // transcription error that looks like a plausible number.
      found.push(`${where}: score ${entry.score} is outside 0-100`);
    }
  });

  // A group is one harness's table, so it can only have one answer model and one judge. If two
  // members disagree, the group name is claiming a shared condition that does not exist -- and a
  // reader who sorts the group will be ordering numbers that were never on the same scale.
  for (const [key, members] of byHarness(entries)) {
    for (const field of ['answerModel', 'judge']) {
      const values = new Set(members.map((member) => member[field]));
      if (values.size > 1) {
        found.push(
          `${key}: members disagree about ${field} (${[...values].join(', ')}), so this is not one ` +
            'harness -- split the harness field or drop the row',
        );
      }
    }
    if (members.every((member) => member.kind === 'harness') && members.length < 3) {
      // One system run by its own authors and labelled `harness` is a self-report with a better
      // name. The label earns itself by the systems it covers.
      found.push(
        `${key}: labelled a same-harness reading but carries ${members.length} system(s); a harness ` +
          "that ran one system is that system's own report",
      );
    }
  }
  return found;
}

/** How far a system's published readings travel, across every harness that read it. */
export function spreads(entries) {
  const bySystem = new Map();
  for (const entry of entries) {
    if (entry.kind === 'ours') continue;
    const key = `${entry.system}|${entry.dataset}|${entry.variant}`;
    const list = bySystem.get(key) ?? [];
    list.push(entry);
    bySystem.set(key, list);
  }
  const out = [];
  for (const [key, list] of bySystem) {
    if (list.length < 2) continue;
    const scores = list.map((entry) => entry.score);
    // Whether the readings came from more than one harness decides how the spread may be read.
    // Two versions of one system measured by one set of authors is a release difference; the same
    // build read by two harnesses is the harness effect. Reporting both under one heading would
    // let a 1.0-point version drift be quoted as evidence that "harness effects are small".
    const harnesses = new Set(list.map((entry) => entry.harness));
    out.push({
      system: list[0].system,
      // The dataset is part of the row because one system can have a spread on each, and two rows
      // reading `Zep 19.0` and `Zep 30.9` with nothing between them would look like an arithmetic
      // error rather than two datasets.
      dataset: list[0].dataset,
      readings: list.map((entry) => ({
        score: entry.score,
        harness: entry.harness,
        kind: entry.kind,
        judge: entry.judge,
        answerModel: entry.answerModel,
      })),
      min: Math.min(...scores),
      max: Math.max(...scores),
      spread: Math.max(...scores) - Math.min(...scores),
      acrossHarnesses: harnesses.size > 1,
      harnessCount: harnesses.size,
    });
  }
  // Harness differences first: a version drift sorted above them would be read as the bigger
  // finding when it is the smaller one.
  return out.sort(
    (a, b) => Number(b.acrossHarnesses) - Number(a.acrossHarnesses) || b.spread - a.spread,
  );
}

/**
 * Places `ours` in the group it belongs to, and says why it cannot be placed anywhere else.
 *
 * The return value states the two facts a reader needs and a ranking would hide: whether a group
 * exists whose five-tuple matches this one, and -- when none does -- the nearest group and the
 * field that differs. Reporting only the first would let a caller treat "no group" as "unranked"
 * and then quote a rank from the nearest one anyway.
 */
export function gap(entries, ours) {
  const mine = groupKey(ours);
  const groups = new Map();
  for (const entry of entries) {
    if (entry.kind === 'ours') continue;
    const key = groupKey(entry);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const exact = groups.get(mine);
  if (exact) {
    const sorted = [...exact].sort((a, b) => b.score - a.score);
    const ahead = sorted.filter((entry) => entry.score > ours.score).length;
    return { comparable: true, group: mine, rank: ahead + 1, of: sorted.length, members: sorted };
  }
  // No group shares all five fields. Name the nearest by the number of fields that agree, so the
  // reason is inspectable rather than asserted -- and name ALL the tied ones, because "the nearest
  // group" is usually not unique and picking one by map order would make the reported distance a
  // property of the file's key ordering.
  const FIELDS = ['dataset', 'variant', 'answerModel', 'judge', 'harness'];
  const mineFields = mine.split('|');
  const ranked = [...groups.keys()].map((key) => {
    const fields = key.split('|');
    return { key, fields, agree: fields.filter((value, i) => value === mineFields[i]).length };
  });
  const best = ranked.reduce((max, row) => Math.max(max, row.agree), -1);
  const nearest = ranked
    .filter((row) => row.agree === best)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => ({
      key: row.key,
      differing: row.fields
        .map((value, i) => ({ field: FIELDS[i], theirs: value, ours: mineFields[i] }))
        .filter((pair) => pair.theirs !== pair.ours),
    }));
  return { comparable: false, group: mine, nearest, differing: nearest[0]?.differing ?? [] };
}

function renderTable(group, entries) {
  const [dataset, variant, harness] = group.split('|');
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const lines = [
    `\n${dataset}-${variant}  harness ${harness}`,
    `  answer model ${sorted[0].answerModel}  judge ${sorted[0].judge}`,
    '',
  ];
  for (const entry of sorted) {
    lines.push(
      `  ${entry.score.toFixed(2).padStart(6)}  ${entry.system.padEnd(16)} ${entry.kind.padEnd(8)} ${entry.source}`,
    );
  }
  return lines.join('\n');
}

export function render(entries) {
  const lines = [];
  lines.push('Comparability is a five-tuple: dataset | variant | answer model | judge | harness.');
  lines.push(
    'Numbers are ordered only inside one group. Across groups this prints distributions, not ranks.',
  );
  for (const [key, members] of [...byHarness(entries)].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(renderTable(key, members));
  }

  const travel = spreads(entries);
  if (travel.length) {
    lines.push("\nHow far one system's published readings travel:");
    for (const row of travel) {
      const cause = row.acrossHarnesses
        ? `across ${row.harnessCount} harnesses`
        : 'within one harness -- a version difference, not a harness effect';
      lines.push(
        `  ${row.system.padEnd(16)} ${row.dataset.padEnd(5)} ${row.spread.toFixed(1).padStart(5)} pt across ${row.readings.length} readings, ${cause}`,
      );
      for (const reading of row.readings) {
        lines.push(
          `      ${reading.score.toFixed(2).padStart(6)}  ${reading.harness} [${reading.kind}]`,
        );
      }
    }
    lines.push('');
    lines.push(
      '  A spread here is not a mistake by one of the readings. It is the size of the effect',
    );
    lines.push(
      '  that changing the harness has, measured on one system, which is why no number in',
    );
    lines.push('  this ledger is quoted without the harness beside it.');
  }
  return lines.join('\n');
}

function main(argv) {
  const args = new Set(argv.filter((arg) => arg.startsWith('--')));
  const gapIndex = argv.indexOf('--gap');
  const oursFlag = gapIndex === -1 ? null : Number(argv[gapIndex + 1]);

  // `--ledger` exists so the checks can be demonstrated on a deliberate defect. Without it the only
  // way to test a refusal would be to break the real file and restore it, which is how a check ends
  // up never being tested at all.
  const ledgerIndex = argv.indexOf('--ledger');
  const ledgerPath = ledgerIndex === -1 ? LEDGER : argv[ledgerIndex + 1];
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    console.error(`${ledgerPath}: ${error.message}`);
    return 2;
  }
  const entries = ledger.entries;
  if (!Array.isArray(entries)) {
    console.error(`${ledgerPath}: no entries array`);
    return 2;
  }

  if (args.has('--help')) {
    console.log(
      [
        'node tools/competitor-ledger.mjs [--check] [--json] [--spread] [--gap <score>] [--ledger <path>]',
        '',
        '  (no flag)      one table per comparability group, then the spread of each system',
        '  --check        validate every entry; exit 1 on a problem, listing all of them',
        '  --json         the same reading as data, for a document that must not drift',
        '  --spread       only the how-far-readings-travel block',
        '  --gap <score>  place a score of ours in the group it belongs to, or say why none does',
      ].join('\n'),
    );
    return 0;
  }

  const found = problems(entries);
  if (args.has('--check')) {
    for (const problem of found) console.log(`  ${problem}`);
    console.log(
      found.length
        ? `\n${found.length} problem(s) in ${entries.length} entries`
        : `\n${entries.length} entries, every group agrees with itself`,
    );
    return found.length ? 1 : 0;
  }
  if (found.length) {
    // Not a silent pass: an unvalidated ledger is a table of numbers nobody checked, and the
    // tables below would read as if it had been.
    for (const problem of found) console.error(`  ${problem}`);
    console.error('\nrefusing to print tables from an invalid ledger; run --check');
    return 1;
  }

  if (args.has('--json')) {
    const groups = {};
    for (const [key, members] of byHarness(entries)) {
      groups[key] = [...members]
        .sort((a, b) => b.score - a.score)
        .map((entry) => ({
          system: entry.system,
          score: entry.score,
          kind: entry.kind,
          source: entry.source,
        }));
    }
    console.log(JSON.stringify({ groups, spreads: spreads(entries) }, null, 2));
    return 0;
  }

  if (args.has('--spread')) {
    const travel = spreads(entries);
    for (const row of travel) {
      console.log(
        `${row.system}  ${row.dataset}  spread ${row.spread.toFixed(1)}  (${row.min} .. ${row.max})`,
      );
    }
    return 0;
  }

  console.log(render(entries));

  if (oursFlag !== null) {
    if (!Number.isFinite(oursFlag)) {
      console.error(`--gap needs a number, got ${JSON.stringify(argv[gapIndex + 1])}`);
      return 2;
    }
    const where = gap(entries, {
      score: oursFlag,
      dataset: 'LongMemEval',
      variant: 'S',
      answerModel: 'DeepSeek',
      judge: 'cortex-judge',
      harness: 'cortex-ablation-40989420944',
    });
    if (where.comparable) {
      console.log(`\n${oursFlag} is in group ${where.group}: rank ${where.rank} of ${where.of}`);
    } else {
      console.log(`\n${oursFlag} has no comparable group.`);
      console.log(
        `  ${where.nearest.length} group(s) are equally near, and none of them shares all five fields:`,
      );
      for (const row of where.nearest) {
        console.log(`    ${row.key}`);
        for (const pair of row.differing) {
          console.log(`      ${pair.field.padEnd(12)} theirs ${pair.theirs}  ours ${pair.ours}`);
        }
      }
      console.log(
        '  So no rank is reported. A rank computed across these differences would be a fact about\n' +
          '  the harnesses and would be read as a fact about the systems.',
      );
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
