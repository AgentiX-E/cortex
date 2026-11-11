/**
 * The ledger: one row per turn, compiled by program, before any question is asked.
 *
 * ## Why a ledger at all, and why it is built here rather than by a model
 *
 * `reviewPass: 'tally'` asked the reader to write the ledger itself, one item per line with the
 * number it contributes, and the run that measured it (`42855433242`) lost **9.5 multi-session
 * questions** while doubling completion tokens. The per-question autopsy in
 * `MEASURE-REVIEW-TALLY.md` §6.1 found no arithmetic error among the ten losses: the sums were
 * right and the operands were wrong, because "which quantity does this item contribute" is a
 * judgement about the question and the reader was making it while also making the list.
 *
 * The lesson generalises past arithmetic: a ledger produced *after* the question, *by the same call*
 * that answers it, cannot be reused, cannot be inspected before it is used, and cannot be checked
 * against the source. This file builds the other kind — before the question, by program, zero model
 * calls — so that N questions over the same history amortise one construction instead of paying for
 * a prose list each time.
 *
 * ## What a row is, and the honest limit of that
 *
 * A row is a **turn**, not an event. That is the coarsest useful grain this corpus supports without
 * a model: `[2023/05/21 (Sun) 19:38] user: ...` is the unit the source is already divided into, and
 * every field on the row is copied or counted rather than inferred. The finer grain — one row per
 * *action* or *transaction*, which is what TallyMem's annotated ledger and StructMemEval's
 * transaction ledgers both use — needs an annotation pass this increment does not have.
 *
 * The distinction is load-bearing and is measured rather than glossed: `MEASURE-SPEC-CEILING.md`
 * applies hand-written specifications to this ledger on the twenty multi-session failures and
 * reports how many of them the turn grain can express at all. A ceiling below the population means
 * the next increment is the annotation pass, not a longer prompt — and that is a cheaper thing to
 * learn offline than by dispatching.
 *
 * ## Why every field is derived, never inferred
 *
 * `numbers` is the only field that is not a copy of the source, and it is a lexical extraction with
 * a stated shape: a numeral, an optional currency symbol before it or percent sign after it, and an
 * optional unit word after that, with function words rejected as units (`5 to 6 days` gives `5` and
 * `6 days`, not `5 to`). Nothing here decides what a number *means*; `execute.ts` decides which
 * numbers a specification keeps, and `support` reports the steps it kept so a wrong answer can be
 * traced to the row that produced it.
 */

/** One number as it appears in a turn, with the unit the source attached to it. */
type LedgerNumber = {
  /** The numeral, with thousands separators removed and any decimal part preserved. */
  readonly value: number;
  /**
   * The unit as written, lowercased, or `null` when the source attached none.
   *
   * `$` and `¥`/`€`/`£` are units here, and so is `%`: a specification that sums dollars must not
   * sum the page counts beside them, and the only way to say so is to name the unit.
   */
  readonly unit: string | null;
};

/** One turn, with everything a specification is allowed to filter on. */
export type LedgerRow = {
  /** Zero-based position in the whole history, which is what a scope refers to. */
  readonly step: number;
  /** Zero-based position of the session this turn belongs to. */
  readonly session: number;
  /** `YYYY/MM/DD` when the turn carries a timestamp, `null` when it does not. */
  readonly date: string | null;
  /** The speaker as the source wrote it, lowercased; `unknown` when the prefix is absent. */
  readonly role: string;
  /** The turn's words, with the timestamp and speaker prefix removed. */
  readonly text: string;
  /** Every numeral in `text`, left to right. */
  readonly numbers: readonly LedgerNumber[];
};

/** A compiled history: the rows, and the bounds a scope is validated against. */
export type Ledger = {
  readonly rows: readonly LedgerRow[];
  /** `rows.length`, cached because every scope check needs it. */
  readonly steps: number;
  /** Number of sessions the rows came from, which bounds a session predicate. */
  readonly sessions: number;
};

/**
 * The turn prefix this ledger understands: `[<timestamp>] <role>: <text>`.
 *
 * The corpus writes exactly this, and a turn that does not match is not dropped — it becomes a row
 * with `date: null`, `role: 'unknown'` and the whole line as its text. Dropping would make the
 * ledger quietly shorter than the history, and a count over a silently shorter ledger is the defect
 * this whole axis exists to remove.
 */
const TURN_PREFIX = /^\[([^\]]*)\]\s*([A-Za-z][\w-]*):\s?([\s\S]*)$/;

/** A timestamp's date part, which is the only part a specification may filter on. */
const DATE_PART = /^(\d{4}\/\d{2}\/\d{2})/;

/**
 * A numeral with what the source attached to it.
 *
 * Three guards, each of which was a wrong answer before it was a guard:
 *
 * - **Not inside a word, a hyphenated name, a path or a ratio** (`(?<![\w.,:;/\\-$¥€£])`,
 *   `(?![\d:])`): `COVID-19` is not a count of nineteen, `1:1:1` is a ratio rather than three
 *   ones, and `5-6 days` is a range whose upper bound this deliberately does not read.
 * - **A currency symbol binds to the numeral after it**, so `$3,750` is one number in dollars
 *   rather than a bare `3,750` with the currency lost.
 * - **A trailing percent binds tighter than a unit word**, so `85% of` is a percentage rather than
 *   a count of `of`.
 */
