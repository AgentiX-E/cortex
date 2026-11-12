#!/usr/bin/env node
/**
 * Whether a cost criterion is **reachable at all** from one artifact, at zero model calls.
 *
 * ## The question this answers, and the one it does not
 *
 * `C1` reads "prompt tokens delivered to the reader for one question, one repetition" and asks for at most
 * 6,000. Every previous round treated that as a target and went looking for a lever: a narrower pool
 * (`42522552589`, −1.2% for an eightfold cut), a smaller room (`42373407439`, 5,623 tokens at −2.65 points),
 * a per-route allocation (`42383171765`, 9,149 tokens at −1.05). All three are answers to "how do we get
 * cheaper". None of them asked the prior question: **can this configuration reach the threshold without
 * giving up the capability another criterion requires?**
 *
 * That question is arithmetic on the artifact, because the bill is a sum over routes and one route's share is
 * fixed by what that capability needs. If the two capabilities that need a wide window already bill more than
 * the threshold on their own, then no allocation of the remaining routes reaches it, and a dispatch that tries
 * is buying a measurement whose answer is known.
 *
 * ## Why the floor is a floor, and what would move it
 *
 * The floor is computed by setting every non-heavy route's delivered characters to **zero** -- not to a small
 * number, to zero -- and dividing the heavy routes' characters by *all* questions. It is a lower bound of a
 * particular configuration family: same reader, same evidence unit, same window width on the capabilities that
 * are load-bearing. It is **not** a lower bound on what cortex can ever cost. What it bounds is the cost of
 * answering a question by putting turns in front of a reader, and the only way past it is to stop paying per
 * turn -- aggregate in code, render an answer rather than a haystack. The tool reports the bound and names the
 * family rather than implying the bound is absolute.
 *
 * ## The second column, which decides whether the bound is worth arguing about
 *
 * `goldShare` is the share of the delivered window that is evidence at all. On the registered configuration it
 * is **9.1% for `MR` and 8.1% for `TR`** against 52.4% for `IE`: the two capabilities that lose the most when
 * the room halves are also the two that carry the least gold per character. That is not a defect in selection
 * -- `MR` asks for a count over turns spread across sessions, so the reader needs the turns that are *not* in
 * the gold list -- but it is the mechanism by which the bill is large, and a document that argues for a wider
 * window on `MR` should say which of its characters are doing the work.
 *
 * Usage:
 *   node tools/cost-floor.mjs <report.json> [--threshold 6000] [--heavy MR,TR] [--json] [--detail]
 */

import { readFileSync } from 'node:fs';

/**
 * Characters per token, **measured on this corpus** rather than assumed.
 *
 * `MEASURE-TOKEN-BASIS.md` §1 derives it on `42533236864`: 34,447 evidence characters over 8,941 evidence tokens
 * is 3.8528, and the same run's 9,201 billed tokens split into 8,941 evidence and 260 overhead. Two earlier
 * readings in this repository used 4.06 (`PROMPT-ROOM-IS-LOAD-BEARING.md`, from a *median* character count
 * over an *evidence* token count) and that is where the archive's 5,623 came from; 4.06 understates this
 * corpus's tokens by 5.4%, which is the direction that makes a floor look smaller than it is.
 */
const DEFAULT_CHARS_PER_TOKEN = 3.8528;

/** The cost ceiling `C1` registers. A flag so a re-registration does not need a code change. */
const DEFAULT_THRESHOLD = 6000;

/**
 * The capabilities whose window is load-bearing, and the evidence for each.
 *
 * `MR` loses 6.61 points and `TR` 4.72 when the room halves, against 0.00 / 0.67 / 1.39 for the other three
 * (`PROMPT-ROOM-IS-LOAD-BEARING.md` §2). These are the rows the floor keeps; everything else is set to zero.
 */
const DEFAULT_HEAVY = ['MR', 'TR'];

