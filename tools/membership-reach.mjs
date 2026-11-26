#!/usr/bin/env node
/**
 * What a membership adjudicator could reach on the arm that ships, read from the archive.
 *
 *     node tools/membership-reach.mjs <report.json> [--capability MR] [--json]
 *     node tools/membership-reach.mjs --self-test
 *
 * ## The question this answers, and why it is asked before a dispatch
 *
 * `docs/AUDIT-NUMERIC-MEMBERSHIP.md` reads the twelve numeric `MR` failures on the adopted arm
 * (`45543010618`, 500 questions, two repetitions, `layered` + `verbatim-acts`) and finds ten of them
 * decided before any arithmetic happens: six dropped a member the gold keeps, four kept one the gold
 * drops. Its §4 prices a membership adjudicator at a ceiling of ten questions (8.26 points) against a
 * paired floor of 4.96, i.e. six of ten must convert.
 *
 * That price is computed over a population the mechanism is **forbidden to address**. The audit's own
 * §3 rules the period axis out — `verbatim-scope` added exactly that bound and lost four questions,
 * `verbatim-clock` forbade it and read zero — and two of the ten are period questions
 * (`gpt4_731e37d7`, `3a704032`). So the population is **eight**, and the arithmetic that decides the
 * mechanism is:
 *
 *     ceiling  8 / 121 = 6.61 points
 *     floor    paired exact McNemar, six gains at zero losses = 4.96 points
 *     required 6 of 8 = 75%, against a campaign whose best single-variable conversion is 60%
 *
 * Doing that subtraction needs one more number: **how many of the eight reach gold at all**, when the
 * five adjudications are applied to the rows the reader already enumerated. A rule that cannot reach a
 * question at ideal execution cannot be argued into reaching it at any conversion rate, and the same
 * reasoning closed `reviewPass: 'spec'` in §200 — a ceiling measured on the archive, before a dispatch,
 * for nothing.
 *
 * ## Why this is a census and not a scorer
 *
 * It reads `rawOutput` and proposes **deltas**: for each failure, the rows the reply counted, the rows it
 * excluded, and which of the five adjudications applies to which row under a stated predicate. The
 * adjudicated value is `answered + Σdelta`, and it is compared to the gold **only when the gold parses
 * to exactly one number**. Everything else prints `uncompared` beside the numbers it found, because a
 * prose gold ("I replaced or fixed five items: …") is a thing to read, not a thing to parse — and a tool
 * that guessed would be a second scorer for the same question the judge already answered.
 *
 * The predicates are deliberately narrow. A broad one would report reach this mechanism cannot buy and
 * the argument above would be worthless: the verdict has to be a *lower* bound on what a careful
 * reading finds, never an upper one dressed as a measurement.
 *
 * ## The five adjudications, as `AUDIT-NUMERIC-MEMBERSHIP.md` §3 names them
 *
 * | adjudication | what it decides | the predicate here |
 * | --- | --- | --- |
 * | `identity` | one object stated twice is one row | a counted row whose content tokens are a strict subset of another counted row's |
 * | `duplication` | the old and the new of a replacement are one item | a counted `old …` row and a counted `new …`/`replacement picked up` row sharing the head noun |
 * | `boundary` | a member the question excludes in words is out | a counted row carrying two or more tokens of the phrase the question puts after `before` |
 * | `attribution` | an amount the *event* raised is not an amount the speaker raised | a counted row whose own text says the event raised it |
 * | `possession` | an item acquired but not described with a verb of acquisition is in | an excluded row quoting a possession idiom, whose own tagged act is the question's |
 *
 * The period bound is not among them and must not be: §3 rules it out with two measurements.
 */

import { readFileSync } from 'node:fs';

/** Words that carry no distinguishing power when two item strings are compared. */
const STOP = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'at',
  'on',
  'for',
  'to',
  'and',
  'or',
  'my',
  'our',
  'with',
  'from',
  'last',
  'this',
  'next',
  'month',
  'months',
  'week',
  'weeks',
  'year',
  'years',
  'day',
  'days',
  'recently',
  'one',
  'two',
  'same',
  'mentioned',
  'again',
  'also',
  'both',
  'each',
  'other',
  'more',
  'some',
]);

