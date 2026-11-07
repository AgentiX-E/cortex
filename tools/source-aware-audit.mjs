#!/usr/bin/env node
/**
 * Split every wrong answer into "the evidence never arrived" and "the reader did not use it".
 *
 * ## The row this exists to fill
 *
 * `docs/SOTA-LANDSCAPE.md` carried, for four rounds, a row that read
 *
 *     accuracy, source-aware grading | not measured | MemStrata 95.0% | unmeasured — we do not
 *     report this protocol, so the comparison does not exist
 *
 * and the honest reading of that sentence is that a *grading-side* implementation was missing, not
 * that the comparison was impossible. The protocol needs the question, the gold and the source; all
 * three are in the artifact this repository already writes (`groundTruth`, `question`, `turns`).
 *
 * ## Two scopes, because they answer two different questions
 *
 * `--scope delivered` audits the gold against **the turns the arm actually put in front of the
 * reader**. That is not the published protocol and this tool says so on every run: a gold absent from
 * the delivered packet may still be present in the full conversation, so lexical-absence is a
 * **lower bound** on unreachability, never a verdict. What it buys is the one diagnostic this
 * campaign has never had -- a wrong answer that the delivered evidence could not have supported is a
 * retrieval failure, and a wrong answer whose gold *was* delivered is a reader failure, and those two
 * are repaired in different subsystems. Every round so far has argued about which one it was from
 * aggregate accuracy.
 *
 * `--scope source` audits against the whole conversation, which is the published shape. It needs
 * `--dataset`, because the artifact deliberately does not carry 24,000 characters of context per
 * question.
 *
 * ## Why the lexical pass runs before the LLM pass
 *
 * The lexical test costs nothing and bounds the answer from below. If a large share of wrong answers
 * have gold the delivered packet does not contain, the LLM audit has nothing to add and the repair is
 * retrieval. If almost every wrong answer *does* carry its gold, the LLM audit is still worth running
 * -- because the lexical test cannot see a gold that is present but paraphrased -- and the repair is
 * the reader. Running the free test first is what keeps 500 audit calls from being spent on a
 * question the free test already answered.
 *
 * ## Usage
 *
 *     node tools/source-aware-audit.mjs <artifact.json> [--scope delivered|source]
 *                                        [--dataset <longmemeval.json>] [--json] [--top <n>]
 */

import { readFileSync } from 'node:fs';

/** Normalise text for a substring test: case, punctuation and whitespace are not evidence. */
function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `gold` appears in `haystack` after normalisation.
 *
 * A gold that is a pure number is tested as a whole token rather than as a substring: `3` is inside
 * `13` and inside `2023`, and a count question whose gold is `3` would otherwise be "reachable" from
 * any date in the packet. This is the same distinction `§13.18.2` paid for on `groundTruth` matching,
 * where `groundTruth` of `3` matched `3. **Humidity:**` -- a list marker and a cardinality are the
 * same token.
 */
function containsGold(haystack, gold) {
  const needle = normalise(gold);
  if (needle.length === 0) {
    return false;
  }
  if (/^\d+(\.\d+)?$/.test(needle)) {
    return new RegExp(`(?:^|[^\\p{N}.])${needle.replace('.', '\\.')}(?:$|[^\\p{N}.])`, 'u').test(
      normalise(haystack),
    );
  }
  return normalise(haystack).includes(needle);
}

/** Read the artifact, refusing anything that is not the report this tool reads. */
function loadArtifact(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} is not an object`);
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error(
      `${path} carries no per-question records -- this tool reads the artifact's \`questions\` array, ` +
        'and a report without one cannot be audited',
    );
  }
  return parsed;
}

/**
 * Audit one artifact's questions against the delivered evidence.
 *
 * A question is skipped when its gold is `null` (an abstention question has no answer to audit) or
 * when `turns` is absent or empty (there is no evidence to test against, and counting that as
 * "unreachable" would blame the dataset for a capture the arm did not make).
 */
function auditDelivered(questions) {
  const rows = [];
  for (const record of questions) {
    if (record.groundTruth === null || record.groundTruth === undefined) {
      continue;
    }
    const turns = Array.isArray(record.turns) ? record.turns : [];
    if (turns.length === 0) {
      continue;
    }
    const haystack = turns.map((turn) => turn.text ?? '').join('\n');
    rows.push({
      questionId: record.questionId,
      capability: record.capability,
      correct: record.correct === true,
      grounded: containsGold(haystack, record.groundTruth),
      gold: record.groundTruth,
      answer: record.answer ?? null,
    });
  }
  return rows;
}

