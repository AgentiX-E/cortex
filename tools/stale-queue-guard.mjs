#!/usr/bin/env node
/**
 * A round's queue head must not name a mechanism the retraction ledger already closed.
 *
 *     node tools/stale-queue-guard.mjs [--check|--self-test] [--json]
 *                                      [--report <path>] [--retractions <path>]
 *
 * ## The failure this prevents, which has now happened for fifteen rounds
 *
 * `RETRACTIONS.md` §1 closed the resolution-layering family (C7) on 2026-11-19: the consequence table was
 * executed, the repository variable was reset to `raw`, and the mechanism was left in place only as a
 * documented, non-default option. Yet rounds §217–§231 kept writing the exact same line:
 *
 *     5. **SOTA remaining path** queue head `resolution: raw` ¥3.57/1.5h ... (needs dispatch, not moved this round)
 *
 * A queue head that names a closed family is not a plan. It is a stale pointer that makes every reader —
 * including the author — believe work remains when it was finished and written down. Worse, it is self-
 * reinforcing: each round copies the previous round's line, so the error survives as long as nobody reads
 * the retraction ledger. `prereg-status.mjs` already guards decided registrations cited as plans inside
 * `PREREG*.md`; the tracking report's "queue head" sentence was the uncovered surface.
 *
 * ## The mechanism
 *
 * A retraction declares a machine-readable key in an HTML comment next to the section that closed it:
 *
 *     <!-- retracted: resolution -->
 *
 * The guard reads the **latest numbered section** of the tracking report (older rounds are history, not
 * plans), takes the sentences that name a queue head, and extracts back-ticked experiment keys. If a key
 * is in the retraction set and the sentence does not acknowledge the closure (result/closed/refut + the
 * Chinese equivalents), that is a finding. A ledger with no markers at all is a hard failure: a gate that
 * silently passes when its input is unmarked can be bypassed by deleting a comment.
 *
 * The key is the token before `:` so `resolution: raw` names `resolution` — the family that was closed,
 * not the default that replaced it. This is deliberate: naming `raw` in a queue head is exactly how the
 * stale pointer disguised itself.
 *
 * `--self-test` runs the pure functions over in-memory fixtures, so each rule can be violated without a
 * temporary directory and without the rules seeing the repository they are normally pointed at.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { locate } from './workspace-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const RETRACTED = /<!--\s*retracted:\s*([a-z0-9_-]+)\s*-->/gi;
/** The first sub-section of a round: `### 231.1 ...`. Every round in the report starts at `.1`. */
const ROUND_START = /^###\s+\d+\.1[^0-9]/gm;
const HEAD_PHRASE = /queue head|队头/i;
const BACKTICK = /`([^`]+)`/g;
/** Words that make a mention a citation of a closed result, not a fresh plan. */
const ACKNOWLEDGE =
  /\b(result|decided|reading|refut|falsif|closed|retract|no longer|already done)\b|已撤回|撤回|已关闭|关闭|已结束|不再|已证伪/i;

/** The family key of a back-ticked token: `resolution: raw` -> `resolution`. */
export function familyKey(token) {
  return token
    .split(':')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

/** Every retracted key declared in a retraction ledger, sorted and de-duplicated. */
export function retractedKeys(text) {
  return [...new Set([...text.matchAll(RETRACTED)].map((m) => m[1].toLowerCase()))].sort();
}

/**
 * The text of the **latest round**, from its `### NNN.1` start to the end of the file. Only the newest
 * round's queue head is a plan; every earlier round is history. Using the whole round (not just the last
 * sub-section) matters: the queue head lives in the "six questions" sub-section, which is not always the
 * final one — a "maturity/SOTA verdict" sub-section often follows it. Taking the last `###` heading would
 * skip the very sentence under test. Returns the whole text when no round start exists, so a malformed
 * report fails closed on findings rather than silently skipping the check.
 */
export function latestSection(text) {
  const matches = [...text.matchAll(ROUND_START)];
  if (matches.length === 0) return text;
  return text.slice(matches[matches.length - 1].index);
}

/** Lines in a section that name a queue head. */
export function headLines(section) {
  return section.split('\n').filter((line) => HEAD_PHRASE.test(line));
}

/**
 * Whether a character offset sits inside a paired delimiter. An audit must be able to describe the stale
 * head ("the report wrote `resolution: raw` as the head", or "the stale head (`resolution: raw`)") without
 * being flagged as naming it as a plan. A token inside quotes or parentheses is a citation of, or an
 * aside about, the thing under discussion; a plan states the head in bare prose. Only matched pairs count,
 * so a lone opening delimiter is not treated as swallowing the rest of the line. CJK and ASCII pairs are
 * both covered because the tracking report is Chinese and the fixtures/design docs are English.
 */