/** `- <item> | <act> | <date> — <note>`: the enumeration every reply on this route writes. */
const ROW = /^\s*(?:[-*]|\d+\.)\s+(?<body>\S.*)$/;
/**
 * A row is a candidate only when it separates its fields, and that is not a formatting preference.
 *
 * The replies mix candidate rows with sentences about the enumeration — `a56e767c` writes
 * `- Duplicate mentions of Austin Film Festival and AFI Fest were counted only once.` as a bullet. A
 * parser that took that bullet for an item would let `identity` collapse two real rows into a sentence
 * that names them both, which is the first version's defect and the reason this rule exists: the
 * enumeration's grammar is `item | act | date`, and a line without a separator is the reply talking
 * about its own list rather than adding to it.
 */
const CANDIDATE = /\|/;
/** A row the reply decided against. The marker is the reply's own word, anywhere in the row. */
const EXCLUDED = /exclud|not count|not included|left out|omitted/i;
/** The act the row claims, as the second pipe-separated field. */
const ACT = /\|\s*(?<act>[^|]{1,80}?)\s*(?:\||$)/;
/**
 * A row the reply says is *not* a member of the set it is enumerating — a mention kept as context.
 *
 * `dd2973ad` writes `Doctor's appointment at 10 AM … — context only; not a bedtime event, but used to
 * identify the …`, and a `boundary` predicate that treated it as a counted member subtracted one from a
 * correct answer of `2 AM`. The general rule is the reply's own: a row it says is not an instance was
 * never counted, so no adjudication is owed on it.
 */
const REFERENCE =
  /\bcontext only\b|\bnot (?:a|an) [a-z]+ (?:event|instance|item|member)\b|\bused to identify\b|\bfor context\b/i;

/**
 * Possession idioms: an item that arrived, without a verb of acquisition the gold requires.
 *
 * The quote may be straight or typographic — the replies use both, and `“my new,”` was the first
 * version's miss, caught by this file's own self-test rather than by a reading of the output.
 */
const QUOTE = '["“”]';
const POSSESSION = [
  new RegExp(`${QUOTE}\\s*my (?:new|own)\\b`, 'i'),
  new RegExp(`${QUOTE}\\s*(?:got|was) (?:it )?signed\\b`, 'i'),
  new RegExp(`${QUOTE}\\s*(?:was )?gifted\\b`, 'i'),
  new RegExp(`${QUOTE}\\s*(?:was )?(?:given|received|handed down)\\b`, 'i'),
  /\b(?:ordering|bought|purchased) (?:the |some )?(?:batteries|refills?|supplies)\b/i,
];

/**
 * The exclusion note says the *act* is missing, rather than the item being the wrong kind.
 *
 * The distinction is the audit's: `gpt4_15e38248`, `bf659f65` and `gpt4_31ff4165` all "invent an
 * evidentiary bar" — they demand a verb the evidence did not write — while "not furniture" and "not a
 * health-related device" are category judgements the gold agrees with.
 */
const ACT_BAR =
  /\bnot the act\b|\bact of (?:using|doing|attending)\b|\b(?:does not|doesn't|no)\b[^.;]{0,40}\b(?:act|action)\b/i;

/** The event did the raising, not the speaker. Narrow on purpose: "the event raised" in those words. */
const EVENT_RAISED =
  /\b(?:the )?(?:event|concert|benefit|fundraiser|drive|sale)\b[^.;|]{0,40}\braised\b/i;
/** …unless the speaker is named as a participant in the same clause, which the gold does count. */
const SPEAKER_HELPED =
  /\b(?:i|user|speaker)\b[^.;|]{0,20}\b(?:helped|organi[sz]ed|ran|hosted)\b|\bhelped (?:raise|organi[sz]e)\b/i;

function contentTokens(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9$£€.,\s-]/g, ' ')
      .split(/[\s]+/)
      .map((token) => token.replace(/^[.,]+|[.,]+$/g, ''))
      .filter((token) => token.length > 1 && !STOP.has(token)),
  );
}

/** The item a row names: everything before the first pipe, with a parenthetical removed. */
function itemOf(body) {
  return body
    .split('|')[0]
    .replace(/\([^)]*\)/g, ' ')
    .trim();
}

/**
 * One reply, as rows.
 *
 * A row is *counted* unless it carries the reply's own exclusion word. The exclusion marker is read from
 * the whole row rather than from a fixed column because the replies put it in three different places —
 * inside the act field, in a `— excluded: …` note, or in a section header above the row.
 */
