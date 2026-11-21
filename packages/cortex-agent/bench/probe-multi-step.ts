/**
 * The `cortex-agent` probe entry point.
 *
 * ## What is here, and what is deliberately not
 *
 * Construction and delegation only: read the corpus path, load it through `cortex-eval`'s loader,
 * hand the cases to `probeMultiStep`, write what it returns. Every decision -- which turns are gold,
 * what a step cost, whether the reader's search added evidence -- is in
 * `src/probe.ts`, inside the coverage boundary. `cortex-memory/bench/run-ablation.ts` records why:
 * this directory is excluded from coverage, so a decision written here is a decision no test can
 * reach, and three of them shipped wrong before that rule existed.
 *
 * ## Why it is not wired into every push
 *
 * It costs a model call per question, and the standing instruction is that measurements are
 * dispatched on demand and recorded, never fired by a commit. The probe exists to be run **once**
 * before a 14 CNY two-step dispatch, and its reading either cancels that dispatch or sizes it.
 *
 * ## Running it
 *
 *   LONGMEMEVAL_PATH=data/longmemeval_s_cleaned.json \
 *   DEEPSEEK_API_KEY=... \
 *   pnpm --filter @agentix-e/cortex-agent probe:multi-step -- --steps 1 --out probe.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  createLlmFromEnv,
  loadLongMemEval,
  type LongMemEvalInstance,
} from '@agentix-e/cortex-eval';

import {
  probeMultiStep,
  type ProbeCase,
  type ProbeCaseResult,
  type ProbeOptions,
  type ProbeReport,
} from '@agentix-e/cortex-agent';

/** `--name value`, the only argument shape this entry accepts. */
function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  return value ?? fallback;
}

/**
 * Turn id to session id, for the reader's third tool.
 *
 * `context` is the sessions flattened in order, so the boundaries are the cumulative lengths and
 * nothing else. Deriving them from the strings -- a prefix, a date -- would be a guess about a
 * dataset whose session ids it already publishes.
 */
function boundariesOf(sessions: readonly (readonly string[])[]): number[] {
  const sessionOf: number[] = [];
  for (const [index, session] of sessions.entries()) {
    for (let turn = 0; turn < session.length; turn += 1) sessionOf.push(index);
  }
  return sessionOf;
}

async function main(): Promise<void> {
  const path = process.env.LONGMEMEVAL_PATH;
  if (path === undefined || path === '') {
    throw new Error(
      'LONGMEMEVAL_PATH is not set; the probe reads the corpus from disk, like every other arm.',
    );
  }
  const capability = flag('capability', 'MR');
  const steps = Number(flag('steps', '1'));
  const limit = Number(flag('limit', '0'));
  const out = flag('out', 'multi-step-probe.json');

  const instances = JSON.parse(readFileSync(path, 'utf8')) as LongMemEvalInstance[];
  const dataset = loadLongMemEval(instances);
  const selected = dataset.questions.filter((question) => question.capability === capability);
  const population = limit > 0 ? selected.slice(0, limit) : selected;

  const cases: ProbeCase[] = population.map((question) => ({
    id: question.id,
    question: question.question,
    turns: question.context,
    // No boundaries published means no sessions to open, and `indexRetrieval` already treats an
    // absent map as "every turn is its own conversation" -- so absent is passed through rather than
    // invented.
    ...(question.sessions === undefined ? {} : { sessionOf: boundariesOf(question.sessions) }),
    goldTurns: question.goldTurns ?? [],
  }));

  const options: ProbeOptions = { llm: createLlmFromEnv(process.env), maxSteps: steps };
  const report: ProbeReport = await probeMultiStep(cases, options);
  writeFileSync(out, `${JSON.stringify({ dataset: path, capability, ...report }, null, 2)}\n`);

  const perQuestion = report.cases === 0 ? 0 : Math.round(report.promptChars / report.cases);
  // One line per question that gained gold, capped: the aggregate decides whether a dispatch is
  // worth buying, and the rows are what makes the decision checkable rather than trusted. A reader
  // whose searches never gained anything produces no rows at all, which is the finding.
  const gained = report.perCase.filter((row: ProbeCaseResult) => row.newGold > 0).slice(0, 20);
  process.stdout.write(
    [
      `cases                : ${String(report.cases)} (${capability}, maxSteps ${String(report.maxSteps)})`,
      `reader calls         : ${String(report.calls)}, searches ${String(report.queries)} on ${String(report.askedQuestions)} questions`,
      // "actions", not "searches". Run `44867629266` printed 118 here against 106 searches, and the
      // only way those two can differ is a `session` action: it absorbs turns the same way a search
      // does and deliberately does not increment `queries`, because a reader opening a conversation
      // has not written a query. The label was the wrong half of that pair.
      `reader actions adding : ${String(report.addedQuestions)} questions`,
      `gold found by reader : ${String(report.newGold)} turns on ${String(report.gainedQuestions)} questions`,
      `gold: seed / selected / carried / total : ${String(report.goldSeed)} / ${String(report.goldSelected)} / ${String(report.goldCarried)} / ${String(report.goldTotal)}`,
      `found but not carried: ${String(report.foundNotCarried)}`,
      `deciding prompt chars: ${String(perQuestion)} per question`,
      ...gained.map(
        (row: ProbeCaseResult) =>
          `  ${row.id}: +${String(row.newGold)} gold, ${String(row.trace.queries)} search(es), stop ${row.trace.stop}`,
      ),
      `written              : ${out}`,
    ].join('\n') + '\n',
  );
}

await main();
