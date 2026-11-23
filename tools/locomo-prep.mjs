#!/usr/bin/env node
/**
 * Census the LoCoMo corpus and flatten its questions, so that an evidence reading and an accuracy
 * reading are two separable steps instead of one paid one.
 *
 *     node tools/locomo-prep.mjs --input locomo10.json --out-dir prep/locomo
 *
 * ## Why this corpus, and why now
 *
 * `updateAppliesTo` gates a learned fact on the anchor sentence appearing in the question's corpus
 * (`semantic-facts.ts:394`), and LongMemEval gives every question its own corpus — so semantic carry
 * reaches 6% of questions **by construction** and the `H2` ablation has no denominator there (§169.4).
 * LoCoMo is the opposite construction: ten dialogues of ~25 sessions each, one pair of speakers, facts
 * introduced early and updated later. That is the shape the mechanism was built for, which is why the
 * ablation and this corpus were argued to be one thing rather than two.
 *
 * ## What the census refuses to assume
 *
 *  * **Contiguous sessions.** `session_N_date_time` is present for every N up to the last, while
 *    `session_N` itself is not: sample 0 has 19 session bodies and a `session_20_date_time` with no
 *    `session_20`. A loop over `1..35` would read `undefined` as a conversation and report a shorter
 *    corpus rather than a broken one, so the declared and present sets are both counted and the gap is
 *    named.
 *  * **Category names.** The published evaluator dispatches on integer categories and the numbers are
 *    all the data carries. Naming them in this tool would put a translation nobody verified in front of
 *    a per-category table, so the counts are reported as integers and the names live only in prose.
 *  * **Evidence resolvable by parsing.** `evidence` holds `dia_id` strings (`D1:3`); whether each one
 *    resolves is measured against the ids the corpus itself carries, because an evidence reading over
 *    unresolvable ids has no denominator and would silently grade only the questions that happened to
 *    resolve.
 *  * **The annotations being free.** `event_summary`, `observation` and `session_summary` are
 *    human-written summaries of what happens in each session. They are *in the file* and a system that
 *    reads them is not doing retrieval from the dialogue; their presence is recorded here so that any
 *    future reading can state whether it used them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

const SESSION_KEY = /^session_(\d+)$/;
const SESSION_DATE_KEY = /^session_(\d+)_date_time$/;

/** The session numbers that have a body, and the ones that only have a date. */
export function sessionNumbers(conversation) {
  const present = [];
  const declaredOnly = [];
  for (const key of Object.keys(conversation ?? {})) {
    const body = SESSION_KEY.exec(key);
    if (body !== null) {
      if (Array.isArray(conversation[key])) present.push(Number(body[1]));
      continue;
    }
    const date = SESSION_DATE_KEY.exec(key);
    if (date !== null) declaredOnly.push(Number(date[1]));
  }
  present.sort((a, b) => a - b);
  const bodies = new Set(present);
  return { present, declaredOnly: declaredOnly.sort((a, b) => a - b).filter((n) => !bodies.has(n)) };
}

/**
 * The `dia_id` set the corpus actually carries, which is the denominator an evidence reading needs.
 *
 * Built from the turns rather than from a regex over the id, because `D1:3` is a display form: the
 * corpus is free to number a session differently from its key, and reading the id's own digits would
 * then resolve evidence against the wrong session while still reporting every id as found.
 */
export function dialogIndex(conversation) {
  const index = new Map();
  for (const key of Object.keys(conversation ?? {})) {
    const match = SESSION_KEY.exec(key);
    if (match === null || !Array.isArray(conversation[key])) continue;
    for (const turn of conversation[key]) {
      if (turn !== null && typeof turn === 'object' && typeof turn.dia_id === 'string') {
        index.set(turn.dia_id, { session: Number(match[1]), speaker: String(turn.speaker ?? ''), text: String(turn.text ?? '') });
      }
    }
  }
  return index;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => Number(a) - Number(b)));
}

/**
 * The census: one row per dialogue, plus totals over the corpus.
 *
 * `evidenceResolved` is per dialogue and `evidenceTotal` is its denominator; a reading that quotes the
 * first without the second is the mistake this pair exists to make visible.
 */
