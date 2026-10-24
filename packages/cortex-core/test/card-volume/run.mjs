#!/usr/bin/env node
/**
 * How many questions the card queue opens on real speech, before and after the claims gate.
 *
 * ## The question this answers
 *
 * `docs/02` calls the card queue the place where a deferral becomes a question. That sentence was
 * written when the only corpus was sixty hand-labelled utterances in which 40 of 60 rows deferred --
 * two thirds, which reads as "the rules decide a third and ask about the rest". A product person
 * asks a different question: **how many questions does one session produce?** Nothing had measured
 * it, and the answer decides whether the queue is a feature or a backlog.
 *
 * The unit is the **evidence window**: the turns a reader was actually shown for one question, after
 * retrieval, admission and the character budget. That is the workload, not a simulation of it, and
 * it is the same unit `[POC-7]` used for the shared-rate reading, so the two numbers describe one
 * corpus rather than two.
 *
 * ## The four numbers, and why each one is here
 *
 *   before       every deferral opens a card. This is what the code did until step 18, and it is
 *                the baseline the change has to be judged against.
 *   after        a deferral opens a card only when the turn contains a claim (`claimsIn`). The
 *                difference is turns that ask, instruct or say nothing -- which on real speech are a
 *                quarter of the deferrals, and which used to be publishable by one click.
 *   declined     the turns that now open nothing. Sampled and read by hand once (see docs/04), to
 *                check that what was silenced is what the name says.
 *   fused        the gate's blind spot: a claim and a question inside one sentence ("I like
 *                categorising my coupons, but how do I decide which categories to prioritise?").
 *                Counted rather than described, so a later edit cannot quietly enlarge it.
 *
 * ## What this does not measure
 *
 * Whether a card was worth asking. Nobody answered these cards: acceptance is a human reading, and
 * the instrument for that is the A3 review page, not this script. What is measured here is the
 * denominator a person would face -- the number of decisions the queue puts in front of them.
 *
 * Usage, from `packages/cortex-core` after `pnpm build`:
 *
 *     node test/card-volume/run.mjs                       # the committed ten-window sample
 *     node test/card-volume/run.mjs --report <artifact>   # the full run, for the headline number
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, claimsIn, splitSentences } from '../../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const reportFlag = args.indexOf('--report');
const reportPath = reportFlag === -1 ? undefined : args[reportFlag + 1];

/** The committed sample: one entry per window, user turns only. */
function windowsFromCorpus(corpus) {
  return corpus.windows.map((window) => window.turns);
}

/** The full artifact: same unit, after stripping the timestamp header and dropping other roles. */
function windowsFromReport(report) {
  const header = /^\[[^\]]+\]\s*([a-z]+):\s*/i;
  return report.questions.map((question) =>
    (question.turns ?? [])
      .map((turn) => {
        const text = turn.text ?? '';
        const match = header.exec(text);
        return {
          role: match ? match[1].toLowerCase() : 'unknown',
          body: match ? text.slice(match[0].length) : text,
        };
      })
      .filter((turn) => turn.role === 'user' && turn.body.trim().length > 0)
      .map((turn) => turn.body.trim()),
  );
}

/**
 * A claim fused into a question by a comma conjunction.
 *
 * The gate is sentence-level, so "X, but how do I Y?" is one sentence and goes with the question.
 * This detector is deliberately narrow -- a question-mark sentence carrying a first-person clause
 * before a comma conjunction -- because the number is quoted in the docs and a loose detector would
 * inflate it.
 */
const FUSED = /(^|[,;]\s*)(i|i'?m|i'?ve|i'?d|i'?ll|my|we|we'?re|our)\b/i;
const CONJUNCTION = /,\s*(but|and|so|yet|because|which)\b/i;
function isFusedLoss(turn) {
  return splitSentences(turn).some(
    (sentence) => sentence.endsWith('?') && FUSED.test(sentence) && CONJUNCTION.test(sentence),
  );
}

function measure(windows) {
  let turns = 0;
  let deferred = 0;
  let cards = 0;
  let claims = 0;
  let fused = 0;
  const perWindow = [];

  for (const window of windows) {
    let windowDeferred = 0;
    let windowCards = 0;
    for (const turn of window) {
      turns += 1;
      if (classify(turn).scope !== 'defer') continue;
      deferred += 1;
      windowDeferred += 1;
      const kept = claimsIn(turn);
      claims += kept.length;
      if (kept.length > 0) {
        cards += 1;
        windowCards += 1;
      } else if (isFusedLoss(turn)) {
        fused += 1;
      }
    }
    perWindow.push({ deferred: windowDeferred, cards: windowCards, turns: window.length });
  }

  const cardCounts = perWindow.map((window) => window.cards).sort((a, b) => a - b);
  const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

  return {
    windows: windows.length,
    turns,
    deferred,
    deferRate: deferred / turns,
    before: { cards: deferred, perWindow: mean(perWindow.map((window) => window.deferred)) },
    after: {
      cards,
      perWindow: mean(cardCounts),
      medianPerWindow: cardCounts[Math.floor(cardCounts.length / 2)],
      maxPerWindow: cardCounts[cardCounts.length - 1],
      claims,
    },
    declined: deferred - cards,
    declinedRate: (deferred - cards) / deferred,
    fusedLoss: fused,
    fusedLossRate: fused / deferred,
  };
}

const corpus = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'));
const sample = measure(windowsFromCorpus(corpus));
const full =
  reportPath === undefined
    ? undefined
    : measure(windowsFromReport(JSON.parse(readFileSync(reportPath, 'utf8'))));

const pct = (value) => `${(value * 100).toFixed(1)}%`;

function report(label, measured) {
  console.log(`${label}: ${measured.windows} windows, ${measured.turns} user turns`);
  console.log(`  turns a rule defers      ${measured.deferred} (${pct(measured.deferRate)})`);
  console.log(
    `  cards before the gate    ${measured.before.cards}  ${measured.before.perWindow.toFixed(1)} / window`,
  );
  console.log(
    `  cards after the gate     ${measured.after.cards}  ${measured.after.perWindow.toFixed(1)} / window ` +
      `(median ${measured.after.medianPerWindow}, max ${measured.after.maxPerWindow})`,
  );
  console.log(
    `  claims kept              ${measured.after.claims} inside ${measured.after.cards} cards`,
  );
  console.log(
    `  declined                 ${measured.declined} (${pct(measured.declinedRate)} of deferrals)`,
  );
  console.log(
    `  fused claim+question     ${measured.fusedLoss} (${pct(measured.fusedLossRate)} of deferrals)`,
  );
}

report('sample', sample);
if (full !== undefined) {
  console.log('');
  report('full', full);
}

writeFileSync(
  join(HERE, 'result.json'),
  `${JSON.stringify(
    {
      what: 'Card volume on real user speech, before and after the claims gate in CardQueue.open.',
      sample: { corpus: 'test/card-volume/corpus.json', ...sample },
      ...(full === undefined
        ? {}
        : { full: { source: basename(reportPath), run: '39699987781', ...full } }),
    },
    null,
    2,
  )}\n`,
);