export function withinQuotes(line, offset) {
  const pairs = [
    ['“', '”'],
    ['「', '」'],
    ['（', '）'],
    ['(', ')'],
    ['【', '】'],
    ['[', ']'],
    ['"', '"'],
  ];
  for (const [open, close] of pairs) {
    let from = 0;
    while (from < line.length) {
      const start = line.indexOf(open, from);
      if (start === -1) break;
      const end = line.indexOf(close, start + open.length);
      if (end === -1) break;
      if (offset > start && offset < end) return true;
      from = end + close.length;
    }
  }
  return false;
}

/**
 * Findings over an in-memory `{ report, retractions }` pair. Pure, so self-test can build violations.
 * Returns `{ keys, findings }`; `keys` is the retraction set, useful in `--json`.
 */
export function census({ report, retractions }) {
  const keys = retractedKeys(retractions);
  const findings = [];
  if (keys.length === 0) {
    findings.push({
      rule: 'no-retraction-markers',
      detail: 'the retraction ledger declares no `<!-- retracted: KEY -->` markers',
    });
    return { keys, findings };
  }
  const section = latestSection(report);
  for (const line of headLines(section)) {
    for (const match of line.matchAll(BACKTICK)) {
      const key = familyKey(match[1]);
      if (key === '' || !keys.includes(key)) continue;
      // A token inside a quoted span is a citation of a past round, not this round's plan.
      if (withinQuotes(line, match.index)) continue;
      if (ACKNOWLEDGE.test(line)) continue;
      findings.push({
        rule: 'retracted-queue-head',
        key,
        detail: `latest queue head \`${match[1]}\` names retracted family \`${key}\``,
      });
    }
  }
  return { keys, findings };
}

function selfTest() {
  const ledger =
    '# Retractions\n\n<!-- retracted: resolution -->\n<!-- retracted: sessionclock -->\n';
  const cases = [
    [
      'retracted key is found',
      census({ retractions: ledger, report: 'queue head `resolution: raw` is pending' }),
      1,
      'retracted-queue-head',
    ],
    [
      'acknowledged citation passes',
      census({ retractions: ledger, report: 'queue head `resolution: raw` is closed (retracted)' }),
      0,
      undefined,
    ],
    [
      'quoted stale head is an audit citation, not a plan',
      census({
        retractions: ledger,
        report: 'the report wrote “queue head `resolution: raw` pending” — now removed',
      }),
      0,
      undefined,
    ],
    [
      'unknown key passes',
      census({ retractions: ledger, report: 'queue head `fresh-mechanism` is pending' }),
      0,
      undefined,
    ],
    [
      'the key before the colon is used',
      census({ retractions: ledger, report: 'queue head `sessionClock: on` is pending' }),
      1,
      'retracted-queue-head',
    ],
    [
      'unmarked ledger fails closed',
      census({ retractions: '# Retractions', report: 'queue head `x` is pending' }),
      1,
      'no-retraction-markers',
    ],
    [
      'only the latest round is a plan',
      census({
        retractions: ledger,
        report:
          '### 220.1 old\nqueue head `resolution: raw` was pending\n### 231.1 new\n### 231.5 six questions\nqueue head `fresh` is pending\n### 231.6 verdict',
      }),
      0,
      undefined,
    ],
    [
      'queue head in a non-final sub-section is still found',
      census({
        retractions: ledger,
        report:
          '### 231.1 new\n### 231.5 six questions\nqueue head `resolution: raw` is pending\n### 231.6 verdict',
      }),
      1,
      'retracted-queue-head',
    ],
  ];
  let failed = 0;
  for (const [name, got, wantCount, wantRule] of cases) {
    const ok =
      got.findings.length === wantCount &&
      (wantRule === undefined || got.findings[0]?.rule === wantRule);
    if (!ok) failed += 1;
    process.stderr.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);
  }
  if (failed > 0) {
    process.stderr.write(`${failed} self-test case(s) failed\n`);
    process.exit(1);
  }
  process.stderr.write('self-test passed\n');
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) {
    process.stderr.write(`${name} requires a PATH\n`);
    process.exit(2);
  }
  return value;
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const reportPath =
    argValue(argv, '--report') ?? locate('cortex-docs/docs/04-execution-tracking-report.md');
  const retractionPath =
    argValue(argv, '--retractions') ?? locate('cortex-docs/docs/RETRACTIONS.md');
  if (reportPath === undefined || retractionPath === undefined) {
    process.stderr.write(
      'could not locate the tracking report and retraction ledger; pass --report and --retractions\n',
    );
    process.exit(2);
  }
  const result = census({
    report: readFileSync(reportPath, 'utf8'),
    retractions: readFileSync(retractionPath, 'utf8'),
  });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(
      `retracted keys: ${result.keys.length}; findings: ${result.findings.length}\n`,
    );
  }
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      process.stderr.write(`stale queue: ${finding.rule}: ${finding.detail}\n`);
    }
    if (argv.includes('--check')) process.exit(1);
  }
}

main(process.argv.slice(2));
