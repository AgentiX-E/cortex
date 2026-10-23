#!/usr/bin/env node
/**
 * Render the A3 review as one HTML file a person can open and click.
 *
 * ## Why a page instead of the terminal loop
 *
 * `a3-review.mjs review` works, and nobody has used it. A terminal loop means keeping a shell alive,
 * and a mistyped key or a closed window loses twenty judgements with no trace. The instrument has
 * been ready for three rounds and the reading has not happened; at that point the obstacle is the
 * interface, not the science.
 *
 * The page is a single file with no external request of any kind. It reads the same `cards.json` the
 * terminal loop reads, and it exports the same JSONL `score` consumes -- asserted in
 * `cortex-eval`'s `review-page.test.ts`, where the exported line is handed to `scoreA3` rather than
 * compared field by field.
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
import { resolve } from 'node:path';

import { renderA3ReviewPage } from '../packages/cortex-eval/dist/index.js';

function options(argv) {
  const out = { cards: undefined, out: undefined, revealGold: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--reveal-gold') {
      out.revealGold = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${token} needs a value`);
    if (token === '--cards') out.cards = value;
    else if (token === '--out') out.out = value;
    else throw new Error(`unknown option ${token}`);
    index += 1;
  }
  return out;
}

function main() {
  const config = options(process.argv.slice(2));
  if (config.cards === undefined || config.out === undefined) {
    throw new Error('usage: a3-review-page.mjs --cards <cards.json> --out <file.html> [--reveal-gold]');
  }

  const { cards } = JSON.parse(readFileSync(resolve(config.cards), 'utf8'));
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error(`${config.cards}: no cards`);
  }

  // The prompt and the profile come from the cards file, not from a flag: they were recorded when the
  // cards were built, and a flag here could disagree with the file it is describing.
  const promptVersion = cards[0].promptVersion;
  const profile = cards[0].profile;
  // Named one at a time, deliberately: "promptVersion/profile" sends a reader looking at both, and
  // the two are recorded by the same writer, so only one of them is ever missing.
  const absent = [
    ...(promptVersion === undefined ? ['promptVersion'] : []),
    ...(profile === undefined ? ['profile'] : []),
  ];
  if (absent.length > 0) {
    throw new Error(
      `${config.cards}: cards carry no ${absent.join(' and no ')} -- rebuild them with a current ` +
        '`a3-review.mjs prepare`, because a review that cannot name its configuration is not a reading',
    );
  }
  const mixed = cards.some(
    (card) => card.promptVersion !== promptVersion || card.profile !== profile,
  );
  if (mixed) {
    throw new Error(`${config.cards}: the cards come from more than one configuration`);
  }

  const html = renderA3ReviewPage({
    cards,
    promptVersion,
    profile,
    ...(config.revealGold ? { revealGold: true } : {}),
  });

  const target = resolve(config.out);
  writeFileSync(target, html);
  console.log(`wrote ${target} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`prompt:  ${promptVersion}`);
  console.log(`profile: ${profile}`);
  console.log('');
  console.log('Open it, answer each card twice, then:');
  console.log('  node tools/a3-review.mjs score --decisions a3-decisions.jsonl');
}

main();