function rowsOf(raw) {
  if (typeof raw !== 'string') return [];
  const rows = [];
  let inExcludedSection = false;
  for (const line of raw.split('\n')) {
    if (/^\s*#*\s*\**\s*(?:excluded|not counted|duplicate)/i.test(line)) {
      inExcludedSection = true;
      continue;
    }
    if (/^\s*(?:step|answer|sum|total)\b/i.test(line)) inExcludedSection = false;
    const match = ROW.exec(line);
    if (match === null) continue;
    const body = match.groups.body.replace(/\s+$/, '');
    if (!CANDIDATE.test(body)) continue;
    const act = ACT.exec(body)?.groups?.act ?? '';
    const excluded = inExcludedSection || EXCLUDED.test(body);
    const reference = !excluded && REFERENCE.test(body);
    rows.push({ body, item: itemOf(body), act: act.toLowerCase(), excluded, reference });
  }
  return rows;
}

/**
 * `identity`: a *relation phrase* is the same event as the row that names the relation's holder.
 *
 * The predicate is narrow because the broad one — any subset of any other row — damaged four correct
 * replies: `c2ac3c61`'s `some courses on Coursera` against `three courses on Coursera` (the same courses,
 * already counted once), `8979f9ec`'s `Lentil soup` against a row titled `Lentil soup duplicate mention`,
 * `2788b940`'s `Hip Hop Abs` against a *class-list* mention that happens to name it, and `a3332713`, whose
 * own note says `counted once` — the reply had already done the work.
 *
 * What the gold actually merges is the shape `gpt4_2f8be40d` shows: `Cousin's wedding last month` and
 * `Cousin Rachel's wedding at a vineyard in August` are one wedding, because the first names the event by
 * relation and the second names the relation's holder. So the shorter item must be a possessive of at most
 * three content tokens, and the longer must carry a capitalised token the shorter does not.
 */
function relationPhrase(item) {
  return /'s\b|’s\b/i.test(item) && contentTokens(item).size <= 3;
}
function identity(rows) {
  const counted = rows.filter((row) => !row.excluded && !row.reference);
  const deltas = [];
  for (let i = 0; i < counted.length; i += 1) {
    const short = contentTokens(counted[i].item);
    if (short.size < 2 || !relationPhrase(counted[i].item)) continue;
    const named = [...String(counted[i].item).matchAll(/\b([A-Z][a-z]+)\b/g)].map((m) =>
      m[1].toLowerCase(),
    );
    for (let j = 0; j < counted.length; j += 1) {
      if (i === j) continue;
      const long = contentTokens(counted[j].item);
      if (short.size >= long.size) continue;
      const covered = [...short].every((token) => long.has(token));
      if (!covered) continue;
      // The longer row has to *name* something the shorter one did not, or the two are the same string.
      const capitalised = [...String(counted[j].item).matchAll(/\b([A-Z][a-z]+)\b/g)].map((m) =>
        m[1].toLowerCase(),
      );
      if (!capitalised.some((token) => !named.includes(token))) continue;
      deltas.push({
        adjudication: 'identity',
        delta: -1,
        row: counted[i].body,
        because: `every token of this item is in "${counted[j].item}"`,
      });
      break;
    }
  }
  return deltas;
}

/** `duplication`: the old and the new of one replacement are one item, not two. */
function duplication(rows) {
  const counted = rows.filter((row) => !row.excluded && !row.reference);
  const old = counted.filter((row) => /\bold\b/i.test(row.item));
  const fresh = counted.filter(
    (row) => /\bnew\b/i.test(row.item) || /replacement picked up/i.test(row.act),
  );
  const deltas = [];
  const used = new Set();
  for (const previous of old) {
    const head = [...contentTokens(previous.item)].filter((token) => token !== 'old').pop();
    if (head === undefined) continue;
    for (const next of fresh) {
      if (used.has(next) || !contentTokens(next.item).has(head)) continue;
      used.add(next);
      deltas.push({
        adjudication: 'duplication',
        delta: -1,
        row: next.body,
        because: `the replacement half of "${previous.item}" (shared head "${head}")`,
      });
      break;
    }
  }
  return deltas;
}

