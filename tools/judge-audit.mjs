#!/usr/bin/env node
/**
 * Run the judge audit: how often does this repository's judge accept an answer that is wrong?
 *
 *     node tools/judge-audit.mjs --artifact <report.json> [--limit 120] [--out <file>] [--plan-only]
 *
 * ## Why this tool exists
 *
 * Every accuracy number this project publishes is the judge's opinion, and the effects the campaign
 * is chasing are two or three questions on a 121-question capability. If the judge accepts wrong
 * answers at a rate anywhere near the published audit of LoCoMo — where a standard judge accepted
 * **62.81%** of topical-but-wrong answers — then the readings are measuring the judge, not the
 * memory arm.
 *
 * The instrument is `planAudit` in `cortex-eval`: it perturbs answers **the judge already accepted**
 * (`correct: true` in an artifact) in three ways that are wrong by construction, and re-submits them
 * with the same templates the benchmark used. `--plan-only` prints what it would ask without
 * spending a token, which is the form that can be reviewed in a pull request.
 *
 * ## The two controls, and why a rate alone would be worthless
 *
 * A judge that always answered "no" would score a perfect false-accept rate, so the unperturbed
 * answers are re-judged in the same run: **control** below. Anything short of 100% there is judge
 * non-reproducibility (`§13.135` measured 5.0% on byte-identical prompts), and it is the noise floor
 * the false-accept rate has to be read against rather than on its own.
 *
 * ## What is deliberately out of scope
 *
 * Abstention questions are excluded. Their template asks whether the model recognised the question as
 * unanswerable, so substituting a name or a number does not make the answer wrong — it would produce
 * cases that measure nothing while looking like a rate. Their gold is an explanation, not a value.
 *
 * ## The gate
 *
 * Exit 1 when the false-accept upper bound exceeds **5%**. The threshold is not arbitrary: the
 * campaign resolves differences of about 1.7 points (two questions of 121), so a judge that can
 * mis-accept 5% of wrong answers by chance is already larger than the signal, and a bound above it
 * means every capability reading needs the annotation rather than only the one under study.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  createLlmFromEnv,
  createLlmJudge,
  planAudit,
  summariseAudit,
  toJudgeQuestionType,
} from '../packages/cortex-eval/dist/index.js';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

/**
 * Turn an artifact's questions into audit sources.
 *
 * Only questions the judge accepted are eligible: an answer it rejected was already called wrong, so
 * re-submitting a perturbed version of it would measure nothing new. Abstention questions are
 * excluded for the reason in the header.
 */
export function sourcesFrom(questions, limit) {
  const eligible = questions.filter(
    (question) =>
      question.correct === true &&
      question.capability !== 'ABS' &&
      typeof question.groundTruth === 'string' &&
      question.groundTruth.trim().length > 0 &&
      typeof question.answer === 'string' &&
      question.answer.trim().length > 0,
  );
  return eligible.slice(0, limit).map((question) => ({
    questionId: String(question.questionId),
    question: String(question.question),
    gold: String(question.groundTruth),
    // The conversation is what the arm actually printed, which is the only text the model could have
    // read. Using the full session corpus instead would exclude tokens the model never saw and make
    // the absence invariant stricter than it needs to be — and wrong about what the judge read.
    conversation: Array.isArray(question.turns)
      ? question.turns.map((turn) => String(turn.text ?? '')).join('\n')
      : '',
    answer: String(question.answer),
    ...(typeof question.capability === 'string' ? { capability: question.capability } : {}),
    ...(typeof question.questionType === 'string' ? { questionType: question.questionType } : {}),
  }));
}

function printRate(label, rate) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(
    `  ${label.padEnd(16)} ${String(rate.accepted).padStart(3)}/${String(rate.total).padEnd(3)} ` +
      `= ${percent(rate.rate).padStart(6)}   Wilson 95% upper ${percent(rate.upper)}`,
  );
}

