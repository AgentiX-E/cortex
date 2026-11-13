#!/usr/bin/env node
/**
 * One text, one vector: a census of what the product's index actually paid for.
 *
 * ## Why this is a tool and not a test
 *
 * The property is an arithmetic relation between four counters that only exist **after** three questions have
 * been asked of one instance, and the acceptance matrix can only read a **number in a file**. A unit test
 * asserts the relation; this writes the same relation down where the matrix can gate on it, so "the second
 * question embeds one text" is a value the build recomputes rather than a sentence in a plan.
 *
 * ## What is measured, exactly
 *
 * One instance, one four-turn corpus, three questions. Two arms of the *same* code:
 *
 *   reuse   `index: { embed }`                          the default, and the shipped configuration
 *   cold    `index: { embed, reuse: false }`             the same index with the store switched off
 *
 * The prompts and answers are compared byte for byte across the arms, because the only pre-registerable shape
 * for a caching change is "it moves work, never output". The counters are read per question, so the first
 * question's cold cost and the second question's warm cost are both visible in one artifact instead of one
 * average that hides both.
 *
 * ## What it does not measure
 *
 * Wall-clock and money. Both depend on a network and a price list; the count it reports is the thing those
 * two multiply, so a run that moves the count has moved both by the same factor.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(REPO, '../cortex-docs/evidence/embedding-reuse/census.json');

const { CortexMemory } = await import(join(REPO, 'packages/cortex-memory/dist/index.js'));

const NOW = 1_759_470_000_000;

/** Four turns with distinct terms, so every question has something to rank and nothing is a tie. */
const CORPUS = [
  'the bicycle was repaired on tuesday',
  'a parcel arrived for the neighbour',
  'the invoice was paid late again',
  'rain cancelled the football match',
];

const QUESTIONS = [
  'when was the bicycle repaired?',
  'did the parcel arrive?',
  'why was the invoice late?',
];

/** A bag-of-words embedder that counts what it was asked. Deterministic, so two arms see identical vectors. */
function embedder() {
  const vocabulary = ['bicycle', 'parcel', 'invoice', 'rain', 'paid', 'late', 'arrived'];
  const calls = [];
  return {
    calls,
    embed: (texts) => {
      calls.push([...texts]);
      return Promise.resolve(
        texts.map((text) => {
          const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
          return vocabulary.map((term) => (words.has(term) ? 1 : 0));
        }),
      );
    },
  };
}

/** An `LLM` that answers the same way every time and records the prompt it was given. */
function reader() {
  const prompts = [];
  return {
    prompts,
    llm: {
      complete: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve('42');
      },
      completeStructured: () => Promise.reject(new Error('unused')),
    },
  };
}

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: () => 1,
};

async function run(index) {
  const { prompts, llm } = reader();
  const system = new CortexMemory({ now: NOW, gate: GATE, llm, index });
  const answers = [];
  const perQuestion = [];
  for (const question of QUESTIONS) {
    answers.push(await system.answer(question, CORPUS));
    const census = system.lastIndexCensus();
    perQuestion.push({
      embedCalls: census.embedCalls,
      embedTexts: census.embedTexts,
      memoHits: census.memoHits,
      reuse: census.reuse,
    });
  }
  return { prompts, answers, perQuestion };
}

const warm = await run({ embed: embedder().embed });
const cold = await run({ embed: embedder().embed, reuse: false });

const promptsIdentical = warm.prompts.length === cold.prompts.length &&
  warm.prompts.every((prompt, position) => prompt === cold.prompts[position]);
const answersIdentical = JSON.stringify(warm.answers) === JSON.stringify(cold.answers);

const total = (arm) => arm.perQuestion.reduce((sum, entry) => sum + entry.embedTexts, 0);
const warmTexts = total(warm);
const coldTexts = total(cold);

const census = {
  $comment:
    'Written by tools/embedding-reuse-census.mjs. One CortexMemory instance, a four-turn corpus and three ' +
    'questions, run twice: once with the embedding store and once with `reuse: false`. A number here is a ' +
    'recomputation, not a transcription.',
  dataset: 'synthetic: 4 turns, 3 questions, bag-of-words embedder, stub reader',
  corpusTurns: CORPUS.length,
  questions: QUESTIONS.length,
  warm: {
    perQuestion: warm.perQuestion,
    embedTextsTotal: warmTexts,
    memoHitsTotal: warm.perQuestion.reduce((sum, entry) => sum + entry.memoHits, 0),
  },
  cold: {
    perQuestion: cold.perQuestion,
    embedTextsTotal: coldTexts,
  },
  // The two readings the matrix gates on. Booleans are written as 1/0 because a criterion is a number and
  // "identical" is either true or it is a defect.
  secondQuestionEmbedTexts: warm.perQuestion[1].embedTexts,
  coldSecondQuestionEmbedTexts: cold.perQuestion[1].embedTexts,
  identicalPrompts: promptsIdentical ? 1 : 0,
  identicalAnswers: answersIdentical ? 1 : 0,
  // Texts saved over the whole run, as a ratio. Reported because it is the number a cost table multiplies by
  // a price, and because a run where this is zero is a run where the store was not reachable.
  savedRatio: coldTexts === 0 ? 0 : Number(((coldTexts - warmTexts) / coldTexts).toFixed(4)),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(census, null, 2)}\n`);

// A vacuity guard, in the tool rather than in the reader: a corpus of zero turns, or a warm arm that embedded
// the same number of texts as the cold one, would produce a census that says nothing while looking healthy.
if (!promptsIdentical || !answersIdentical) {
  console.error('FAILED: the store moved the prompt or the answer, which is a defect rather than a result');
  process.exitCode = 1;
} else if (census.secondQuestionEmbedTexts >= census.coldSecondQuestionEmbedTexts) {
  console.error(
    `FAILED: the second question embedded ${String(census.secondQuestionEmbedTexts)} texts with the store ` +
      `and ${String(census.coldSecondQuestionEmbedTexts)} without it -- the store is not reachable`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `reuse census ok -- ${String(warmTexts)} texts with the store against ${String(coldTexts)} without it ` +
      `(${(census.savedRatio * 100).toFixed(1)}% saved); second question ${String(census.secondQuestionEmbedTexts)} ` +
      'text(s); prompts and answers identical',
  );
}
