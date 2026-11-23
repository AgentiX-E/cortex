#!/usr/bin/env node
/// <reference types="node" />
/**
 * The two rendered lines, for the shapes that made the defect visible.
 *
 * Run `45096017960` printed the product arm's families as `0/6 a6/6` while its row said 80%, and its footer said
 * `reader/judge=none` while both were `deepseek-chat`. This fixture asserts the cell for the self-answering shape,
 * for the ordinary retrieval shape beside it, for the two absences (a family the arm was not asked about; a family
 * it was not read on), and the footer for a reading run and for a retrieval-only one.
 *
 * Printed as one JSON line so the pytest side asserts values rather than scraping a table.
 */
import { capabilityCell, configurationLine, contextTokensCell } from '../../report-render.mjs';

const products = { answerer: 'self', byCapability: { ABS: { found: 0, measured: 6, correct: 6, read: 6 } } };
const retrieval = {
  answerer: 'shared',
  byCapability: { ABS: { found: 6, measured: 6, correct: 5, read: 6 }, IE: { found: 2, measured: 6, read: 0 } },
};
const absent = { answerer: 'shared', byCapability: { ABS: { found: 6, measured: 6, correct: 5, read: 6 } } };

const readingFooter = configurationLine({
  limit: 10,
  mode: 'isolated',
  reader: 'deepseek-chat (chain-of-note/con, temp=0, one request)',
  judge: 'deepseek-chat (official per-type templates, temp=0)',
  differing: ['reader', 'judge', 'judgePolicy'],
});
const retrievalFooter = configurationLine({ limit: 10, mode: 'isolated', reader: 'none', judge: 'none' });

process.stdout.write(
  `${JSON.stringify({
    selfAnswering: capabilityCell(products, 'ABS'),
    retrieval: capabilityCell(retrieval, 'ABS'),
    retrievalOnly: capabilityCell(retrieval, 'IE'),
    missingFamily: capabilityCell(absent, 'TR'),
    // A score object with no `byCapability` at all: the harness builds one for an arm whose build failed, and a
    // cell that threw here would take the whole table down rather than printing the one dash it knows.
    noCapability: capabilityCell({ answerer: 'none' }, 'ABS'),
    // The delivered-context column: a search that found nothing is a measured zero, an arm with no hit list is not.
    selfContext: contextTokensCell({ answerer: 'self', meanContextChars: 0 }),
    emptySearchContext: contextTokensCell({ answerer: 'shared', meanContextChars: 0 }),
    measuredContext: contextTokensCell({ answerer: 'shared', meanContextChars: 34_563 * 4 }),
    readingFooter,
    retrievalFooter,
  })}\n`,
);