const NUMERAL =
  /(?<![\w.,:;/\-$¥€£])([$¥€£])?(\d[\d,]*(?:\.\d+)?)(?![\d:])(?:\s?%)?(?:\s+([A-Za-z]{2,}))?/g;

/**
 * Words that follow a numeral without naming what it counts.
 *
 * `5 to 6 days` is two numbers and one unit; without this list the first would be `5 to`. A unit
 * that is a preposition is not a unit, and a specification filtering on it would filter on grammar.
 */
const NOT_A_UNIT = new Set([
  'to',
  'of',
  'in',
  'on',
  'at',
  'and',
  'or',
  'the',
  'an',
  'for',
  'by',
  'with',
  'from',
  'is',
  'was',
  'it',
  'my',
  'we',
  'me',
  'as',
  'so',
  'if',
  'do',
  'no',
]);

/** Strip thousands separators and read the numeral. */
function toNumber(digits: string): number {
  return Number(digits.replaceAll(',', ''));
}

/** Every numeral in a turn's text, with the unit the source attached to it. */
function extractNumbers(text: string): LedgerNumber[] {
  const found: LedgerNumber[] = [];
  NUMERAL.lastIndex = 0;
  for (let match = NUMERAL.exec(text); match !== null; match = NUMERAL.exec(text)) {
    const currency = match[1] ?? null;
    const digits = match[2] as string;
    const word = match[3] ?? null;
    const percent = match[0].includes('%');
    const unit =
      currency ??
      (percent
        ? '%'
        : word !== null && !NOT_A_UNIT.has(word.toLowerCase())
          ? word.toLowerCase()
          : null);
    found.push({ value: toNumber(digits), unit });
  }
  return found;
}

/**
 * The numerals in any text, by the ledger's own rules.
 *
 * Exported for the authorization in `authorization.ts`, and the export is the point rather than a convenience:
 * that check asks whether *the first answer's token* appears in a selected row, which is a statement about one
 * vocabulary. A second tokeniser reading `1,998` as `1` and `998`, or `COVID-19` as nineteen, would answer a
 * different question from the one the ledger can be audited against.
 */
export function numeralsIn(text: string): readonly number[] {
  return extractNumbers(text).map((number) => number.value);
}

/**
 * Compile sessions into a ledger.
 *
 * Sessions arrive as `string[][]` -- the shape `answerSessions` already receives -- so this runs on
 * exactly the evidence the reader is given, not on a re-read of the corpus. That matters for the
 * census: a specification's `support` steps index the same turns the prompt carried, so a mismatch
 * between what was counted and what was shown is visible instead of plausible.
 */
export function buildLedger(sessions: readonly (readonly string[])[]): Ledger {
  const rows: LedgerRow[] = [];
  let session = 0;
  for (const turns of sessions) {
    for (const turn of turns) {
      const match = TURN_PREFIX.exec(turn);
      const stamp = match?.[1] ?? null;
      const role = match?.[2] ?? null;
      const text = match?.[3] ?? turn;
      const dated = stamp === null ? null : DATE_PART.exec(stamp);
      rows.push({
        step: rows.length,
        session,
        date: dated?.[1] ?? null,
        role: role === null ? 'unknown' : role.toLowerCase(),
        text,
        numbers: extractNumbers(text),
      });
    }
    session += 1;
  }
  return { rows, steps: rows.length, sessions: sessions.length };
}

/**
 * The vocabulary a specification may name, summarised for the prompt.
 *
 * A plan is written against a schema, not against the text, so the prompt needs to know which
 * values exist without being shown the rows: roles, the units numbers carry, the date range and the
 * session count. This is the whole difference in cost between this pass and the last one -- the
 * tally pass re-read the window, and this reads a vocabulary of a few hundred characters.
 */
type LedgerVocabulary = {
  readonly steps: number;
  readonly sessions: number;
  readonly roles: readonly string[];
  readonly units: readonly string[];
  readonly firstDate: string | null;
  readonly lastDate: string | null;
};

/** Summarise a ledger for a prompt, deterministically ordered. */
export function ledgerVocabulary(ledger: Ledger): LedgerVocabulary {
  const roles = new Set<string>();
  const units = new Set<string>();
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  for (const row of ledger.rows) {
    roles.add(row.role);
    for (const number of row.numbers) if (number.unit !== null) units.add(number.unit);
    if (row.date !== null) {
      if (firstDate === null || row.date < firstDate) firstDate = row.date;
      if (lastDate === null || row.date > lastDate) lastDate = row.date;
    }
  }
  return {
    steps: ledger.steps,
    sessions: ledger.sessions,
    roles: [...roles].sort(),
    units: [...units].sort(),
    firstDate,
    lastDate,
  };
}
