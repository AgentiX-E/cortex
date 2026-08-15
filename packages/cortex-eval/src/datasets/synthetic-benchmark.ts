/**
 * Deterministic synthetic benchmark generator. Produces a LongMemEval-style
 * dataset at arbitrary scale with a seeded PRNG, covering Information Extraction
 * (single-fact retrieval) and Abstention (unanswerable queries). Fact keys are
 * key=value strings so the answer extraction is unambiguous, and every question
 * receives the full fact corpus as context to exercise retrieval relevance.
 */
import type { BenchmarkDataset, Question } from '../types.js';

export type SyntheticBenchmarkOptions = {
  numPeople?: number;
  attributesPerPerson?: number;
  abstentionPerPerson?: number;
  seed?: number;
};

const NAMES = [
  'alice',
  'bob',
  'carol',
  'dave',
  'erin',
  'frank',
  'grace',
  'henry',
  'ivy',
  'jack',
  'kate',
  'leo',
  'mia',
  'noah',
  'olivia',
  'peter',
  'quinn',
  'rose',
];
const CITIES = ['new york', 'boston', 'london', 'tokyo', 'paris', 'berlin'];
const JOBS = ['engineer', 'manager', 'doctor', 'teacher', 'artist', 'chef'];
const COLORS = ['blue', 'red', 'green', 'yellow', 'purple', 'orange'];
const PETS = ['dog', 'cat', 'fish', 'bird', 'hamster', 'rabbit'];
const HOBBIES = ['reading', 'gaming', 'painting', 'hiking', 'cooking', 'cycling'];
const UNKNOWN_ATTRIBUTES = [
  'phone number',
  'email address',
  'birthday',
  'favorite food',
  'shoe size',
];

type Attribute = { key: string; value: string };

function attributesFor(personIndex: number, count: number): Attribute[] {
  const all: Attribute[] = [
    { key: 'city', value: CITIES[personIndex % CITIES.length]! },
    { key: 'job', value: JOBS[(personIndex * 2 + 1) % JOBS.length]! },
    { key: 'color', value: COLORS[(personIndex * 3 + 2) % COLORS.length]! },
    { key: 'pet', value: PETS[(personIndex * 5 + 3) % PETS.length]! },
    { key: 'hobby', value: HOBBIES[(personIndex * 7 + 4) % HOBBIES.length]! },
  ];
  return all.slice(0, Math.min(count, all.length));
}

/** mulberry32 seeded PRNG (deterministic across runs and platforms). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSyntheticBenchmark(
  options: SyntheticBenchmarkOptions = {},
): BenchmarkDataset {
  const numPeople = options.numPeople ?? 12;
  const attributesPerPerson = options.attributesPerPerson ?? 3;
  const abstentionPerPerson = options.abstentionPerPerson ?? 2;
  const seed = options.seed ?? 42;
  if (numPeople < 1 || attributesPerPerson < 1 || abstentionPerPerson < 0) {
    throw new Error('invalid synthetic benchmark parameters');
  }

  const rand = mulberry32(seed);
  const facts: string[] = [];
  const questions: Question[] = [];

  for (let i = 0; i < numPeople; i++) {
    const name = NAMES[i % NAMES.length]!;
    const attrs = attributesFor(i, attributesPerPerson);
    for (const attr of attrs) {
      facts.push(`${name} ${attr.key}=${attr.value}`);
    }
  }

  for (let i = 0; i < numPeople; i++) {
    const name = NAMES[i % NAMES.length]!;
    const attrs = attributesFor(i, attributesPerPerson);

    // Information Extraction questions (single-fact retrieval).
    for (const attr of attrs) {
      questions.push({
        id: `ie-${name}-${attr.key}`,
        capability: 'IE',
        question: `What is ${name}'s ${attr.key}?`,
        expected: attr.value,
        context: [...facts],
      });
    }

    // Abstention questions (unanswerable).
    for (let a = 0; a < abstentionPerPerson; a++) {
      const unknown = UNKNOWN_ATTRIBUTES[Math.floor(rand() * UNKNOWN_ATTRIBUTES.length)]!;
      questions.push({
        id: `abs-${name}-${a}`,
        capability: 'ABS',
        question: `What is ${name}'s ${unknown}?`,
        expected: null,
        context: [...facts],
      });
    }
  }

  return { name: 'synthetic', questions };
}
