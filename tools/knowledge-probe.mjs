#!/usr/bin/env node
/**
 * What the knowledge model does to the twenty reviewed pairs, run without a model.
 *
 * The input is the same review page the reviewer judged (`cortex-docs` evidence), so the reading and
 * the complaint describe one artifact. Nothing here calls an LLM: the atoms are the ones already
 * produced by `triage-proposer/v4`, and the question is what a **gate** would say about them.
 *
 *     node tools/knowledge-probe.mjs --html path/to/review.html
 *
 * Three readings, in the order they matter:
 *
 * 1. **Would the gate accept the split as it stands?** Under `strict`, a split that loses a relation is
 *    refused. The number is the size of the defect, expressed in the currency the product uses.
 * 2. **How many markers are unresolved?** Under `record`, the same question with the refusals counted
 *    instead of enforced, so the reading survives even when the answer is "almost all of them".
 * 3. **What does a repaired unit look like?** For the first pair whose sentence states a relation, an
 *    edge is built from the marker the sentence actually contains, and the three-line block is printed.
 *    That is the shape the reader would receive, and it is the only part of this file a person needs to
 *    look at to judge the design.
 *
 * The fact type is `event` for every atom because this probe asks nothing about types. A heuristic
 * classifier here would produce a type distribution that describes the heuristic, which is the class of
 * measurement this repository has already been burned by once.
 */

import { readFileSync } from 'node:fs';
import {
  buildKnowledgeUnit,
  censusOf,
  deriveSupersedes,
  edgeId,
  expandTyped,
  extractedSpan,
  fillBudget,
  kindsIn,
  locate,
  relationMarkers,
  renderBlock,
  renderBlocks,
  tokenEstimate,
} from '../packages/cortex-core/dist/index.js';

function parseArgs(argv) {
  const at = argv.indexOf('--html');
  if (at === -1 || argv[at + 1] === undefined) {
    process.stderr.write(
      'usage: node tools/knowledge-probe.mjs --html path/to/review.html [--json]\n',
    );
    process.exit(2);
  }
  return { html: argv[at + 1], json: argv.includes('--json') };
}