export function censusCorpus(samples) {
  const rows = samples.map((sample, ordinal) => {
    const conversation = sample?.conversation ?? {};
    const sessions = sessionNumbers(conversation);
    const index = dialogIndex(conversation);
    const questions = Array.isArray(sample?.qa) ? sample.qa : [];
    const evidence = questions.flatMap((question) => (Array.isArray(question?.evidence) ? question.evidence : []));
    const resolved = evidence.filter((id) => index.has(String(id))).length;
    const dates = sessions.present.map((n) => String(conversation[`session_${n}_date_time`] ?? ''));
    const turns = sessions.present.reduce((total, n) => total + (conversation[`session_${n}`]?.length ?? 0), 0);
    return {
      sampleId: String(sample?.sample_id ?? `#${ordinal}`),
      speakers: [String(conversation.speaker_a ?? ''), String(conversation.speaker_b ?? '')],
      sessionsPresent: sessions.present.length,
      sessionNumbers: sessions.present,
      sessionsWithDateOnly: sessions.declaredOnly,
      turns,
      dialogIds: index.size,
      questions: questions.length,
      categories: countBy(questions.map((question) => question?.category)),
      evidenceTotal: evidence.length,
      evidenceResolved: resolved,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      annotationKeys: Object.keys(sample ?? {}).filter((key) => !['qa', 'conversation', 'sample_id'].includes(key)),
    };
  });

  const total = (pick) => rows.reduce((sum, row) => sum + pick(row), 0);
  return {
    dialogues: rows.length,
    sessions: total((row) => row.sessionsPresent),
    sessionsWithDateOnly: total((row) => row.sessionsWithDateOnly.length),
    turns: total((row) => row.turns),
    questions: total((row) => row.questions),
    categories: rows.reduce((counts, row) => {
      for (const [category, count] of Object.entries(row.categories)) counts[category] = (counts[category] ?? 0) + count;
      return counts;
    }, {}),
    evidenceTotal: total((row) => row.evidenceTotal),
    evidenceResolved: total((row) => row.evidenceResolved),
    rows,
  };
}

/**
 * One flat row per question, with the evidence ids the census found resolvable.
 *
 * `evidence` keeps only the ids that resolve, and `evidenceMissing` keeps the rest. Dropping the
 * missing ones silently would make every question look fully evidenced; keeping them in one array
 * would make a recall reading count a hit for an id that is not in the corpus.
 */
export function flattenQuestions(samples) {
  const questions = [];
  for (const sample of samples) {
    const index = dialogIndex(sample?.conversation ?? {});
    const sampleId = String(sample?.sample_id ?? '');
    for (const [ordinal, question] of (Array.isArray(sample?.qa) ? sample.qa : []).entries()) {
      const evidence = (Array.isArray(question?.evidence) ? question.evidence : []).map(String);
      questions.push({
        sampleId,
        questionId: `${sampleId}#${ordinal}`,
        question: String(question?.question ?? ''),
        gold: String(question?.answer ?? ''),
        category: question?.category ?? null,
        evidence: evidence.filter((id) => index.has(id)),
        evidenceMissing: evidence.filter((id) => !index.has(id)),
      });
    }
  }
  return questions;
}

async function main() {
  const input = flag('--input');
  const outDir = flag('--out-dir');
  if (input === undefined || outDir === undefined) throw new TypeError('pass --input and --out-dir');

  const bytes = readFileSync(input);
  const parsed = JSON.parse(bytes.toString('utf8'));
  const samples = Array.isArray(parsed) ? parsed : Array.isArray(parsed.samples) ? parsed.samples : null;
  if (samples === null) throw new TypeError('neither an array nor an object with a `samples` array');

  const census = censusCorpus(samples);
  const questions = flattenQuestions(samples);
  const annotationKeys = [...new Set(census.rows.flatMap((row) => row.annotationKeys))].sort();

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'locomo-census.json'),
    `${JSON.stringify(
      {
        source: { path: input, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        ...census,
        // Named so that a later reading can say whether it read them. They are annotations *of* the
        // dialogue, not the dialogue, and a system that reads them is not doing retrieval.
        annotationKeys,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(outDir, 'locomo-questions.json'), `${JSON.stringify({ questions }, null, 2)}\n`);

  process.stdout.write(
    [
      `dialogues       ${census.dialogues}`,
      `sessions        ${census.sessions} (+${census.sessionsWithDateOnly} date-only)`,
      `turns           ${census.turns}`,
      `questions       ${census.questions}`,
      `categories      ${JSON.stringify(census.categories)}`,
      `evidence        ${census.evidenceResolved}/${census.evidenceTotal} resolved`,
      `annotations     ${annotationKeys.join(', ')}`,
    ].join('\n') + '\n',
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