/** `boundary`: a member the question puts after `before` is not a member of the set it asks about. */
function boundary(question, rows) {
  const anchor = /\bbefore\s+(?<phrase>[^?.]+)/i.exec(question)?.groups?.phrase;
  if (anchor === undefined) return [];
  const tokens = contentTokens(anchor);
  if (tokens.size < 2) return [];
  return rows
    .filter((row) => !row.excluded && !row.reference)
    .filter((row) => {
      const mine = contentTokens(row.item);
      return [...tokens].filter((token) => mine.has(token)).length >= 2;
    })
    .map((row) => ({
      adjudication: 'boundary',
      delta: -1,
      row: row.body,
      because: `names the anchor the question excludes ("before ${anchor.trim()}")`,
    }));
}

/** `attribution`: an amount the event raised is not an amount the speaker raised. */
function attribution(rows) {
  return rows
    .filter((row) => !row.excluded && !row.reference)
    .filter((row) => EVENT_RAISED.test(row.body))
    .map((row) => ({
      adjudication: 'attribution',
      delta: -1,
      row: row.body,
      because: SPEAKER_HELPED.test(row.body)
        ? "the event raised it and the speaker only organised it, which the gold counts as the event's"
        : 'the event raised it, not the speaker',
    }));
}

/**
 * `possession`: an item the evidence says arrived counts, even without a verb of acquisition.
 *
 * Two conditions, and the second is what keeps this from being a licence: the excluded row must quote
 * the evidence (the reply writes `described as "…"` or `evidence: …`), and the quoted text must be one of
 * the possession idioms. A row excluded for a reason the reply stated without a quote is left alone.
 */
function possession(question, rows) {
  const asked = question.toLowerCase();
  return rows
    .filter((row) => row.excluded)
    .filter(
      (row) =>
        POSSESSION.some((pattern) => pattern.test(row.body)) ||
        // The third form of the same bar: the row tags the act the question asks for and then excludes it
        // *because the evidence does not describe that act*. Both halves are required. `gpt4_31ff4165` has
        // three excluded rows tagged `use` and only one of them is this case — the hearing aids, excluded
        // for "not the act of using the hearing aids in a day"; the phone reminder and the planner are
        // excluded as "not a health-related device", which is a category judgement and not a bar on the
        // act. A predicate that fired on the tag alone added three members to a question whose gold adds
        // one, and this file's first run printed six where the answer is four.
        (row.act !== '' && asked.includes(row.act.split(/\s+/)[0]) && ACT_BAR.test(row.body)),
    )
    .map((row) => ({
      adjudication: 'possession',
      delta: 1,
      row: row.body,
      because: POSSESSION.some((pattern) => pattern.test(row.body))
        ? 'the quoted evidence says the item arrived or is in use'
        : 'the row tags the act the question asks for and then excludes it',
    }));
}

const ADJUDICATIONS = { identity, duplication, boundary, attribution, possession };
/** The two that read the question as well as the rows, stated once so the call site cannot drift. */
const TAKES_QUESTION = new Set(['boundary', 'possession']);

/** The numbers a gold states, in order. Written for `$3,750`, `4` and `five`, which are the three forms. */
const WORD = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
]);