/**
 * How many times over an adaptive window carries its own gold.
 *
 * Two is the reading the document uses: enough slack that a single missed turn does not empty the window, and
 * small enough that the figure stays a bound rather than a restatement of the fixed room.
 */
const DEFAULT_SLACK = 2;

function parseArgs(argv) {
  const out = {
    path: undefined,
    threshold: DEFAULT_THRESHOLD,
    heavy: DEFAULT_HEAVY,
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    slack: DEFAULT_SLACK,
    json: false,
    detail: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--detail') out.detail = true;
    else if (arg === '--slack') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write(`--slack wants a positive number, received ${String(raw)}\n`);
        process.exit(2);
      }
      out.slack = value;
    } else if (arg === '--chars-per-token') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write(`--chars-per-token wants a positive number, received ${String(raw)}\n`);
        process.exit(2);
      }
      out.charsPerToken = value;
    } else if (arg === '--threshold') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write(`--threshold wants a positive number, received ${String(raw)}\n`);
        process.exit(2);
      }
      out.threshold = value;
    } else if (arg === '--heavy') {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined) {
        process.stderr.write('--heavy wants a comma-separated capability list\n');
        process.exit(2);
      }
      out.heavy = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (out.heavy.length === 0) {
        process.stderr.write('--heavy wants at least one capability\n');
        process.exit(2);
      }
    } else if (arg.startsWith('--')) {
      process.stderr.write(`unknown flag ${arg}\n`);
      process.exit(2);
    } else if (out.path === undefined) out.path = arg;
    else {
      process.stderr.write(`unexpected argument ${arg}: one artifact per invocation\n`);
      process.exit(2);
    }
  }
  if (out.path === undefined) {
    process.stderr.write('usage: node tools/cost-floor.mjs <report.json> [--threshold N] [--heavy A,B] [--json]\n');
    process.exit(2);
  }
  return out;
}

/**
 * The characters this question actually put in front of the reader.
 *
 * **Not `evidenceChars`.** That field holds the evidence *available* before the room is applied -- 289,387
 * characters per question on `43140878641` against 35,447 delivered -- because it records the assembled
 * transcript rather than the slice that survived selection. `deliveredPromptChars` is what was sent, and
 * `promptChars` the fallback for artifacts that predate delivery trimming.
 *
 * `MEASURE-TOKEN-BASIS.md` §1 divides this same field by 3.8528 and lands on 9,200 prompt tokens against 9,201
 * billed, which is what makes it the right numerator.
 */
