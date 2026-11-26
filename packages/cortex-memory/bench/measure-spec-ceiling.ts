/**
 * The command line that runs the specification ceiling over a corpus, before anything is dispatched.
 *
 * ## The question this answers, and why it has to be asked before the run
 *
 * `reviewPass: 'tally'` was dispatched on a hypothesis -- "the reader can find the operands and
 * cannot add them, so let the product add" -- and the run priced that hypothesis at −9.5
 * multi-session questions. The autopsy found the operands were wrong, which means the hypothesis was
 * never really about arithmetic; it was about *which quantity counts*. The next mechanism,
 * `reviewPass: 'spec'`, replaces the reader's per-line judgement with a typed plan over a
 * programme-built ledger. Before paying for a dispatch, there is a cheap question that decides
 * whether the dispatch can succeed at all:
 *
 * > **Is there any plan in this grammar that produces the gold answer?**
 *
 * The search itself is `src/aggregation/ceiling.ts`, which is where it can be measured and where the
 * caller census can see a production caller. This file does three things and no arithmetic: it reads
 * a corpus, it reads a population, and it prints a table.
 *
 * ## Two ways to name the population, and why the second exists
 *
 * `--artifact` reads a benchmark report and selects its failing questions. That is the right
 * population when the report is the arm being extended, and it is how `docs/MEASURE-SPEC-CEILING.md`
 * was measured.
 *
 * `--population` reads a frozen list of ids from a registered file. It exists because a *control*
 * report's failing set is not the failing set of the arm that ships: after eight mechanisms landed,
 * the ids that failed under `42533236864` are mostly passing, and a ceiling computed over them reads
 * low for a reason that has nothing to do with the grammar. Measuring "what the grammar could reach
 * among what still fails" therefore needs the ids named by hand, frozen in `docs/` against a written
 * audit, and checked against the corpus rather than trusted.
 *
 * A population file also carries the arithmetic it is read against -- `numericGold`, `floor`,
 * `required` -- so a run prints the bar beside the reading. A ceiling printed without its floor is a
 * number that has to be looked up in a document, and the document may have moved.
 *
 * ## What this refuses to do
 *
 * It will not skip a question that is missing from the corpus. A population id the corpus does not
 * carry is a **failed reading**, not a question to drop: dropping it would lower the denominator and
 * raise the ceiling, which is the one direction a ceiling must never move by accident. The command
 * exits non-zero after printing the table, so the rows are still there to read.
 *
 * Usage:
 *   node --import tsx bench/measure-spec-ceiling.ts \
 *     --dataset /workspace/data/longmemeval_s_cleaned.json \
 *     --artifact /workspace/art-42533236864/benchmark-cortex-memory-ablation-report.json \
 *     [--capability MR] [--all] [--json out.json]
 *
 *   node --import tsx bench/measure-spec-ceiling.ts \
 *     --dataset /workspace/data/longmemeval_s_cleaned.json \
 *     --population tools/spec-ceiling-population.json \
 *     [--keywords question|history] [--max-keywords 600] [--json out.json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  measure,
  selectPopulation,
  summarise,
  type ArtifactQuestion,
  type DatasetQuestion,
  type PopulationFile,
  type SpecSummary,
} from '../src/aggregation/ceiling.js';

/**
 * The repository root, found by walking up for the workspace manifest rather than by counting `..`.
 *
 * The first dispatch of this workflow (`45748211939`) failed on exactly this: `--population
 * tools/spec-ceiling-population.json` was resolved against the package directory, because
 * `pnpm --filter` runs a package script with the package as its working directory, and the runner
 * has no `packages/cortex-memory/tools/`. A relative path in a command line is a path relative to
 * whatever the caller's working directory happens to be, and the caller here is a package manager.
 */
function repoRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('no pnpm-workspace.yaml above the bench directory');
    directory = parent;
  }
}

/**
 * A path as written on the command line, resolved against the repository rather than the caller.
 *
 * Every path this tool *reads* is a file the repository registers -- the corpus is passed by the
 * workflow as an absolute path, and a population is a checked-in document -- so resolving against
 * the repository is what makes the same command line work from the repository root and from a
 * package directory. `--json` is the exception and is resolved against the working directory,
 * because where a reading is written is the caller's decision and not the repository's.
 */