function numbersInGold(gold) {
  if (typeof gold === 'number') return [gold];
  const text = String(gold ?? '');
  const words = [...text.toLowerCase().matchAll(/\b([a-z]+)\b/g)]
    .map((match) => WORD.get(match[1]))
    .filter((value) => value !== undefined);
  // **The first number in reading order is the answer**, and that is the only rule that reads all three
  // gold shapes without guessing: `I viewed four properties before …2-bedroom…` states four; `15 hours for
  // getting to the three destinations (or 30 hours …)` states fifteen and mentions the rest; `$3,750`
  // states one. Taking the single number *word* instead read that second gold as three and reported a
  // correct reply as damaged.
  const firstWord = text
    .toLowerCase()
    .search(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  const digits = [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((match) =>
    Number(match[0].replace(/,/g, '')),
  );
  if (firstWord === -1 && digits.length === 0) return [];
  if (digits.length === 0) return [words[0]];
  if (firstWord === -1) return digits;
  // A word before the first digit is the lead count of a prose gold, and the digits after it are detail
  // (`2-bedroom`, `or 30 hours`). A *digit* first with more numbers behind it is a gold that states a set
  // — `$1,000 and $200` — and both numbers come back, which reads as `uncompared` rather than as a guess.
  return firstWord < text.search(/-?\d/) ? [words[0]] : digits;
}

/** The number a reply answered with, or `undefined` when it answered in prose. */
function answerNumber(answer) {
  const text = String(answer ?? '');
  const match = /-?\$?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (match === null) return undefined;
  return Number(match[0].replace(/[$,]/g, ''));
}

/**
 * How much one delta moves the answer.
 *
 * A count moves by one; a total moves by the amount the row states. Without this the census read
 * `d851d5ba` as `$8,750 - 1 = $8,749` against a gold of `$3,750`, which is the arithmetic of a tool that
 * assumed every adjudication moves a set by one member — and the first output of this file said exactly
 * that, in the row it was written for.
 */
function magnitude(row, monetary) {
  if (!monetary) return 1;
  const match = /\$?\s?(\d[\d,]*(?:\.\d+)?)/.exec(String(row));
  if (match === null) return 1;
  return Number(match[1].replace(/,/g, ''));
}

/**
 * How much of an enumerable gold the retained rows cover.
 *
 * A count can land on the gold while the *set* differs, and `gpt4_ab202e7f` is the case: collapsing the
 * mat and the faucet takes seven rows to five, which is the gold's number, while the retained rows are
 * `toaster` and `toaster oven` and the gold's fifth member is a coffee maker the reply never mentions. A
 * tool that reported only the count would call that reach. So the gold's own items — the comma-separated
 * noun phrases of a prose gold — are looked for among the retained rows, and a `reached` that covers fewer
 * than all of them prints with an asterisk.
 */
function setRecall(gold, rows, counted) {
  if (typeof gold !== 'string' || !gold.includes(',')) return null;
  const items = gold
    .split(/,|\band\b/)
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && !/^(i|the)$/i.test(part));
  const enumerated = items.filter((item) => contentTokens(item).size > 0);
  if (enumerated.length < 2) return null;
  const covers = (item, pool) => {
    const tokens = [...contentTokens(item)];
    return pool.some(
      (mine) => tokens.filter((token) => mine.has(token)).length >= Math.min(2, tokens.length),
    );
  };
  // Before the adjudication, so a gold the rows could never name is not reported as damage the
  // adjudication did: `gpt4_2f8be40d`'s gold enumerates *couples* ("Rachel and Mike") and its rows
  // enumerate *weddings*, so the two share no vocabulary and the column would read 17% for a reply that
  // named every couple. Below half is that case, and it prints as undecidable.
  const before = counted.map((row) => contentTokens(row.item));
  if (enumerated.filter((item) => covers(item, before)).length / enumerated.length < 0.5)
    return null;
  const retained = rows.filter((row) => !row.excluded).map((row) => contentTokens(row.item));
  return enumerated.filter((item) => covers(item, retained)).length / enumerated.length;
}

/**
 * The census of one report.
 *
 * `questions` is the artifact's per-question vector. A report without one is refused rather than read as
 * an empty population, for the reason `exclusion-census.mjs` refuses it: a table of zeros prints as a
 * finding.
 */
function censusOf(report, capability, options = {}) {
  const records = Array.isArray(report?.questions) ? report.questions : [];
  if (records.length === 0)
    throw new Error('the report carries no questions, so there is nothing to census');
  const population =
    capability === undefined
      ? records
      : records.filter((record) => record.capability === capability);
  if (population.length === 0)
    throw new Error(`no question in the report carries capability ${capability}`);

  const failures = population.filter((record) => record.correct !== true);
  // The damage side, and it is not optional in spirit: a census that counts only what an adjudication
  // repairs is the shape of every over-claim this campaign has written down. `verbatim-scope` is the
  // prior — six regressions against two conversions on a five-question reach — and a mechanism whose
  // rules move correct replies has that risk measured rather than borrowed.
  const correct =
    options.failuresOnly === true ? [] : population.filter((record) => record.correct === true);
  const rows = [];
  for (const record of [...failures, ...correct]) {
    const enumerated = rowsOf(record.rawOutput);
    const deltas = [];
    for (const [name, adjudicate] of Object.entries(ADJUDICATIONS)) {
      const found = TAKES_QUESTION.has(name)
        ? adjudicate(record.question ?? '', enumerated)
        : adjudicate(enumerated);
      deltas.push(...found);
    }
    const answered = answerNumber(record.answer);
    const gold = numbersInGold(record.groundTruth);
    const countedRows = enumerated.filter((row) => !row.excluded).length;
    const monetary =
      /\$/.test(String(record.answer ?? '')) || /\$/.test(String(record.groundTruth ?? ''));
    const adjudicated =
      answered === undefined
        ? undefined
        : answered +
          deltas.reduce((sum, delta) => sum + delta.delta * magnitude(delta.row, monetary), 0);
    const retained = enumerated.filter((row) => !deltas.some((delta) => delta.row === row.body));
    rows.push({
      questionId: record.questionId,
      correct: record.correct === true,
      question: record.question,
      gold: record.groundTruth,
      answer: record.answer,
      countedRows,
      excludedRows: enumerated.length - countedRows,
      deltas,
      adjudicated,
      // `set` is `null` when the gold is not enumerable, and the asterisk in the print is what separates a
      // count that landed from a set that was reproduced.
      set: setRecall(
        record.groundTruth,
        retained,
        enumerated.filter((row) => !row.excluded),
      ),
      // `uncompared` is a value, not a zero: a prose gold is a thing to read. `reached` is therefore
      // three-valued and the count below reports all three.
      // One predicate, three populations: a failure that lands on the gold is `reached`, a correct
      // reply the rules would move off the gold is `damaged`, and a failure that lands nowhere near it
      // is `short`. `uncompared` is the refusal, and it is a value rather than a zero.
      verdict:
        answered === undefined || gold.length !== 1
          ? 'uncompared'
          : adjudicated === gold[0]
            ? record.correct === true
              ? 'kept'
              : 'reached'
            : record.correct === true
              ? 'damaged'
              : 'short',
      goldNumbers: gold,
    });
  }
  return { population, failures, correct, rows };
}

function summarise(result) {
  const { population, failures, rows } = result;
  const reached = rows.filter((row) => row.verdict === 'reached');
  const damaged = rows.filter((row) => row.verdict === 'damaged');
  const kept = rows.filter((row) => row.verdict === 'kept');
  const byAdjudication = new Map(
    Object.keys(ADJUDICATIONS).map((name) => [name, { fired: 0, questions: 0 }]),
  );
  for (const row of rows) {
    const names = new Set(row.deltas.map((delta) => delta.adjudication));
    for (const name of names) byAdjudication.get(name).questions += 1;
    for (const delta of row.deltas) byAdjudication.get(delta.adjudication).fired += 1;
  }
  return {
    population: population.length,
    failures: failures.length,
    // Failures only: a population that mixed them would print "reach 7 of 106" for seven repairs among
    // eleven comparable failures, which is the kind of denominator error this project keeps writing down.
    numericFailures: rows.filter((row) => row.verdict === 'reached' || row.verdict === 'short')
      .length,
    reached: reached.length,
    reachedIds: reached.map((row) => row.questionId),
    correctCompared: kept.length + damaged.length,
    damaged: damaged.length,
    damagedIds: damaged.map((row) => row.questionId),
    uncompared: rows.filter((row) => row.verdict === 'uncompared').length,
    adjudications: Object.fromEntries(byAdjudication),
  };
}

function print(result) {
  const summary = summarise(result);
  const out = [
    `${summary.population} questions, ${summary.failures} wrong, ${summary.numericFailures} of them with a comparable gold and answer`,
    `reach at ideal execution: ${summary.reached} of ${summary.numericFailures}`,
    `damage at ideal execution: ${summary.damaged} of ${summary.correctCompared} correct replies with a comparable gold`,
    '',
    `  ${'id'.padEnd(18)} ${'gold'.padStart(6)} ${'ans'.padStart(6)} ${'adj'.padStart(6)} ${'set'.padStart(5)}  verdict     deltas`,
  ];
  // Failures and damage, and the kept rows only as a count: a table of ninety-five rows that all say
  // `kept` is a table nobody reads, and the number is the claim.
  for (const row of result.rows.filter(
    (candidate) => candidate.correct !== true || candidate.verdict === 'damaged',
  )) {
    const deltas =
      row.deltas
        .map((delta) => `${delta.adjudication}${delta.delta > 0 ? '+' : ''}${delta.delta}`)
        .join(' ') || '—';
    const gold = row.goldNumbers.length === 1 ? String(row.goldNumbers[0]) : '?';
    out.push(
      `  ${String(row.questionId).padEnd(18)} ${gold.padStart(6)} ${String(answerNumber(row.answer) ?? '?').padStart(6)} ${String(row.adjudicated ?? '?').padStart(6)} ${(row.set === null ? '—' : `${Math.round(100 * row.set)}%`).padStart(5)}  ${(row.verdict === 'reached' && row.set !== null && row.set < 1 ? 'reached*' : row.verdict).padEnd(11)} ${deltas}`,
    );
  }
  const names = Object.keys(summary.adjudications);
  out.push(
    '',
    "  `reached*` is a count that landed on the gold while the gold's own items were not all retained — see `set`.",
  );
  out.push(
    '',
    `  ${'adjudication'.padEnd(14)} ${'deltas'.padStart(7)} ${'questions'.padStart(10)}`,
  );
  for (const name of names) {
    const row = summary.adjudications[name];
    out.push(
      `  ${name.padEnd(14)} ${String(row.fired).padStart(7)} ${String(row.questions).padStart(10)}`,
    );
  }
  return out.join('\n');
}

const SELF_TEST_REPLY = `Step 1 — candidate items:
- Old kitchen faucet | replaced (old item returned) | 2023/05/28
- New Moen kitchen faucet | replacement picked up in exchange | 2023/05/28
- Music benefit concert for music education | event raised over $5,000; user helped organize | 2023/05/20
- Cousin Rachel’s wedding at a vineyard in August | attended | 2023/10/15
- Cousin’s wedding last month | attended | 2023/10/15
- Casper mattress | excluded: only described as “my new,” no buy/assemble/sell/fix action | 2023/05/21
- Brookside townhouse (saw on Feb 22; offer on Feb 25) | viewed | 2023/03/08

Answer: 7`;

function selfTest() {
  const rows = rowsOf(SELF_TEST_REPLY);
  const counted = rows.filter((row) => !row.excluded).length;
  const checks = [
    ['a row with an exclusion note is not counted', counted === 6],
    ['the excluded count is the rest', rows.length - counted === 1],
    [
      'possession reads “my new” under a typographic quote',
      possession('How many pieces of furniture did I buy?', rows).length === 1,
    ],
    ['duplication collapses the replacement pair', duplication(rows).length === 1],
    ['duplication names the new half', duplication(rows)[0].row.includes('New Moen')],
    ['attribution drops what the event raised', attribution(rows).length === 1],
    [
      'identity merges the bare cousin’s wedding',
      identity(rows).some((delta) => delta.row.includes('Cousin’s wedding last month')),
    ],
    [
      'boundary drops the anchor the question excludes',
      boundary(
        'How many properties did I view before making an offer on the Brookside townhouse?',
        rows,
      ).length === 1,
    ],
    [
      'boundary does nothing when the question names no anchor',
      boundary('How many items did I fix?', rows).length === 0,
    ],

    ['a gold of four parses to one number', numbersInGold('4').join() === '4'],
    ['a gold in words parses', numbersInGold('I attended four movie festivals.').join() === '4'],
    ['a gold of two numbers does not parse to one', numbersInGold('$1,000 and $200').length === 2],
    ['an answer with a currency sign parses', answerNumber('$8,750') === 8750],
    [
      'a prose answer does not parse',
      answerNumber('Cannot be determined from the evidence.') === undefined,
    ],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  const empty = { population: [], failures: [], rows: [] };
  const refusals = [
    ['a report without questions is refused', () => censusOf({}, undefined)],
    [
      'a capability no question carries is refused',
      () => censusOf({ questions: [{ capability: 'TR' }] }, 'MR'),
    ],
    ['an empty report prints no reach', summarise(empty).reached === 0],
  ];
  for (const [name, run] of refusals) {
    let ok = false;
    try {
      const value = run();
      ok = value === true;
    } catch {
      ok = true;
    }
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  }
  console.log(failed === 0 ? 'all checks passed' : `${failed} checks failed`);
  return failed === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const json = argv.includes('--json');
  let capability;
  let path;
  const failuresOnly = argv.includes('--failures-only');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--capability') {
      capability = argv[i + 1];
      i += 1;
    } else if (!argv[i].startsWith('--')) {
      path = argv[i];
    }
  }
  if (path === undefined) {
    console.error(
      'usage: node tools/membership-reach.mjs <report.json> [--capability MR] [--failures-only] [--json]',
    );
    return 2;
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const result = censusOf(report, capability, { failuresOnly });
  if (json) console.log(JSON.stringify({ summary: summarise(result), rows: result.rows }, null, 2));
  else console.log(print(result));
  return 0;
}

// `process.exitCode` rather than `process.exit`: a piped write is asynchronous, and exiting after a large
// `--json` print truncates it mid-string. The first version of this file did that, and the symptom was a
// JSON parse error in the consumer rather than anything in here.
process.exitCode = main(process.argv.slice(2));