function deliveredChars(question) {
  for (const field of ['deliveredPromptChars', 'promptChars']) {
    const value = question[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/** The chars of every gold turn this question was scored against, carried or not. */
function goldChars(question) {
  const turns = question.goldOverlap?.goldTurns;
  if (!Array.isArray(turns)) return 0;
  return turns.reduce((sum, turn) => sum + String(turn ?? '').length, 0);
}

/**
 * The factor that turns delivered evidence into billed prompt tokens.
 *
 * Billed tokens are larger than the evidence they carry -- instructions, the question, the answer-format block,
 * and any retry that re-sent the same window. Deriving the factor from the artifact rather than assuming it
 * keeps the floor comparable to the criterion, which is written in *billed* tokens. When the artifact carries
 * no billing (`llmUsage` and `costEfficiency` both absent) the factor is 1 and the reading is marked as
 * evidence-only.
 */
function billingFactor(artifact, deliveredPerQuestion) {
  const questions = artifact.questionCount;
  const runs = artifact.runs;

  /**
   * `usageBySide.feature` first, and the top-level `llmUsage` only as a last resort.
   *
   * **The top-level block is both arms.** On `43140878641` it reads 21,241,613 prompt tokens while the feature
   * side is 18,335,563: the difference is the baseline arm, and pricing one arm with the sum would overstate it
   * by 15.9%. `cost-ledger.py` reads `usageBySide.feature` for exactly this reason, and `C1` reads what the
   * ledger writes.
   */
  const perQuestionFrom = (tokens) => {
    if (
      typeof tokens !== 'number' ||
      !Number.isFinite(tokens) ||
      tokens <= 0 ||
      typeof questions !== 'number' ||
      questions <= 0 ||
      typeof runs !== 'number' ||
      runs <= 0
    )
      return null;
    return tokens / (questions * runs);
  };

  const sidePerQuestion = perQuestionFrom(artifact.usageBySide?.feature?.promptTokens);
  if (sidePerQuestion !== null && deliveredPerQuestion > 0) {
    return {
      factor: sidePerQuestion / deliveredPerQuestion,
      basis: 'usageBySide.feature.promptTokens',
      billed: sidePerQuestion,
      callsPerQuestionRun:
        typeof artifact.usageBySide.feature.calls === 'number' ? artifact.usageBySide.feature.calls / (questions * runs) : null,
    };
  }

  const reported = artifact.costEfficiency?.promptTokensPerQuestion;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0 && deliveredPerQuestion > 0) {
    return { factor: reported / deliveredPerQuestion, basis: 'costEfficiency.promptTokensPerQuestion', billed: reported, callsPerQuestionRun: null };
  }

  const combinedPerQuestion = perQuestionFrom(artifact.llmUsage?.promptTokens);
  if (combinedPerQuestion !== null && deliveredPerQuestion > 0) {
    return {
      factor: combinedPerQuestion / deliveredPerQuestion,
      basis: 'llmUsage.promptTokens (both arms)',
      billed: combinedPerQuestion,
      callsPerQuestionRun: null,
    };
  }

  return { factor: 1, basis: 'none', billed: null, callsPerQuestionRun: null };
}

/** One row per capability: how wide its window is, and how much of that width is evidence. */
function byCapability(questions) {
  const rows = new Map();
  for (const question of questions) {
    const capability = String(question.capability ?? 'unknown');
    const row = rows.get(capability) ?? { capability, n: 0, goldChars: 0, deliveredChars: 0, allGoldCarried: 0 };
    row.n += 1;
    row.goldChars += goldChars(question);
    row.deliveredChars += deliveredChars(question);
    const overlap = question.goldOverlap;
    if (overlap !== undefined && overlap.carried === overlap.total) row.allGoldCarried += 1;
    rows.set(capability, row);
  }
  return [...rows.values()].sort((a, b) => b.n - a.n);
}

function measure(artifact, options) {
  const questions = Array.isArray(artifact.questions) ? artifact.questions : [];
  const total = questions.length;
  const rows = byCapability(questions).map((row) => ({
    ...row,
    meanDeliveredChars: row.n === 0 ? 0 : row.deliveredChars / row.n,
    goldShare: row.deliveredChars === 0 ? null : row.goldChars / row.deliveredChars,
    allGoldCarriedRatio: row.n === 0 ? null : row.allGoldCarried / row.n,
    heavy: options.heavy.includes(row.capability),
  }));

  const deliveredTotal = rows.reduce((sum, row) => sum + row.deliveredChars, 0);
  const meanDelivered = total === 0 ? 0 : deliveredTotal / total;
  const { factor, basis, billed, callsPerQuestionRun } = billingFactor(artifact, meanDelivered / options.charsPerToken);

  /**
   * The floor, and the algebra that makes it exact.
   *
   * The heavy routes' characters are divided by **every** question, because the four light routes are set to
   * zero. Writing it out:
   *
   *   floor = (heavyChars / questions / ratio) x (billed / (deliveredChars / questions / ratio))
   *         = (heavyChars / deliveredChars) x billed
   *
   * **The character ratio cancels.** The floor is the heavy routes' *share of the delivered characters* times
   * the run's own bill, so it carries no density assumption at all -- and neither does the adaptive bound below,
   * which is the same expression with a different numerator. The ratio survives only in the informational
   * evidence-token line, where it is labelled.
   */
  const heavyChars = rows.filter((row) => row.heavy).reduce((sum, row) => sum + row.deliveredChars, 0);
  const heavyQuestions = rows.filter((row) => row.heavy).reduce((sum, row) => sum + row.n, 0);
  const heavyShare = deliveredTotal === 0 ? 0 : heavyChars / deliveredTotal;
  const floorEvidenceTokens = total === 0 ? 0 : heavyChars / total / options.charsPerToken;
  const floorBilled = billed === null ? floorEvidenceTokens : heavyShare * billed;
  const floorShareOfBill = heavyShare;

  const correct = questions.filter((question) => question.correct === true).length;
  const tokensPerQuestion = billed ?? meanDelivered / options.charsPerToken;
  const tokensPerCorrect = correct === 0 ? null : (tokensPerQuestion * total) / correct;

  /**
   * What a window sized **per question** would cost, using each question's own gold as the sizer.
   *
   * This is an oracle, and it is deliberately not an achievable configuration: production does not know the gold
   * turns at read time. It is useful because it separates two things that the fixed allocation makes look like
   * one -- "the threshold is too tight" and "the room is not sized to the question". On the registered
   * configuration `MR` is given 48,311 characters for gold of 4,417; `IE` is given 22,981 for gold of 12,045. A
   * window that scales with the question's own evidence bills a fraction of the fixed one, and the gap between
   * the two is the prize an adaptive allocator would be aiming at.
   *
   * `slack` multiplies the gold before capping at what the question currently receives, so the figure is
   * "every gold turn, delivered twice over, and never more than today". A slack of 1 is the tightest defensible
   * reading and a slack of 3 approaches the fixed window for the capabilities whose gold already exceeds it.
   */
  const adaptive = questions.map((question) => {
    const current = deliveredChars(question);
    return Math.min(current, goldChars(question) * options.slack);
  });
  const adaptiveChars = adaptive.reduce((sum, value) => sum + value, 0);
  const adaptivePerQuestion = total === 0 ? 0 : adaptiveChars / total;
  const adaptiveShare = deliveredTotal === 0 ? 0 : adaptiveChars / deliveredTotal;
  const adaptiveBilled = billed === null ? adaptivePerQuestion / options.charsPerToken : adaptiveShare * billed;

  return {
    questionCount: total,
    runs: artifact.runs ?? null,
    charsPerToken: options.charsPerToken,
    threshold: options.threshold,
    heavy: options.heavy,
    capabilities: rows,
    overall: {
      meanDeliveredChars: meanDelivered,
      meanEvidenceTokens: meanDelivered / options.charsPerToken,
      billedTokensPerQuestion: billed,
      billingFactor: factor,
      billingBasis: basis,
      callsPerQuestionRun,
      goldShare: deliveredTotal === 0 ? null : rows.reduce((sum, row) => sum + row.goldChars, 0) / deliveredTotal,
    },
    floor: {
      heavyQuestions,
      heavyChars,
      evidenceTokensPerQuestion: floorEvidenceTokens,
      billedTokensPerQuestion: floorBilled,
      shareOfBill: floorShareOfBill,
      /** What the light routes may spend in total (not each) and still meet the ceiling. */
      lightBudgetBilled: total === 0 ? 0 : options.threshold - floorBilled,
      verdict: floorBilled > options.threshold ? 'blocked' : 'reachable',
    },
    accuracy: {
      correct,
      ratio: total === 0 ? null : correct / total,
      tokensPerCorrectAnswer: tokensPerCorrect,
    },
    adaptive: {
      slack: options.slack,
      charsPerQuestion: adaptivePerQuestion,
      billedTokensPerQuestion: adaptiveBilled,
      shareOfBill: adaptiveShare,
      ratioToFixed: billed === null || billed === 0 ? null : adaptiveBilled / billed,
      verdict: adaptiveBilled > options.threshold ? 'blocked' : 'reachable',
    },
  };
}

function print(report, detail) {
  const lines = [];
  const pct = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
  lines.push(`questions ${report.questionCount}   runs ${report.runs ?? '—'}   chars/token ${report.charsPerToken}`);
  lines.push('');
  lines.push('cap    n  meanChars  goldChars  goldShare  allGold  heavy');
  for (const row of report.capabilities) {
    lines.push(
      `${row.capability.padEnd(5)} ${String(row.n).padStart(3)}  ${row.meanDeliveredChars.toFixed(0).padStart(9)}  ` +
        `${String(Math.round(row.goldChars)).padStart(9)}  ${pct(row.goldShare).padStart(9)}  ` +
        `${pct(row.allGoldCarriedRatio).padStart(7)}  ${row.heavy ? 'yes' : ''}`,
    );
  }
  lines.push('');
  lines.push(
    `delivered   ${report.overall.meanDeliveredChars.toFixed(0)} chars/q  ` +
      `${report.overall.meanEvidenceTokens.toFixed(0)} tokens/q (evidence)`,
  );
  lines.push(
    `billed      ${report.overall.billedTokensPerQuestion === null ? '—' : report.overall.billedTokensPerQuestion.toFixed(0)} tokens/q  ` +
      `(factor ${report.overall.billingFactor.toFixed(3)} from ${report.overall.billingBasis}` +
      `${report.overall.callsPerQuestionRun === null ? '' : `, ${report.overall.callsPerQuestionRun.toFixed(2)} calls/question-run`})`,
  );
  lines.push(`gold share of the window ${pct(report.overall.goldShare)}`);
  lines.push('');
  lines.push(
    `floor       ${report.floor.billedTokensPerQuestion.toFixed(0)} billed tokens/q with ` +
      `${report.floor.heavyQuestions} ${report.heavy.join('+')} questions keeping their window and every other route at zero`,
  );
  lines.push(
    `            ${(report.floor.shareOfBill * 100).toFixed(1)}% of the delivered characters, which is the whole ` +
      `of the bound: the floor is that share times the bill, so no character-per-token ratio enters it`,
  );
  lines.push(
    `            light routes may spend ${report.floor.lightBudgetBilled.toFixed(0)} billed tokens in total`,
  );
  lines.push(
    `verdict     threshold ${report.threshold} is ${report.floor.verdict}` +
      (report.floor.verdict === 'blocked'
        ? `: the floor exceeds it by ${(report.floor.billedTokensPerQuestion - report.threshold).toFixed(0)} tokens (${(
            (report.floor.billedTokensPerQuestion / report.threshold - 1) *
            100
          ).toFixed(1)}%)`
        : `: ${(report.threshold - report.floor.billedTokensPerQuestion).toFixed(0)} tokens of headroom`),
  );
  lines.push('');
  lines.push(
    `accuracy    ${report.accuracy.correct}/${report.questionCount} = ${pct(report.accuracy.ratio)}   ` +
      `tokens per correct answer ${report.accuracy.tokensPerCorrectAnswer === null ? '—' : report.accuracy.tokensPerCorrectAnswer.toFixed(0)}`,
  );
  lines.push('');
  lines.push(
    `adaptive    ${report.adaptive.billedTokensPerQuestion.toFixed(0)} billed tokens/q if each window carried ` +
      `${report.adaptive.slack}x its own gold (a bound, not a configuration)` +
      `${report.adaptive.ratioToFixed === null ? '' : `, ${(report.adaptive.ratioToFixed * 100).toFixed(0)}% of the fixed bill`}`,
  );
  lines.push(
    `            threshold ${report.threshold} is ${report.adaptive.verdict} for an allocator sized this way`,
  );
  if (detail) {
    lines.push('');
    lines.push('A blocked verdict is a statement about one family: answering by putting turns in front of a reader,');
    lines.push('with these capabilities\' windows held. It does not bound a design that aggregates in code and renders');
    lines.push('an answer -- that design pays per fact rather than per turn, which is the only thing that moves this line.');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

const options = parseArgs(process.argv.slice(2));
const artifact = JSON.parse(readFileSync(options.path, 'utf8'));
const report = measure(artifact, options);
if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else print(report, options.detail);
process.exit(0);