/** Cross-tabulate correctness against lexical reachability, per capability and overall. */
function crossTabulate(rows) {
  const cell = () => ({ reachable: 0, unreachable: 0 });
  const overall = { correct: cell(), incorrect: cell() };
  const byCapability = new Map();
  for (const row of rows) {
    const bucket = row.correct ? overall.correct : overall.incorrect;
    bucket[row.grounded ? 'reachable' : 'unreachable'] += 1;
    const per = byCapability.get(row.capability) ?? { correct: cell(), incorrect: cell() };
    const perBucket = row.correct ? per.correct : per.incorrect;
    perBucket[row.grounded ? 'reachable' : 'unreachable'] += 1;
    byCapability.set(row.capability, per);
  }
  return { overall, byCapability, audited: rows.length };
}

/** Pad a label to a fixed width, so the tables line up without a dependency. */
function pad(text, width) {
  return String(text).padEnd(width);
}

/** Percent with one decimal, and `n/a` rather than `NaN` on an empty denominator. */
function pct(numerator, denominator) {
  return denominator === 0 ? 'n/a' : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

const argv = process.argv.slice(2);
const path = argv.find((arg) => !arg.startsWith('--'));
if (path === undefined) {
  process.stderr.write(
    'usage: node tools/source-aware-audit.mjs <artifact.json> [--scope delivered|source]\n' +
      '                                          [--dataset <file>] [--json] [--top <n>]\n',
  );
  process.exit(2);
}
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const scope = flag('scope', 'delivered');
const topN = Number(flag('top', '8'));

if (scope !== 'delivered') {
  // Not a stub, a refusal with the reason: the source scope needs the dataset file, and pretending
  // to audit 24,000-character contexts from an artifact that does not carry them would be the
  // fabricated-number failure this whole campaign is about.
  process.stderr.write(
    `--scope ${scope} is not implemented in this tool yet.\n` +
      'It needs the dataset file, because the artifact deliberately does not carry the full\n' +
      'conversation. The LLM auditor for it exists -- `auditReference` in\n' +
      'packages/cortex-eval/src/source-aware.ts -- and what is missing is the dispatch that hands it\n' +
      'the dataset, not the mechanism.\n' +
      'Run with --scope delivered (the default) to read the lower bound this artifact supports.\n',
  );
  process.exit(2);
}

const artifact = loadArtifact(path);
const rows = auditDelivered(artifact.questions);
const table = crossTabulate(rows);

if (argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify(
      {
        artifact: path,
        dataset: artifact.dataset ?? null,
        scope,
        audited: table.audited,
        overall: table.overall,
        byCapability: Object.fromEntries(table.byCapability),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const totalIncorrect = table.overall.incorrect.reachable + table.overall.incorrect.unreachable;
process.stdout.write(
  '\nGold reachability against the DELIVERED packet (lexical lower bound, not the published protocol)\n' +
    '------------------------------------------------------------------------------------------\n' +
    `artifact   ${path}\n` +
    `dataset    ${artifact.dataset ?? '(unset)'}\n` +
    `audited    ${table.audited} questions with a non-null gold and at least one delivered turn\n` +
    `skipped    ${artifact.questions.length - table.audited} abstention or turn-less questions\n\n`,
);

process.stdout.write(
  `${pad('', 12)}${pad('gold delivered', 16)}${pad('gold absent', 16)}total\n`,
);
process.stdout.write(
  `${pad('correct', 12)}${pad(table.overall.correct.reachable, 16)}${pad(
    table.overall.correct.unreachable,
    16,
  )}${table.overall.correct.reachable + table.overall.correct.unreachable}\n`,
);
process.stdout.write(
  `${pad('incorrect', 12)}${pad(table.overall.incorrect.reachable, 16)}${pad(
    table.overall.incorrect.unreachable,
    16,
  )}${totalIncorrect}\n\n`,
);

const totalCorrect = table.overall.correct.reachable + table.overall.correct.unreachable;
const absentAmongCorrect = table.overall.correct.unreachable;
const absentAmongIncorrect = table.overall.incorrect.unreachable;

// The comparison that carries information, and the one that does not.
//
// The first run of this tool on `42355323615` printed `retrieval 27 of 43` and invited the reading
// "63% of the errors are retrieval failures". That reading is wrong, and the artifact says so in the
// same table: **196 of 427 correct answers also have a lexically absent gold**. Aggregation questions
// are why -- the gold is the sentence `I attended four movie festivals.` and the packet holds four
// separate turns about four separate festivals, so no substring test can ever find it. Lexical
// absence is therefore the *normal* state on this benchmark, and the absolute count of absent golds
// among errors says almost nothing.
//
// What does carry information is the RATE DIFFERENCE: absence is 45.9% of correct answers and 62.8%
// of wrong ones, so an absent gold is associated with being wrong without being a diagnosis. A tool
// that printed only the absolute counts would have produced a confident and misleading conclusion,
// which is the failure mode this whole campaign is built to avoid -- so both rates are printed and
// the difference is printed between them.
process.stdout.write(
  `Absence is not a defect signal on its own, and the artifact proves it: ` +
    `${absentAmongCorrect} of ${totalCorrect} CORRECT answers also have a lexically absent gold ` +
    `(${pct(absentAmongCorrect, totalCorrect)}). Aggregation golds -- ` +
    '"I attended four movie festivals." against four separate turns -- cannot be found by any ' +
    `substring test. Read the RATE DIFFERENCE below, not the absolute counts.\n\n`,
);

process.stdout.write(
  `${pad('', 14)}${pad('gold absent', 14)}${pad('rate', 10)}\n` +
    `${pad('correct', 14)}${pad(absentAmongCorrect, 14)}${pad(pct(absentAmongCorrect, totalCorrect), 10)}\n` +
    `${pad('incorrect', 14)}${pad(absentAmongIncorrect, 14)}${pad(pct(absentAmongIncorrect, totalIncorrect), 10)}\n\n`,
);

process.stdout.write(
  `Wrong answers by the mechanism that would have to move:\n` +
    `  reader     ${table.overall.incorrect.reachable} of ${totalIncorrect} (${pct(
      table.overall.incorrect.reachable,
      totalIncorrect,
    )}) had their gold lexically present and were still wrong\n` +
    `  retrieval  ${table.overall.incorrect.unreachable} of ${totalIncorrect} (${pct(
      table.overall.incorrect.unreachable,
      totalIncorrect,
    )}) had no lexical trace of it -- which is NOT the same as it being absent\n\n`,
);

process.stdout.write(`${pad('capability', 12)}${pad('n', 6)}${pad('reader', 10)}${pad('retrieval', 10)}${pad('reach%', 10)}wrong\n`);
for (const [capability, per] of [...table.byCapability].sort((a, b) => a[0].localeCompare(b[0]))) {
  const wrong = per.incorrect.reachable + per.incorrect.unreachable;
  const n = wrong + per.correct.reachable + per.correct.unreachable;
  process.stdout.write(
    `${pad(capability, 12)}${pad(n, 6)}${pad(per.incorrect.reachable, 10)}${pad(
      per.incorrect.unreachable,
      10,
    )}${pad(pct(per.correct.reachable + per.incorrect.reachable, n), 10)}${wrong}\n`,
  );
}

const missed = rows
  .filter((row) => !row.correct && !row.grounded)
  .slice(0, topN);
if (missed.length > 0) {
  process.stdout.write(`\n${topN} wrong answers whose gold the packet never carried:\n`);
  for (const row of missed) {
    const gold = String(row.gold).replace(/\s+/g, ' ').slice(0, 48);
    const answer = String(row.answer ?? '(declined)').replace(/\s+/g, ' ').slice(0, 40);
    process.stdout.write(`  ${pad(row.capability, 4)}${pad(row.questionId, 14)}gold=${pad(`"${gold}"`, 52)}answer="${answer}"\n`);
  }
}

process.stdout.write(
  '\nThis is a LOWER BOUND on unreachability: a gold that is present but paraphrased fails a\n' +
    'lexical test and would pass the published source-aware audit. The published protocol is\n' +
    '`auditReference` in packages/cortex-eval/src/source-aware.ts, which needs the dataset and a\n' +
    'model; what this tool contributes is the half that costs nothing and has to be read first.\n',
);
