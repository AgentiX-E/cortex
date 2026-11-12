#!/usr/bin/env node
/**
 * How many of an artifact's wrong answers are the *old* value, and whether the new one was even delivered.
 *
 * ## Why this is a separate census from `reply-shape-census.mjs`
 *
 * That tool asks what shape a reply took; this one asks what a wrong reply **contains**. They answer different
 * questions on the same artifact and neither can be derived from the other: a reply can be perfectly shaped and
 * carry a superseded value (`852ce960` answers `$350,000` in one clean line), and a reply can be a stamped list
 * whose last line is correct.
 *
 * `MEASURE-KU-STALE.md` is the reading this tool makes repeatable: all nine `KU` failures on `42533236864`
 * answered with the value the corpus stated **earlier**, and the string each reply gave is present in the delivered
 * window in all nine. That splits the population into two mechanisms which need different repairs --
 *
 *   - **stale twin**: the newer value was also in the window, so the reader had both and returned the older one.
 *     No retrieval change and no prompt sentence reaches this; only the rendering does, by no longer presenting
 *     the superseded turn as an equal.
 *   - **undelivered**: the newer value never arrived, so this is retrieval's to fix.
 *
 * A table that printed only "9 wrong" would support neither decision.
 *
 * ## Why the test is a token match and not a semantic one
 *
 * Presence is what this measures, and presence is decidable without a model: normalise both sides, then require
 * the answer to appear as a whole token so that `37` is not found inside `1370`. That is narrower than "the reader
 * saw this value" -- it does not catch a paraphrase, and it does not catch a value spelled differently in the
 * corpus -- so every count here is a **lower bound** on the mechanism, which is the direction a census should err
 * in when its purpose is to refuse work.
 *
 * Usage: `node tools/ku-stale-census.mjs <report.json> [...more] [--capability KU]`
 */

import { readFileSync } from 'node:fs';

/** The capability whose defining property is a value stated twice, once later than the first. */
const DEFAULT_CAPABILITY = 'KU';

/**
 * Lowercase and drop everything that is not a letter or a digit.
 *
 * Both sides go through this, so `$350,000`, `350000` and `350, 000` become one string and a currency mark cannot
 * decide the census. It also means `3-2` and `3 2` collapse together, which is the same reading: the corpus writes
 * a score both ways.
 */
function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The window as an ordered list of maximal alphanumeric runs.
 *
 * **A flat string cannot be searched for a short value.** `37` inside `1370` is why the boundary matters, and the
 * boundary only exists if the separators survive normalisation -- the first version of this file flattened the
 * window to one string of digits and letters, so every `(^|[^a-z0-9])` test failed and all nine rows came back
 * `neither`. Tokens keep the boundary and still let a written value be reassembled: `$350,000` is two tokens that
 * concatenate to the same string as `350000` is one.
 */
function tokens(text) {
  return (
    String(text ?? '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

/**
 * True when `needle` appears in `haystackTokens` as a run of whole tokens.
 *
 * The run has to start on a token boundary and end on one, which is the property a flat `includes` loses. Partial
 * tokens are never accepted: `37` does not match inside `1370` because `1370` is one token and `37` is not its
 * prefix.
 */
function carries(haystackTokens, needle) {
  const target = normalise(needle);
  if (target.length === 0) return false;
  for (let index = 0; index < haystackTokens.length; index += 1) {
    // Cheap rejection: the run cannot begin mid-token, so the first token must be a prefix of the target.
    if (!target.startsWith(haystackTokens[index])) continue;
    let acc = '';
    let at = index;
    while (at < haystackTokens.length && acc.length < target.length) {
      acc += haystackTokens[at];
      at += 1;
    }
    if (acc === target) return true;
  }
  return false;
}

/** Every delivered turn's text, tokenised in the order the prompt carried it. */
function windowText(question) {
  const turns = Array.isArray(question.turns) ? question.turns : [];
  return tokens(turns.map((turn) => turn.text ?? '').join('\n'));
}

/**
 * Classify one wrong record.
 *
 * `stale-twin` requires the *newer* value to be the gold, which is true for every `KU` question by construction:
 * the dataset's answer is the post-update value. A question whose gold is not an update therefore cannot be read
 * here, which is why the caller defaults the capability to `KU` rather than running over all 500.
 */
export function classifyWrong(question) {
  const window = windowText(question);
  const answerInWindow = carries(window, question.answer ?? '');
  const goldInWindow = carries(window, question.groundTruth ?? '');
  if (answerInWindow && goldInWindow) return 'stale-twin';
  if (answerInWindow && !goldInWindow) return 'undelivered';
  if (!answerInWindow && goldInWindow) return 'wrong-value';
  return 'neither';
}

/** The four states, in the order a reader should read them: the two mechanisms first. */
const STATES = ['stale-twin', 'undelivered', 'wrong-value', 'neither'];

/**
 * One artifact's reading: how many are wrong, and how the wrong ones split.
 *
 * `right` is reported beside `wrong` because the split is only interpretable against it -- a capability whose 72
 * questions are 63 right and 9 stale twins is a capability with one defect, and a table of the 9 alone would look
 * like a capability in trouble.
 */
export function census(report, capability = DEFAULT_CAPABILITY) {
  const rows = (report.questions ?? []).filter((question) => question.capability === capability);
  const wrong = rows.filter((question) => !question.correct);
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  const named = [];
  for (const question of wrong) {
    const state = classifyWrong(question);
    counts[state] += 1;
    named.push({
      questionId: question.questionId,
      state,
      answer: question.answer ?? '',
      gold: question.groundTruth ?? '',
    });
  }
  const answeredOldValue = counts['stale-twin'] + counts['undelivered'];
  return {
    capability,
    questions: rows.length,
    right: rows.length - wrong.length,
    wrong: wrong.length,
    counts,
    /** The one number a treatment is registered against: wrong answers that carry the superseded value. */
    answeredOldValue,
    /** Share of the wrong answers that are the old value, which is what makes them one mechanism. */
    oldValueShare: wrong.length === 0 ? 0 : answeredOldValue / wrong.length,
    named,
  };
}

function render(result) {
  const lines = [];
  lines.push(
    `capability ${result.capability}: ${result.right} right, ${result.wrong} wrong of ${result.questions}`,
  );
  for (const state of STATES) {
    lines.push(`  ${state.padEnd(12)} ${String(result.counts[state]).padStart(4)}`);
  }
  const share = (result.oldValueShare * 100).toFixed(1);
  lines.push(
    `  answered with the superseded value: ${result.answeredOldValue} / ${result.wrong} (${share}%)`,
  );
  for (const row of result.named) {
    lines.push(
      `    ${row.questionId} ${row.state} answer=${JSON.stringify(row.answer)} gold=${JSON.stringify(row.gold)}`,
    );
  }
  return lines.join('\n');
}

function main(argv) {
  let capability = DEFAULT_CAPABILITY;
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--capability') {
      capability = argv[index + 1];
      index += 1;
    } else {
      paths.push(argv[index]);
    }
  }
  if (paths.length === 0) {
    console.error(
      'usage: node tools/ku-stale-census.mjs <report.json> [...more] [--capability KU]',
    );
    return 2;
  }
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    console.log(`=== ${path}`);
    console.log(render(census(report, capability)));
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
