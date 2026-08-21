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

/** A turn paired with the `YYYY/MM/DD` date extracted from its prefix. */
export type DatedTurn = {
  date: string;
  /** The full turn text, including its `[YYYY/MM/DD ...]` prefix. */
  text: string;
};

/**
 * Extract the dated turns from a flattened context list. Turns without a date
 * prefix are dropped because a temporal answer is only computable from turns
 * whose date is known.
 */
export function extractDatedTurns(turns: readonly string[]): DatedTurn[] {
  const out: DatedTurn[] = [];
  for (const turn of turns) {
    const date = extractDate(turn);
    if (date !== undefined) {
      out.push({ date, text: turn });
    }
  }
  return out;
}

/**
 * Build a compact chronological evidence list from dated turns, bounded to
 * `maxChars`. When the list exceeds the budget the OLDEST turns are dropped
 * first, because "how long ago" temporal questions reference recent events and
 * "between"/"first" questions still keep both ends as long as the budget allows.
 * The kept turns are returned in chronological order (oldest first).
 */
export function buildTemporalEvidence(turns: readonly DatedTurn[], maxChars: number): string {
  const sorted = [...turns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const kept: DatedTurn[] = [];
  let used = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const turn = sorted[i]!;
    const cost = turn.text.length + 1;
    if (used + cost > maxChars && kept.length > 0) {
      break;
    }
    kept.push(turn);
    used += cost;
  }
  return kept
    .reverse()
    .map((turn) => turn.text)
    .join('\n');
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
