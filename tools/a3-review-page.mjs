#!/usr/bin/env node
/**
 * Render the A3 review as one HTML file a person can open and click.
 *
 * ## What this file is
 *
 * A shim: read a file, call one function, write a file. Everything decidable -- the arguments, the
 * cards' provenance, the page itself -- lives in `cortex-eval` and is covered there. That is not
 * tidiness: this tool's logic used to live here, its test ran under `pnpm test:tools`, and `check`
 * runs that **before** `pnpm build`, so CI failed on a suite that passed locally with a stale `dist`
 * beside it.
 *
 * ## Why a page instead of the terminal loop
 *
 * `a3-review.mjs review` works, and nobody has used it. A terminal loop means keeping a shell alive,
 * and a mistyped key or a closed window loses twenty judgements with no trace. The instrument has
 * been ready for three rounds and the reading has not happened; at that point the obstacle is the
 * interface, not the science.
 *
 * ## Usage
 *
 *     node tools/a3-review-page.mjs --cards readings/cards-remote.json --out review.html
 *     node tools/a3-review-page.mjs --cards cards.json --out review.html --reveal-gold
 *
 * Then open the file, answer twenty cards twice, download the JSONL, and:
 *
 *     node tools/a3-review.mjs score --decisions a3-decisions.jsonl
 *
 * `--reveal-gold` exists to check the instrument (does the label match what the card offers), never
 * to review with: a reviewer who can see the expected answer is not reviewing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  parseReviewPageArgs,
  readReviewCards,
  renderA3ReviewPage,
  resolveOutPath,
} from '../packages/cortex-eval/dist/index.js';

function main() {
  const args = parseReviewPageArgs(process.argv.slice(2));
  const cards = readReviewCards(JSON.parse(readFileSync(args.cardsPath, 'utf8')), args.cardsPath);

  const html = renderA3ReviewPage({
    cards: cards.cards,
    promptVersion: cards.promptVersion,
    profile: cards.profile,
    ...(args.revealGold ? { revealGold: true } : {}),
  });

  // Relative to the cards file, so a caller does not have to know where the tool is running from.
  const target = resolveOutPath(args.outPath, dirname(args.cardsPath));
  writeFileSync(target, html);
  console.log(`wrote ${target} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`prompt:  ${cards.promptVersion}`);
  console.log(`profile: ${cards.profile}`);
  console.log('');
  console.log('Open it, answer each card twice, then:');
  console.log('  node tools/a3-review.mjs score --decisions a3-decisions.jsonl');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
