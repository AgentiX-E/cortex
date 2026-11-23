#!/usr/bin/env node
/**
 * Turn a competitor's published per-question record file into the two things a re-grade needs: a
 * schema census, and one lined-up answer per question.
 *
 *     node tools/competitor-records-prep.mjs --url <url> --out-dir <dir>
 *     node tools/competitor-records-prep.mjs --input <file> --out-dir <dir>
 *
 * ## Why this exists
 *
 * Maximem Synap publishes 95.6% on LongMemEval next to this repository's 91.25%, and the two numbers
 * were produced by **different judges** (§169.5): theirs by the official `evaluate_qa.py` prompts, ours
 * by `deepseek-chat`. A 4.35-point gap measured with two different rulers is not a gap, it is two
 * readings, so the comparison has to be re-taken with one ruler. Re-grading needs the competitor's
 * *answers*, and they are only published inside a 23.7 MB record file whose schema is documented
 * nowhere. The engine is closed; the records are the whole instrument.
 *
 * ## Why the field is identified rather than assumed
 *
 * Guessing `response` is the obvious move and it is the one failure mode that stays silent. A wrong
 * guess does not throw: it reads a field that exists, hands the judge something that is not an answer,
 * and produces a smooth-looking accuracy whose only symptom is a number nobody can derive. So the
 * identification is arithmetic over the census, and **when it does not converge the answer field is
 * `null`** and the candidates are written out with the evidence that failed to separate them. A
 * refusal costs one more reading; a guess costs the campaign.
 *
 * The rules, and the reading each one refuses to skip:
 *
 *  * **present in every record** -- a key carried by part of the population would re-grade that part
 *    and report the result as the whole;
 *  * **a string** -- an answer is text; a number is a score and an object is a record;
 *  * **not the question echoed** -- a field that equals the question on more than half the records is
 *    a copy of the input, and a judge asked to compare an answer to itself by construction accepts it;
 *  * **shaped like an answer** -- median length inside `[1, 4000]`. Above that it is the retrieved
 *    context or the whole conversation, and grading it would measure whether the judge can find the
 *    answer inside a haystack instead of whether the competitor found it.
 *
 * ## What this does not do
 *
 * No model call, no network beyond the one GET. The re-grade is a different tool because it costs
 * money and this one must stay runnable on every pull request.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Answer-shaped: text, present everywhere, and inside one answer's length. */
const MAX_ANSWER_MEDIAN = 4000;

/**
 * Keys that are never the model's answer, whatever their shape.
 *
 * `answer` is on this list because in the published records it holds the **gold** — the same field name
 * LongMemEval uses for the expected answer. The direction of that collision is worth naming: the field
 * that looks most like the answer is the one that must never be read as it.
 */
const NEVER_ANSWER = new Set(['question', 'question_id', 'questionId', 'question_type', 'questionType', 'answer', 'ground_truth', 'groundTruth']);

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Per-key statistics over a list of objects.
 *
 * `count` is the number of records carrying the key at all, which is what separates a column from a
 * per-record detail; `types` is the set seen, because one record with a `null` where the rest have a
 * string is a real population in these files and collapses to "string" under a first-value read.
 */
export function census(objects) {
  const rows = new Map();
  for (const object of objects) {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      const row = rows.get(key) ?? { key, count: 0, types: new Set(), lengths: [], echoOfQuestion: 0 };
      row.count += 1;
      row.types.add(typeOf(value));
      if (typeof value === 'string') {
        row.lengths.push(value.length);
        if (typeof object.question === 'string' && value === object.question) row.echoOfQuestion += 1;
      }
      rows.set(key, row);
    }
  }
  return [...rows.values()].map((row) => ({
    key: row.key,
    count: row.count,
    types: [...row.types].sort(),
    lengthMedian: median(row.lengths),
    lengthMax: row.lengths.length === 0 ? null : Math.max(...row.lengths),
    echoOfQuestion: row.echoOfQuestion,
  }));
}

/**
 * The one key that holds the model's answer, or `null` with the candidates that survived.
 *
 * Returns `{ key, candidates }`. `candidates` is always the full survivor list, including the one that
 * won, so a reading can be re-checked without re-running: if a later file gains a second answer-shaped
 * field, the census will show two candidates and the `null` will be explained rather than surprising.
 */
export function identifyAnswerField(rows, recordCount) {
  const survivors = rows.filter(
    (row) =>
      row.count === recordCount &&
      row.types.length === 1 &&
      row.types[0] === 'string' &&
      !NEVER_ANSWER.has(row.key) &&
      row.echoOfQuestion * 2 <= recordCount &&
      row.lengthMedian !== null &&
      row.lengthMedian >= 1 &&
      row.lengthMedian <= MAX_ANSWER_MEDIAN,
  );
  return { key: survivors.length === 1 ? survivors[0].key : null, candidates: survivors };
}

/**
 * A key whose values are a verdict: a boolean, or a number/string confined to `0`/`1`/`true`/`false`.
 *
 * Deliberately not "a key named `correct`": the published file may name it anything, and the point of
 * reading it at all is to check the re-grade against the vendor's own count rather than against its
 * headline percentage -- a headline can be computed from a subset, a per-question verdict cannot.
 */
export function identifyVerdictField(rows, recordCount, taken) {
  const survivors = rows.filter((row) => {
    if (row.count !== recordCount || row.key === taken || NEVER_ANSWER.has(row.key)) return false;
    return row.types.length === 1 && (row.types[0] === 'boolean' || ((row.types[0] === 'number' || row.types[0] === 'string') && row.lengthMedian !== null && row.lengthMax !== null && row.lengthMax <= 5));
  });
  return { key: survivors.length === 1 ? survivors[0].key : null, candidates: survivors };
}