async function main() {
  const artifactPath = flag('--artifact');
  if (!artifactPath) {
    console.error(
      'usage: judge-audit.mjs --artifact <report.json> [--limit 120] [--out <file>] [--plan-only]',
    );
    return 2;
  }
  const limit = Number(flag('--limit') ?? '120');
  const report = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!Array.isArray(report.questions)) throw new Error(`${artifactPath} has no questions array`);

  const sources = sourcesFrom(report.questions, limit);
  const cases = planAudit(sources);
  if (cases.length === 0) {
    console.error('no auditable cases: the artifact has no accepted answer with a swappable token');
    return 1;
  }
  console.log(`artifact        ${artifactPath}`);
  console.log(`accepted answers audited   ${sources.length}`);
  console.log(`cases planned              ${cases.length}`);
  for (const kind of ['number-swap', 'entity-swap', 'cross-gold']) {
    console.log(`  ${kind.padEnd(14)} ${cases.filter((auditCase) => auditCase.kind === kind).length}`);
  }

  if (process.argv.includes('--plan-only')) {
    // The reviewable form. Three examples per kind, chosen by position rather than by score.
    for (const kind of ['number-swap', 'entity-swap', 'cross-gold']) {
      const sample = cases.filter((auditCase) => auditCase.kind === kind).slice(0, 3);
      for (const auditCase of sample) {
        console.log(`\n[${kind}] ${auditCase.questionId}`);
        console.log(`  gold       ${auditCase.gold.slice(0, 160)}`);
        console.log(`  original   ${auditCase.original.slice(0, 160)}`);
        console.log(`  perturbed  ${auditCase.answer.slice(0, 160)}`);
        console.log(`  introduced ${auditCase.introduced}`);
      }
    }
    return 0;
  }

  const llm = createLlmFromEnv(process.env);
  const grade = createLlmJudge(llm);
  // The template follows the question the case came from, because the artifact was graded with it.
  // Grading a temporal question with the default template would measure a harsher judge than the one
  // that produced the number under audit.
  const sourceById = new Map(sources.map((source) => [source.questionId, source]));
  const typeOf = (questionId) =>
    toJudgeQuestionType(sourceById.get(questionId)?.questionType ?? '', false);

  const verdicts = [];
  for (const auditCase of cases) {
    verdicts.push({
      accepted: await grade(
        auditCase.question,
        auditCase.answer,
        auditCase.gold,
        typeOf(auditCase.questionId),
      ),
    });
  }
  const control = [];
  for (const source of sources) {
    control.push({
      accepted: await grade(source.question, source.answer, source.gold, typeOf(source.questionId)),
    });
  }

  const reading = summariseAudit(cases, verdicts, control);
  console.log('\nfalse accepts (a "yes" on an answer that is wrong by construction)');
  printRate('all kinds', reading.cases);
  for (const kind of ['number-swap', 'entity-swap', 'cross-gold']) {
    printRate(kind, reading.byKind[kind]);
  }
  console.log('\ncontrol (the same answers, unperturbed: was the judge reproducible?)');
  printRate('control', reading.control);

  const out = flag('--out');
  if (out) {
    const payload = {
      what: "This repository's judge, audited on answers that are wrong by construction.",
      artifact: artifactPath,
      generatedAt: new Date().toISOString(),
      sources: sources.length,
      cases,
      verdicts,
      control,
      reading,
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }

  const threshold = 0.05;
  if (reading.cases.upper > threshold) {
    console.log(
      `\nGATE FAILS: false-accept upper bound ${(reading.cases.upper * 100).toFixed(1)}% > 5%. ` +
        'Every capability reading is judge-limited, not memory-limited — annotate them.',
    );
    return 1;
  }
  console.log(
    `\nGATE PASSES: false-accept upper bound ${(reading.cases.upper * 100).toFixed(1)}% <= 5%.`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('judge-audit.mjs')) {
  process.exitCode = await main();
}
