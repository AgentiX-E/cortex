/**
 * The ceiling command line, run rather than read.
 *
 * ## Why this test exists at all
 *
 * The first dispatch of `.github/workflows/measure-spec-ceiling.yml` (run `45748211939`) failed on a
 * path that no unit test could see: `--population tools/spec-ceiling-population.json` was resolved
 * against the package directory, because `pnpm --filter` runs a package script with the package as
 * its working directory. The instrument was green, the workflow was green in review, and the run
 * died with `ENOENT` after a 100 MB corpus download.
 *
 * A static check cannot catch that class of defect. The only thing that can is starting the process
 * the way the runner starts it -- from the package directory, with the arguments the workflow
 * passes -- and asserting on what comes back. So this file runs the real command three times:
 *
 * 1. a small corpus and a small population, which must measure and write a reading;
 * 2. a population id the corpus does not carry, which must **fail** rather than measure a question
 *    it could not find;
 * 3. the registered population named **relatively** from the package directory, which must fail
 *    with "missing from the corpus" and **not** with `ENOENT` -- the exact distinction between "the
 *    path resolved and the question is absent" and "the path did not resolve", which is the bug.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The package directory, which is the working directory `pnpm --filter` gives a package script. */
const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

/** Run the command line the way the workflow does, and capture everything instead of throwing. */
function run(args: readonly string[]): Run {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'bench/measure-spec-ceiling.ts', ...args],
      { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * A two-question corpus, written where a workflow would put one.
 *
 * The two answers are deliberately of two types: the corpus states a count question's gold as a
 * **number** and a money question's as a **string**. Run `45750764632` died on exactly that --
 * `gold.matchAll is not a function` -- because the instrument's type said `string` and the data did
 * not agree. A fixture that wrote both as strings would let the same defect through again.
 */
function corpus(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ceiling-cli-'));
  const path = join(directory, 'dataset.json');
  const questions = [
    {
      question_id: 'q1',
      question_type: 'multi-session',
      question: 'How many books did I read?',
      // A number, which is what the corpus states for a count question.
      answer: 2,
      haystack_dates: ['2023/03/01 (Wed) 10:00', '2023/03/02 (Thu) 11:00'],
      haystack_sessions: [
        [{ role: 'user', content: 'I read a book about otters.' }],
        [{ role: 'user', content: 'I read another book, and it cost $10.' }],
      ],
    },
    {
      question_id: 'q2',
      question_type: 'multi-session',
      question: 'How much did the book I read cost?',
      // A string with a currency symbol, which is what the corpus states for a money question.
      answer: '$10',
      haystack_dates: ['2023/03/01 (Wed) 10:00', '2023/03/02 (Thu) 11:00'],
      haystack_sessions: [
        [{ role: 'user', content: 'I read a book about otters.' }],
        [{ role: 'user', content: 'I read another book, and it cost $10.' }],
      ],
    },
  ];
  writeFileSync(path, JSON.stringify(questions));
  return path;
}

describe('the ceiling command line runs from the package directory', () => {
  it('measures a named population and writes the reading it printed', () => {
    const dataset = corpus();
    const out = join(tmpdir(), `ceiling-cli-${String(process.pid)}.json`);
    const population = join(tmpdir(), `ceiling-pop-${String(process.pid)}.json`);
    writeFileSync(population, JSON.stringify({ ids: ['q1', 'q2'], numericGold: 2, floor: 4.96 }));

    const result = run(['--dataset', dataset, '--population', population, '--json', out]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('grammar ceiling: 2/2');
    const reading = JSON.parse(readFileSync(out, 'utf8')) as { grammar: number; numeric: number };
    expect(reading).toMatchObject({ grammar: 2, numeric: 2 });
  });

  it('fails rather than measuring when a named id is absent from the corpus', () => {
    // The exit status is the reading's own verdict: a population id the corpus does not carry is a
    // failed measurement, and a run that printed a table and exited zero would be read as a ceiling.
    const population = join(tmpdir(), `ceiling-gone-${String(process.pid)}.json`);
    writeFileSync(population, JSON.stringify({ ids: ['not-in-the-corpus'] }));
    const result = run(['--dataset', corpus(), '--population', population]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing from the corpus: not-in-the-corpus');
    expect(result.stdout).toContain('grammar ceiling: 0/0');
  });

  it('resolves a repository-relative population against the repository, not the package', () => {
    // THE REGRESSION TEST. Run `45748211939` died here with `ENOENT`; the distinction this asserts
    // is between a path that resolved to a file whose ids are simply not in this corpus and a path
    // that never resolved at all.
    const result = run([
      '--dataset',
      corpus(),
      '--population',
      'tools/spec-ceiling-population.json',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing from the corpus: gpt4_15e38248');
    expect(result.stderr).not.toContain('ENOENT');
  });
});