function valueLooksVerdict(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'correct') return true;
    if (lowered === 'false' || lowered === '0' || lowered === 'no' || lowered === 'incorrect') return false;
  }
  return null;
}

async function read(url, input) {
  if (input !== undefined) {
    const bytes = readFileSync(input);
    return { bytes, source: { path: input } };
  }
  if (url === undefined) throw new TypeError('pass --url or --input');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), source: { url } };
}

async function main() {
  const outDir = flag('--out-dir');
  if (outDir === undefined) throw new TypeError('pass --out-dir');
  const { bytes, source } = await read(flag('--url'), flag('--input'));

  const started = Date.now();
  const parsed = JSON.parse(bytes.toString('utf8'));
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : null;
  if (records === null) throw new TypeError('neither an array nor an object with a `records` array');

  const rows = census(records);
  const inferred = identifyAnswerField(rows, records.length);
  // An operator who read the census can name the field the census could not choose between. The
  // override is recorded in the artifact (`answerFieldSource`), because "the tool decided" and "a
  // human decided after reading the tool" are different provenance for the same number.
  const override = flag('--answer-field');
  const answer =
    override === undefined || override === ''
      ? { ...inferred, source: 'census' }
      : { key: override, candidates: inferred.candidates, source: 'override' };
  if (answer.key !== null && !rows.some((row) => row.key === answer.key && row.count === records.length)) {
    throw new TypeError(
      `--answer-field ${answer.key} is not carried by every record, so re-grading would cover a subset and report it as the whole`,
    );
  }
  const verdict = identifyVerdictField(rows, records.length, answer.key);
  const retrievalKeys = records.some((record) => record?.retrieval !== undefined) ? census(records.map((record) => record?.retrieval).filter((value) => value !== undefined)) : null;

  const refused =
    answer.key === null
      ? `no single record-level string field is answer-shaped: ${answer.candidates.length} candidates survived the census (${answer.candidates.map((row) => row.key).join(', ') || 'none'}). Pick one from the census by hand and re-run with --answer-field.`
      : undefined;

  const fieldMap = {
    questionId: pickPresent(rows, records.length, ['question_id', 'questionId', 'qid', 'id']),
    questionType: pickPresent(rows, records.length, ['question_type', 'questionType', 'type', 'category']),
    question: pickPresent(rows, records.length, ['question']),
    gold: pickPresent(rows, records.length, ['answer', 'ground_truth', 'groundTruth', 'gold']),
    answer: answer.key,
    verdict: verdict.key,
  };

  const questions =
    refused === undefined
      ? records.map((record) => ({
          questionId: String(record[fieldMap.questionId]),
          questionType: String(record[fieldMap.questionType] ?? ''),
          question: String(record[fieldMap.question]),
          gold: String(record[fieldMap.gold]),
          response: String(record[answer.key]),
          publishedVerdict: verdict.key === null ? null : valueLooksVerdict(record[verdict.key]),
          // Carried because the judge template depends on it: an abstention question is graded by a
          // different prompt in the official protocol, and `retrieval.abstention` is where these
          // records say so. `null` rather than `false` when the field is absent, because "not an
          // abstention question" and "this file does not say" are different facts and the second one
          // has to be visible before a re-grade quotes an abstention rate.
          abstention:
            typeof record?.retrieval?.abstention === 'boolean' ? record.retrieval.abstention : null,
        }))
      : [];

  const censusFile = {
    source: { ...source, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    records: records.length,
    parseMs: Date.now() - started,
    topLevel: rows,
    retrieval: retrievalKeys,
    fieldMap,
    answerFieldSource: answer.source,
    answerCandidates: answer.candidates,
    verdictCandidates: verdict.candidates,
    ...(refused === undefined ? {} : { refused }),
  };

  const answersFile = {
    fieldMap,
    answerField: answer.key,
    answerFieldSource: answer.source,
    verdictField: verdict.key,
    records: records.length,
    ...(refused === undefined ? {} : { refused }),
    questions,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'records-census.json'), `${JSON.stringify(censusFile, null, 2)}\n`);
  writeFileSync(join(outDir, 'records-answers.json'), `${JSON.stringify(answersFile, null, 2)}\n`);

  process.stdout.write(
    [
      `records          ${records.length}`,
      `bytes            ${bytes.length}`,
      `answerField      ${answer.key ?? '(refused)'}`,
      `verdictField     ${verdict.key ?? '(none)'}`,
      `questions        ${questions.length}`,
      refused === undefined ? undefined : `refused          ${refused}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n') + '\n',
  );
}

/**
 * The first name in `names` that is present in every record.
 *
 * A fixed name list is used for the *identifying* fields -- question, gold, type -- because those are
 * dataset conventions rather than vendor choices, and a wrong one is loud (the answer file has `null`
 * or `undefined` in it). Only the answer and the verdict, which carry the measurement, are inferred.
 */
function pickPresent(rows, recordCount, names) {
  const present = new Set(rows.filter((row) => row.count === recordCount).map((row) => row.key));
  return names.find((name) => present.has(name)) ?? null;
}

// Bare `node tools/...` runs; `import` from a test does not. The census functions above are exported
// so the identification rules can be tested against fixtures without a 23.7 MB download.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
