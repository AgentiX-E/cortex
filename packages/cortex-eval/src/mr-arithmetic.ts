/**
 * Deterministic arithmetic for multi-session (MR) questions.
 *
 * The multi-session aggregation prompt asks the LLM to both READ the numeric
 * values scattered across sessions AND compute their total. The failure mode the
 * deterministic engine removes is not reading the numbers but the arithmetic:
 * the model sums while it reads, so it silently drops one addend (under-count)
 * or double-counts one. Splitting the task into "extract every number, then add"
 * mirrors the temporal engine's "extract every event date, then compute" split,
 * which already proved that deterministic arithmetic is more reliable than
 * leaving the final computation to the LLM.
 */
export type ArithmeticKind = 'sum';

/**
 * Classify a question as a deterministic-arithmetic kind, or `null` when it is
 * not a plain summation. Deduplication-count questions ("how many different X")
 * are explicitly excluded because their answer needs entity identity, not a sum
 * of already-stated numbers.
 */
export function classifyArithmeticQuestion(question: string): ArithmeticKind | null {
  if (/\b(different|distinct)\b/i.test(question)) {
    return null;
  }
  if (/\b(in total|page count|combined|altogether|sum of)\b/i.test(question)) {
    return 'sum';
  }
  if (/\btotal\b/i.test(question)) {
    return 'sum';
  }
  return null;
}

/** Sum the extracted numbers, or return `null` when nothing was extracted. */
export function computeSum(numbers: readonly number[]): number | null {
  if (numbers.length === 0) {
    return null;
  }
  return numbers.reduce((acc, value) => acc + value, 0);
}

/**
 * Render a computed number without IEEE-754 noise (0.1 + 0.2 = 0.3, not
 * 0.30000000000000004). Integers keep no decimal part; fractions keep up to two
 * places, which matches the precision the benchmark's ground truth uses.
 */
export function formatArithmeticAnswer(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}
