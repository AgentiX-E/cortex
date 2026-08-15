/**
 * Self-contained mini benchmark in the style of LongMemEval. Exercises the five
 * capabilities (IE / MR / KU / TR / ABS) over a synthetic user narrative. No
 * runtime network dependency; the full LongMemEval / BEAM datasets can be loaded
 * through the same `BenchmarkDataset` contract in production.
 */
import type { BenchmarkDataset, Question } from '../types.js';

const FACTS: Record<string, string[]> = {
  // Each session key maps to the facts the agent learns in that session.
  january: [
    'Alex lives in New York.',
    'Alex works as a software engineer.',
    "Alex's favorite color is blue.",
  ],
  march: ['Alex moved to Boston in March.', 'Alex became an engineering manager in March.'],
  may: ['Alex adopted a dog named Rex in May.', 'Alex works on project Atlas.'],
  july: ['Alex switched to project Beacon in July.'],
};

function allFacts(): string[] {
  return Object.values(FACTS).flat();
}

function q(
  id: string,
  capability: Question['capability'],
  question: string,
  expected: string | null,
  context?: string[],
): Question {
  return { id, capability, question, expected, context: context ?? allFacts() };
}

export function createLongMemEvalMini(): BenchmarkDataset {
  return {
    name: 'longmemeval-mini',
    questions: [
      // Information Extraction (single-fact lookup).
      q('ie-1', 'IE', "What is Alex's favorite color?", 'blue'),
      q('ie-2', 'IE', "What is the name of Alex's dog?", 'Rex'),
      q('ie-3', 'IE', 'Which project is Alex working on now?', 'Beacon'),

      // Knowledge Update (world state changed; answer reflects the latest).
      q('ku-1', 'KU', 'Where does Alex live now?', 'Boston'),
      q('ku-2', 'KU', "What is Alex's current job title?", 'engineering manager'),

      // Temporal Reasoning (ordering and as-of queries).
      q('tr-1', 'TR', "What was Alex's job title in January?", 'software engineer'),
      q('tr-2', 'TR', 'Which city did Alex live in before Boston?', 'New York'),
      q('tr-3', 'TR', 'Did Alex adopt a dog before or after moving to Boston?', 'after'),

      // Multi-session Reasoning (combining facts across sessions).
      q('mr-1', 'MR', 'Which project did Alex work on before Beacon?', 'Atlas'),
      q('mr-2', 'MR', 'What did Alex do in March?', 'moved to Boston'),

      // Abstention (the correct response is to refuse, not hallucinate).
      q('abs-1', 'ABS', "What is Alex's favorite food?", null),
      q('abs-2', 'ABS', "What is Alex's phone number?", null),
      q('abs-3', 'ABS', "What is Alex's email address?", null),
    ],
  };
}