/** The pairs the review page carries: one sentence and the atoms offered for it. */
function loadPairs(html) {
  const blobs = [...html.matchAll(/<script[^>]*id="a3-data"[^>]*>([\s\S]*?)<\/script>/g)];
  if (blobs.length === 0) throw new Error('no a3-data blob: is this a review page?');
  const data = JSON.parse(blobs[0][1]);
  const byCard = new Map();
  for (const step of data.steps ?? []) {
    const entry = byCard.get(step.cardId) ?? {};
    entry[step.arm] = step;
    byCard.set(step.cardId, entry);
  }
  const pairs = [];
  for (const [cardId, entry] of [...byCard.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const source = entry.source?.source;
    const atoms = entry.atoms?.atoms;
    if (!source || !atoms || atoms.length === 0) continue;
    pairs.push({ cardId, source, atoms });
  }
  return pairs;
}

/** Every atom as an `event` fact, with its span computed from the words it kept. */
function factsOf(pair) {
  return pair.atoms.map((text, index) => ({
    id: `${pair.cardId}#${index}`,
    frameId: pair.cardId,
    text,
    type: 'event',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: locate(text, pair.source),
    references: [],
  }));
}

/**
 * The token reading, in the one shape that decides the design: what the grouped block costs against the
 * same content rendered as self-contained blocks.
 *
 * Returns `null` when no pair states a relation, because the comparison needs a repaired unit and inventing
 * one would make the saving a property of the invention.
 */
function tokenReading(pairs) {
  const demo = pairs.find(
    (pair) => relationMarkers(pair.source).length >= 1 && pair.atoms.length >= 2,
  );
  if (demo === undefined) return null;

  const frame = { id: demo.cardId, text: demo.source };
  const facts = factsOf(demo);
  const marker = relationMarkers(demo.source)[0];
  const type =
    marker.kind === 'causal' ? 'causes' : marker.kind === 'contrast' ? 'contrast' : 'before';
  const edge = {
    id: edgeId(type, facts[0].id, facts[1].id),
    from: facts[0].id,
    to: facts[1].id,
    type,
    origin: 'extracted',
    marker: marker.token,
    evidenceSpan: extractedSpan(facts[0].sourceSpan, facts[1].sourceSpan, marker),
  };

  const repaired = buildKnowledgeUnit({ frame, facts, edges: [edge] });
  if (!repaired.ok) return { cardId: demo.cardId, refused: repaired.problem.problem };

  const lines = renderBlocks(
    repaired.unit,
    facts.map((fact) => fact.id),
  );
  const grouped = tokenEstimate(lines.join('\n'));
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const naive = facts.reduce(
    (total, fact) => total + tokenEstimate(renderBlock(fact, frame, [edge], factsById).join('\n')),
    0,
  );
  return {
    cardId: demo.cardId,
    marker: marker.token,
    type,
    lines,
    grouped,
    naive,
    saving: naive === 0 ? 0 : (naive - grouped) / naive,
    reached: expandTyped([facts[0].id], [edge]).map((hit) => `${hit.factId} via ${hit.type}`),
  };
}

function main(argv) {
  const { html, json } = parseArgs(argv);
  const pairs = loadPairs(readFileSync(html, 'utf8'));
  if (pairs.length === 0) throw new Error('the page carries no complete pair');

  let strictAccepted = 0;
  let recorded = 0;
  const unresolvedRows = [];
  const refusals = new Map();

  for (const pair of pairs) {
    const frame = { id: pair.cardId, text: pair.source };
    const strict = buildKnowledgeUnit({ frame, facts: factsOf(pair), edges: [] });
    if (strict.ok) {
      strictAccepted += 1;
    } else {
      const key =
        strict.problem.problem === 'unresolved-marker'
          ? 'unresolved-marker'
          : `${strict.problem.problem}: ${strict.problem.detail.problem ?? ''}`;
      refusals.set(key, (refusals.get(key) ?? 0) + 1);
    }

    const loose = buildKnowledgeUnit({ frame, facts: factsOf(pair), edges: [], policy: 'record' });
    if (!loose.ok) continue;
    const census = censusOf(loose.unit);
    recorded += census.unresolved;
    if (census.unresolved > 0) {
      unresolvedRows.push(
        `${pair.cardId}: ${loose.unit.unresolved.map((marker) => marker.token).join(', ')}`,
      );
    }
  }

  const tokens = tokenReading(pairs);

  // The machine-readable form exists so that a gate can read these numbers instead of a document quoting
  // them. `tools/acceptance-check.mjs` is the caller, and it treats a missing key as `unrun`, not as zero.
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          pairs: pairs.length,
          strictAccepted,
          strictAcceptedRate: strictAccepted / pairs.length,
          unresolvedMarkers: recorded,
          unresolvedRows,
          refusals: Object.fromEntries(refusals),
          tokens,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`pairs                       ${pairs.length}\n`);
  process.stdout.write(
    `accepted as split (strict)  ${strictAccepted} (${((100 * strictAccepted) / pairs.length).toFixed(0)}%)\n`,
  );
  process.stdout.write(`unresolved markers          ${recorded}\n`);
  for (const [reason, count] of refusals) process.stdout.write(`  refused: ${reason} × ${count}\n`);
  if (unresolvedRows.length > 0) {
    process.stdout.write('\nwhere the relations were lost\n');
    for (const row of unresolvedRows) process.stdout.write(`  ${row}\n`);
  }

  if (tokens === null) {
    process.stdout.write('\nno pair with two markers: nothing to demonstrate\n');
    return 0;
  }
  if (tokens.refused !== undefined) {
    process.stdout.write(`\nrepaired unit still refused: ${tokens.refused}\n`);
    return 0;
  }

  process.stdout.write(
    `\nrepaired unit (${tokens.cardId}, marker "${tokens.marker}" → ${tokens.type})\n`,
  );
  for (const line of tokens.lines) process.stdout.write(`  ${line}\n`);
  process.stdout.write(
    `  ${tokens.grouped} tokens grouped, ${tokens.naive} tokens as self-contained blocks\n`,
  );
  process.stdout.write(`  1-hop from the first fact: ${tokens.reached.join(', ') || 'nothing'}\n`);

  // Knowledge update: the recorded failure is two measurements in one context, older one chosen.
  const before = {
    id: 'k1',
    frameId: 'ku',
    text: 'My best 5K time is 27:12.',
    type: 'event',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: 26 },
    references: [],
    subject: 'user',
    predicate: '5k time',
    at: 1,
  };
  const after = { ...before, id: 'k2', text: 'My best 5K time is 25:50.', at: 2 };
  process.stdout.write('\nknowledge update\n');
  for (const link of deriveSupersedes([before, after])) {
    process.stdout.write(
      `  ${link.id} (origin: ${link.origin}, no marker, no span: nothing to cite)\n`,
    );
  }

  // Budget: how many repaired units a 600-token context holds. Grouped, because the block is the unit of
  // value and an atom count would under-count it by the factor that makes it useful.
  const budgets = [];
  for (const pair of pairs) {
    const unit = buildKnowledgeUnit({
      frame: { id: pair.cardId, text: pair.source },
      facts: factsOf(pair),
      edges: [],
    });
    if (!unit.ok) continue;
    const text = renderBlocks(
      unit.unit,
      factsOf(pair).map((fact) => fact.id),
    ).join('\n');
    budgets.push({ id: pair.cardId, text, tokens: tokenEstimate(text) });
  }
  const fill = fillBudget(budgets, (entry) => entry.tokens, 600);
  process.stdout.write(`\nbudget 600 tokens over ${budgets.length} units\n`);
  process.stdout.write(
    `  kept ${fill.kept.length} (${fill.spent} tokens), skipped ${fill.skipped.length}\n`,
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