function inputPath(path: string): string {
  return isAbsolute(path) ? path : join(repoRoot(), path);
}

/** Read `--flag value` pairs, which is all this command line needs. */
function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 || index === process.argv.length - 1
    ? null
    : (process.argv[index + 1] as string);
}

function main(): void {
  const datasetPath = flag('dataset');
  const artifactPath = flag('artifact');
  const populationPath = flag('population');
  if (datasetPath === null || (artifactPath === null) === (populationPath === null)) {
    console.error(
      'usage: --dataset <path> (--artifact <path> | --population <path>) [--capability MR] [--all] [--keywords question|history] [--max-keywords 600] [--json out.json]',
    );
    process.exit(2);
  }
  const capability = flag('capability');
  const includeCorrect = process.argv.includes('--all');
  const vocabularyMode = flag('keywords') === 'history' ? 'history' : 'question';
  const maxKeywords = Number(flag('max-keywords') ?? 600);

  const dataset = JSON.parse(readFileSync(inputPath(datasetPath), 'utf8')) as DatasetQuestion[];
  const artifact =
    artifactPath === null
      ? null
      : (JSON.parse(readFileSync(inputPath(artifactPath), 'utf8')) as {
          questions: ArtifactQuestion[];
        });
  const population =
    populationPath === null
      ? null
      : (JSON.parse(readFileSync(inputPath(populationPath), 'utf8')) as PopulationFile);

  const { selected, missing } = selectPopulation({
    dataset,
    artifact,
    population,
    capability,
    includeCorrect,
  });

  const summaries: SpecSummary[] = [];
  for (const entry of selected) {
    summaries.push(measure(entry.corpus, vocabularyMode, maxKeywords, entry.gold));
  }

  const reading = summarise(summaries, vocabularyMode);

  console.log(`vocabulary: ${vocabularyMode}`);
  if (populationPath !== null) console.log(`population: ${populationPath}`);
  console.log(`questions: ${reading.questions}  with a numeric gold: ${reading.numeric}`);
  console.log(`copy ceiling   : ${reading.copy}/${reading.numeric}`);
  console.log(`grammar ceiling: ${reading.grammar}/${reading.numeric}`);
  console.log(`pass-eligible  : ${reading.eligible}/${reading.numeric}`);
  console.log(`grammar, gated : ${reading.grammarOfEligible}/${reading.eligible}`);
  console.log(`median plan share, gated: ${(reading.planShareMedian * 100).toFixed(2)}%`);
  if (population?.numericGold !== undefined) {
    console.log(
      `registered     : numericGold ${String(population.numericGold)}  floor ${String(population.floor ?? '?')}  required ${((population.required ?? 0) * 100).toFixed(0)}%`,
    );
  }
  if (missing.length > 0) {
    console.error(`missing from the corpus: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
  console.log('');
  console.log('id            gate  copy  grammar  plans  share   gold');
  for (const summary of summaries) {
    const gate = summary.tallyEligible ? ' yes' : '  no';
    const copy = summary.goldNumbers.length === 0 ? ' n/a' : summary.copyCeiling ? ' yes' : '  no';
    const grammar =
      summary.goldNumbers.length === 0 ? '     ' : summary.grammarCeiling ? '     yes' : '      no';
    console.log(
      `${summary.questionId}  ${gate}  ${copy}  ${grammar}  ${String(summary.matchingPlans).padStart(5)}/${String(summary.plansTried).padEnd(5)} ${(summary.planShare * 100).toFixed(2).padStart(6)}%  ${summary.gold.slice(0, 36).replaceAll('\n', ' ')}`,
    );
  }

  const out = flag('json');
  if (out !== null) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          capability,
          vocabulary: vocabularyMode,
          population: populationPath,
          summaries,
          copy: reading.copy,
          grammar: reading.grammar,
          numeric: reading.numeric,
          eligible: reading.eligible,
          grammarOfEligible: reading.grammarOfEligible,
          planShareMedian: reading.planShareMedian,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nwrote ${out}`);
  }
}

// Guarded so nothing runs on import: the search moved to `src/`, and a command line that executed
// when a test imported its module would be the defect `tools/queue-floor.mjs` records.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
