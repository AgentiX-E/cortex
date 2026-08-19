/**
 * Temporal-reasoning primitives for LongMemEval-style benchmarks. Temporal
 * questions require reasoning over turn timestamps: "how many days between X and
 * Y", "how many weeks ago did I do X", "which happened first". These helpers
 * extract the turn date, compute elapsed days, and detect the question shape so
 * the system can route temporal questions to a dedicated answering path.
 */

/** True when a question asks about relative/absolute time or event ordering. */
export function isTemporalQuestion(question: string): boolean {
  return /\b(how many (days|weeks|months|hours)|ago|before or after|happened first|which .* first|order from first)/i.test(
    question,
  );
}

/**
 * Extract the `[YYYY/MM/DD]` date from a `turnText`-rendered turn. Returns
 * `undefined` when the turn carries no date prefix.
 */
export function extractDate(turn: string): string | undefined {
  const match = turn.match(/^\s*\[(\d{4}\/\d{2}\/\d{2})/);
  return match?.[1];
}

const MS_PER_DAY = 86_400_000;

/**
 * Signed whole days from date `a` to date `b` (both `YYYY/MM/DD`), computed in
 * UTC so daylight-saving transitions never shift the result. Positive when `b`
 * is later than `a`.
 */
export function daysBetween(a: string, b: string): number {
  const toUtcDays = (s: string): number => {
    const [y, m, d] = s.split('/').map(Number);
    if (y === undefined || m === undefined || d === undefined) {
      throw new Error(`invalid date "${s}", expected YYYY/MM/DD`);
    }
    return Date.UTC(y, m - 1, d) / MS_PER_DAY;
  };
  return toUtcDays(b) - toUtcDays(a);
}
