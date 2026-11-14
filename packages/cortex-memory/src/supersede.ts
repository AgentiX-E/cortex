/**
 * The adjudicator for the supersession pass: a reader's claim about a later value, checked against the
 * evidence it read, and either accepted or refused.
 *
 * ## The failure this is built against, and why a prompt is not the fix
 *
 * `MEASURE-FAILURE-STABILITY.md` §3 reads the seven `KU` questions that are wrong in **all four**
 * repetitions of `42355323615`. Six of the seven are one failure mode: *the reply answers with a
 * statement the corpus later supersedes*. `ce6d2d27` answers `Thursday` where a later turn restates the
 * class day; `69fee5aa` answers `37` where a later turn adds to a total; `a2f3aa27` answers `1250`
 * where `nearing 1300 followers` is delivered two thirds of the way into the window.
 *
 * The `knowledge-update` contract already states the rule, on every one of those questions, in every
 * one of the four repetitions:
 *
 * > Some evidence may state a value that was later changed... Use the evidence with the latest date in
 * > the evidence that is consistent with the time qualifier in the question.
 *
 * A rule that is present and fails 24 times out of 24 is not a rule that needs rewording. It is a
 * **comparison being demanded across 23,084 characters** — and `852ce960` proves the reader can make
 * the comparison and then discard it: its reply names the later date and explains why it is ignoring
 * it. So the mechanism does not ask again for the answer. It asks for the **one pair** the answer
 * rests on, and then a function decides.
 *
 * ## Why the decision is a function and not a second judgement
 *
 * `temporality.ts` quotes the Prospective Intention Store on exactly this: make the state explicit and
 * the transitions deterministic, and let the model do only the language part. Here the language part is
 * "copy the span that states the later value, and the date on the line you copied it from". Everything
 * after that is a substring test, which is the strongest authorization available in this campaign:
 *
 * - the quote must appear in the evidence **character for character**, so a hallucinated value cannot
 *   be substituted;
 * - the date must appear **on the same evidence record as the quote**, so a real value cannot be
 *   promoted on the strength of a date the model invented;
 * - a quote that merely repeats the first answer is not a supersession, because a pass that "replaces"
 *   an answer with itself spends a call and reports a conversion that never happened.
 *
 * `MEASURE-PLAN-SHAPE.md` is the reason for all three. The specification pass replaced answers without
 * asking whether the answer it replaced was any good, and 43 of its 46 mechanism flips were damages.
 * The lesson registered there is that an authorization gate has to be a property of the **relation
 * between the two answers**, not of the new answer alone. A verbatim span plus its own date on the
 * same line is that relation, and unlike the `support` array it is checkable from the second call
 * alone.
 *
 * ## What this file deliberately does not do
 *
 * It does not decide whether the later statement is *relevant* to the question. That is the reader's
 * job and the reader is good at it — the population fails at applying a comparison, not at finding
 * the candidates. A relevance judgement here would be a second model call to re-answer the question,
 * which is the shape `#repairReply` already refuses.
 *
 * It also does not re-answer on `no`: `no` is a measurement ("the evidence never restates this fact"),
 * and turning it into a retry would make the pass's cost depend on its own reading.
 *
 * ## Why the *value* is substituted and not the span (13.369)
 *
 * The first version of this file substituted the reader's span when the span was short enough:
 * `min(80, max(20, 2 x len(first answer)))`. `42976296380` priced that instrument. It refused **6 of the
 * 10** correct identifications on length alone — `ed4ddc30` by two characters, `a2f3aa27` while quoting
 * `I think I'm close to 1300 now` against a gold of `1300` — and **two of the six were the gate's own
 * targets**. The ceiling was aimed at the right defect (a passage pasted over a value) and built from the
 * wrong property: a span is how the reader demonstrates that it copied, not what should become the answer.
 *
 * So the span is now evidence and the numeral inside it is the answer. Three consequences, each of which
 * this file states rather than inherits:
 *
 * - A span may be as long as the reader needs it to be. Its length is no longer a claim about the answer.
 * - A span that carries no numeral the first answer lacks is a **restatement**, and substituting it would
 *   report a conversion that did not happen (`dad224aa`, whose quote is the answer it was meant to replace).
 * - A span that carries no numeral at all is not reducible that way, and the two document-order targets
 *   whose golds are words (`ce6d2d27` `Friday`, `9ea5eabc` `Paris`) would be unrepresentable. Those spans
 *   are value-shaped by inspection — at most three tokens, no clause punctuation — and are substituted
 *   whole. §13.370 registers that amendment before its dispatch, because a refusal instrument that can eat
 *   a known-correct answer shape is the exact defect `42976296380` was lost to.
 */

/**
 * What the reader said about the pair, before any check.
 *
 * `changed: null` is the unreadable reply — prose instead of the three lines, or a decline. It is not
 * `false`: `false` is a reader that read the evidence and found no later value, which is a different
 * fact about the population and has to stay countable.
 */
export type SupersessionReport = {
  readonly changed: boolean | null;
  /** The span the reader claims states the later value, copied from the evidence. */
  readonly later: string | null;
  /** The date the reader claims sits on the same line as that span. */
  readonly when: string | null;
  /** Which of the three lines were present, so a malformed reply is diagnosable rather than counted. */
  readonly shape: 'three-lines' | 'partial' | 'none';
};

/**
 * Why a claim was refused, one name per reason.
 *
 * Named rather than collapsed into `refused` for the reason §22.88.6 registers about the audit: two
 * defects with one name is one defect the census can no longer see. A run whose refusals are all
 * `not-in-evidence` has a fabricating reader; a run whose refusals are all `restates` has a reader that
 * restated its own answer and nothing else, which is a different report entirely.
 *
 * `too-long` is gone and `restates` takes its place (§13.369). The two are not the same defect renamed:
 * `too-long` refused a span for its length, which is a property of the evidence; `restates` refuses it for
 * carrying no value the answer does not already have, which is a property of the **pair**. The census of
 * `42976296380` read `too-long 27` and could not tell which of those 27 carried a new value, because the
 * reason was stated about the wrong thing.
 */
export type SupersessionRefusal =
  | 'unreadable'
  | 'no-change'
  | 'no-quote'
  | 'agrees'
  | 'restates'
  | 'not-in-evidence'
  | 'date-not-on-line'
  | 'not-later';

/** What the pass should answer, and the record of how it decided. */
export type SupersessionVerdict =
  | { readonly kind: 'keep'; readonly reason: SupersessionRefusal }
  | {
      readonly kind: 'replace';
      readonly value: string;
      readonly record: number;
      /**
       * The two records the decision was authorised by.
       *
       * ## Why the receipt travels with the verdict
       *
       * `adjudicateSupersession` has already established three things when it reaches `replace`: the quote
       * is in the evidence character for character, the date is on the same record as the quote, and that
       * record is later than the one the previous answer rests on. Those three checks are the strongest
       * authorisation this campaign has, and until now the function threw away everything it learned except
       * a value and an index — so the only way for a caller to know *which records* were authorised was to
       * re-split the evidence itself, which is a second implementation of a decision that had already been
       * made.
       *
       * Returning them is not extra information: it is the same information, in the form the caller needs it.
       * `semantic-facts.ts` turns this pair into a bitemporal fact, and a fact built from a re-derived split
       * would be able to disagree with the verdict that authorised it.
       *
       * `earlier` is `null` when the previous answer could not be located in the evidence — a composed answer
       * has no record to be later than, which the ordering check already treats as "skip the comparison"
       * rather than as a failure.
       */
      readonly authorised: SupersessionAuthorisation;
    };

/** One evidence record a substitution was authorised by, as the record itself said it. */
type AuthorisedRecord = {
  /** The record's own text, verbatim, header and continuation lines included. */
  readonly text: string;
  /** The stamp the record opens with, exactly as written; `null` for a record that opens with no bracket. */
  readonly date: string | null;
  /** That stamp as epoch milliseconds, or `null` when it does not parse. Both axes need a time. */
  readonly at: number | null;
};

type SupersessionAuthorisation = {
  /** The record the substituted value was quoted from. */
  readonly later: AuthorisedRecord;
  /** The record the previous answer was located in, or `null` when it was not located at all. */
  readonly earlier: AuthorisedRecord | null;
};

/**
 * The numeral inside one whitespace-delimited token. `7:30` is a time, not two counts.
 *
 * The token's **characters** are kept and only its count is compared, because the grader reads characters
 * and `$3,750` is not `3750 $`. Formatting is the evidence's, never this module's.
 */
const DIGITS_IN_TOKEN = /\d[\d,]*(?:\.\d+)?/;

/** A calendar date is the `WHEN` field's business, never the substituted value. */
const DATE_TOKEN = /^\d{4}\/\d{1,2}\/\d{1,2}/;

/**
 * Words that follow a numeral without naming what it counts.
 *
 * Shorter than `ledger.ts`'s list on purpose. That one filters specifications, where `5 to 6` must not
 * become a count of `to`; this one decides whether a unit is part of the value the answer keeps, and it
 * must therefore be conservative in the other direction: dropping a real unit turns `30 dozen` into `30`.
 * Only words that cannot be a unit at all are listed.
 */
const NOT_A_UNIT = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'now',
  'of',
  'on',
  'or',
  'so',
  'than',
  'that',
  'the',
  'then',
  'there',
  'this',
  'to',
  'was',
  'were',
  'when',
  'which',
  'will',
  'with',
  'you',
]);

/** The tokens of a span, with the record header removed because a date is not a value. */
function tokensOf(text: string): readonly string[] {
  return text
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** The count inside a token, or `null` for a token with no numeral and for a calendar date. */
function countOf(token: string): string | null {
  const cleaned = token.replace(/^["'`“‘([]+/, '');
  if (DATE_TOKEN.test(cleaned)) return null;
  const match = DIGITS_IN_TOKEN.exec(cleaned);
  return match === null ? null : match[0].replaceAll(',', '');
}

/** Every count in a text, by the rule above, in the order the text states them. */
function countsOf(text: string): readonly string[] {
  return tokensOf(text)
    .map(countOf)
    .filter((count): count is string => count !== null);
}

/**
 * Whether a span is a value rather than a clause: at most three tokens, no clause punctuation.
 *
 * This is the shape test the ceiling was trying to be. `Friday`, `Paris` and `6:00 pm` pass it; a sentence
 * with a comma, a question or a semicolon in it does not, and a span of four or more tokens does not. It is
 * stated on the comparison key so a trailing full stop is not the difference between a value and a clause.
 *
 * No empty-key guard: the caller has already refused a span whose key is empty as `no-quote`, and a second
 * copy of that check here would be a branch no input can reach -- the dead-code shape this campaign removes
 * rather than tolerates.
 */
function isValueShaped(span: string): boolean {
  const key = comparisonKey(span);
  if (/[,;!?]/.test(key)) return false;
  return key.split(' ').length <= 3;
}

/** The unit a numeral carries, when the token after it names one. */
function unitAfter(tokens: readonly string[], index: number): string | null {
  const next = tokens[index + 1];
  if (next === undefined) return null;
  const cleaned = next.replace(/^["'`“‘([]+/, '').replace(/["'`”’)\],.;!?]+$/, '');
  if (!/^[A-Za-z][A-Za-z.%-]{0,11}$/.test(cleaned)) return null;
  return NOT_A_UNIT.has(cleaned.toLowerCase()) ? null : cleaned;
}

/**
 * What the answer becomes: the value the span carries and the first answer does not.
 *
 * Three outcomes, in the order they are decided:
 *
 * 1. **A new numeral.** The last one in the span, plus the unit that follows it when the next token names
 *    one. The last rather than the first because a single span that states two counts states the second
 *    about the first — the same ordering rule the pass applies across turns, applied within one span.
 * 2. **No numeral at all, and a value-shaped span.** `Friday` against `Thursday` has no numeral to reduce
 *    to, and substituting the span is what the mechanism did before the ceiling refused it.
 * 3. **Numerals, all of them already in the answer.** That is a restatement, and substituting it would
 *    report a conversion that never happened.
 */
function substitutedValue(
  span: string,
  firstAnswer: string,
): { readonly kind: 'value'; readonly value: string } | { readonly kind: 'restates' } {
  const tokens = tokensOf(span);
  const known = new Set(countsOf(firstAnswer));
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] as string;
    const count = countOf(token);
    if (count === null || known.has(count)) continue;
    const unit = unitAfter(tokens, index);
    return { kind: 'value', value: unit === null ? token : `${token} ${unit}` };
  }
  if (countsOf(span).length === 0 && isValueShaped(span)) {
    return { kind: 'value', value: span.trim() };
  }
  return { kind: 'restates' };
}

/**
 * A record's stamp as a comparable tuple, or `null` when the record carries no readable date.
 *
 * The renderer writes `[2023/03/12 (Sun) 11:40]`, and the weekday is dropped because it is derivable and
 * because a comparison over it would order two same-day records by the spelling of a day name. Minutes are
 * included: `a2f3aa27`'s two statements are on the same day, and the whole question is which came second.
 *
 * A named tuple rather than `readonly number[]` because the five components are consumed positionally by
 * both the ordering and the epoch conversion, and an array type would let either read past the end.
 */
type StampKey = readonly [number, number, number, number, number];

function stampKey(date: string | null): StampKey | null {
  if (date === null) return null;
  const match = /(\d{4})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{1,2})(?:[^\d]*(\d{1,2}):(\d{2}))?/.exec(
    date,
  );
  if (match === null) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
  ];
}

/**
 * The tuple as one comparable integer: year in the 10^8 column, month in 10^6, day in 10^4, hour in 10^2,
 * minute in 10^0.
 *
 * One number rather than an element-wise comparison, because the digits fit their columns on every input the
 * renderer can produce (month <= 12, day <= 31, hour <= 23, minute <= 59) and a scalar makes the ordering a
 * single comparison at the call site instead of a loop with a branch per component -- a loop is three places for
 * an off-by-one and one place a reader has to check.
 */
function stampOrder(key: readonly number[]): number {
  return key.reduce((total, part, index) => total + part * 10 ** (8 - index * 2), 0);
}

/**
 * The same stamp as epoch milliseconds, or `null` when it is not a calendar date.
 *
 * ## Why the round trip is checked
 *
 * `Date.UTC` normalises rather than refuses: a stamp of `2023/13/45` becomes 2024-02-14, and a fact dated
 * with the corrected instant is a fact whose `at` no longer matches the record it quotes. Everything
 * downstream of this function — ordering, `deriveSupersedes`, the window filter — would then be reasoning
 * about a date the corpus never said. The renderer cannot emit such a stamp, but the value arrives through
 * `[\d{1,2}]` capture groups that *can*, and the check costs one comparison.
 */
function stampEpoch(key: StampKey | null): number | null {
  if (key === null) return null;
  const [year, month, day, hour, minute] = key;
  const epoch = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(epoch)) return null;
  const check = new Date(epoch);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return epoch;
}

/** One record as the authorisation it is. */
function recordAt(record: EvidenceRecord): AuthorisedRecord {
  return { text: record.text, date: record.date, at: stampEpoch(stampKey(record.date)) };
}

/** One evidence record: the line that opens it, and the continuation lines under it. */
type EvidenceRecord = { readonly text: string; readonly date: string | null };

/**
 * A line that opens an evidence record.
 *
 * ## The defect this pattern exists to repair
 *
 * The previous form was `line.trimStart().startsWith('[')`, and it was wrong on **every real prompt**. The
 * renderer numbers its turns — `formatEvidence`'s default label is `` `${index + 1}. ` `` — so a delivered
 * record opens `1. [2023/01/15 (Sun) 09:10] user: …` and no line of a real window starts with a bracket. The
 * splitter therefore produced **one record holding the entire evidence**, and three things followed:
 *
 * - `record` was `0` on every substitution, so the field the census publishes described nothing;
 * - the "same line" date rule degraded from *the date is on this record* to *the date is somewhere in the
 *   window*, which is a different and much weaker claim;
 * - **the ordering check never ran.** `answerRecord` and `last.index` were both `0`, and the guard skips a
 *   comparison inside one record by design — so `§13.371`'s `not-later` guard, the one written to stop a
 *   correct answer being replaced by the value it supersedes, was unreachable on the shipping path.
 *
 * The fixtures in `supersede.test.ts` were unnumbered, which is why every unit test of the guard passed while
 * the guard did nothing: they were testing a rendering the product never produces. Found while building the
 * fact source, which needs the record's own date and therefore needed the split to be real.
 *
 * The prefix is optional so an unnumbered evidence — a caller's own rendering, and every fixture written
 * before this repair — keeps the exact split it had.
 */
const RECORD_OPENS = /^\s*(?:#\d+\s|\d+\.\s)?\[/;

/**
 * Split the rendered evidence into records, by the date bracket that opens each turn.
 *
 * The renderer keeps a turn's own text verbatim, and a turn may contain newlines, so a line is not the
 * unit: the **record** is. A record opens at a line whose first non-space character — after the renderer's
 * position label, which {@link RECORD_OPENS} accounts for — is `[`, and owns every following line up to the
 * next such line. That is the shape `formatEvidence` produces from the dataset's
 * `[2023/02/15 (Wed) 01:41] speaker: text` rendering, and it is the shape the "same line" rule in the
 * instruction refers to.
 *
 * Evidence that opens with no bracket at all becomes a single record, which is the honest reading:
 * there is no boundary to split on, so a date requirement against it can only fail closed.
 */
function evidenceRecords(evidence: string): readonly EvidenceRecord[] {
  const records: { text: string; date: string | null }[] = [];
  for (const line of evidence.split('\n')) {
    const opens = RECORD_OPENS.test(line);
    if (opens || records.length === 0) {
      records.push({ text: line, date: null });
      continue;
    }
    const last = records[records.length - 1] as { text: string; date: string | null };
    last.text = `${last.text}\n${line}`;
  }
  return records.map((record) => {
    const match = /\[\s*([^\]]+?)\s*\]/.exec(record.text);
    // The capture group is non-optional, so a match always has one; the only absence is the record that
    // opens with no bracket at all.
    //
    // The trailing newlines are the separator the renderer put *between* turns (`\n\n`), not part of the turn
    // that follows them, and they are stripped so a record's text is the turn's text. Nothing that reads this
    // compares raw bytes — `comparisonKey` folds whitespace — but a caller that stores the text, which the fact
    // source does, would otherwise carry a separator into a sentence.
    return {
      text: record.text.replace(/\n+$/, ''),
      date: match === null ? null : (match[1] as string),
    };
  });
}

/**
 * The comparison key: case-folded, whitespace-collapsed, with the punctuation a quote arrives wrapped
 * in removed.
 *
 * Comparison is on this key and never on the raw span, because a reader that copies `"Friday."` has
 * copied `Friday`. Nothing else is normalised: a book-title colon or a `$` is part of the value, and a
 * key that dropped either would authorise a substitution the evidence does not contain.
 */
function comparisonKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`“‘([]+/, '')
    .replace(/["'`”’)\],.;!?]+$/, '')
    .trim();
}

/**
 * Read the three lines. Anything else is `shape: 'none'` and `changed: null`.
 *
 * The labels are matched case-insensitively and tolerate surrounding whitespace, because a model that
 * writes `CHANGED:  Yes` has answered the question. Nothing else is tolerated: a reply that rewords
 * the labels is a reply whose author did not follow the contract, and reading it generously would make
 * the pass's behaviour a function of how a particular model phrases things.
 */
export function parseSupersessionReport(raw: string | null | undefined): SupersessionReport {
  const text = (raw ?? '').trim();
  if (text.length === 0) return { changed: null, later: null, when: null, shape: 'none' };
  // `[ \t]` rather than `\s` around the colon: `\s` matches a newline, so a reply whose `LATER:` line is
  // empty had the **next line** captured as its value -- `LATER:\nWHEN:` read as a quote of `WHEN:`. The
  // census then refused it as `not-in-evidence`, which is the right verdict for the wrong reason and would
  // have been invisible in a run whose refusals are dominated by that reason anyway.
  const field = (label: string): string | null => {
    const match = new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*)$`, 'im').exec(text);
    if (match === null) return null;
    const value = (match[1] as string).trim();
    return value.length === 0 ? null : value;
  };
  const changedRaw = field('CHANGED');
  const later = field('LATER');
  const when = field('WHEN');
  const present = [changedRaw, later, when].filter((value) => value !== null).length;
  const shape: SupersessionReport['shape'] =
    present === 3 ? 'three-lines' : present === 0 ? 'none' : 'partial';
  let changed: boolean | null = null;
  if (changedRaw !== null) {
    const head = changedRaw.toLowerCase().replace(/[^a-z]/g, '');
    if (head.startsWith('yes')) changed = true;
    else if (head.startsWith('no')) changed = false;
  }
  return { changed, later: noneIfPlaceholder(later), when: noneIfPlaceholder(when), shape };
}

/** `NONE` is the contract's way of saying "nothing here", and it is not a value. */
function noneIfPlaceholder(value: string | null): string | null {
  return value !== null && comparisonKey(value) === 'none' ? null : value;
}

/**
 * The whole decision: a report, the answer it is about, and the evidence both of them read.
 *
 * The order of the checks is the order of the costs they impose on a correct answer, cheapest first,
 * and every `keep` is a named refusal rather than a silent pass.
 */
export function adjudicateSupersession(
  report: SupersessionReport,
  firstAnswer: string,
  evidence: string,
): SupersessionVerdict {
  if (report.changed === null) return { kind: 'keep', reason: 'unreadable' };
  if (!report.changed) return { kind: 'keep', reason: 'no-change' };
  if (report.later === null) return { kind: 'keep', reason: 'no-quote' };

  const quote = comparisonKey(report.later);
  if (quote.length === 0) return { kind: 'keep', reason: 'no-quote' };
  // A quote that is the answer it is meant to replace is not a supersession. Without this the pass
  // would report `replace` on every question where the reader dutifully copied its own answer, and the
  // census's `replaced` would count conversions that never happened.
  if (quote === comparisonKey(firstAnswer)) return { kind: 'keep', reason: 'agrees' };
  // The value, not the span (§13.369). A span is how the reader shows it copied; the numeral inside it is
  // what the answer becomes. A span whose numerals are all already in the answer is a restatement.
  const value = substitutedValue(report.later, firstAnswer);
  if (value.kind === 'restates') return { kind: 'keep', reason: 'restates' };

  const records = evidenceRecords(evidence);
  const matching = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => comparisonKey(record.text).includes(quote));
  if (matching.length === 0) return { kind: 'keep', reason: 'not-in-evidence' };

  // The date must sit on **every** record the quote appears on. Requiring it on the last one only
  // would accept a value that also appears earlier under a different date -- which is exactly the
  // question this pass exists to get right, so the stricter rule is the correct one and it fails
  // closed.
  if (report.when === null) return { kind: 'keep', reason: 'date-not-on-line' };
  const when = comparisonKey(report.when);
  if (when.length === 0) return { kind: 'keep', reason: 'date-not-on-line' };
  const dated = matching.every(({ record }) => comparisonKey(record.text).includes(when));
  if (!dated) return { kind: 'keep', reason: 'date-not-on-line' };

  const last = matching[matching.length - 1] as { record: EvidenceRecord; index: number };

  // The ordering check (§13.371). Everything above proves the span is *in* the evidence and *dated*; none of it
  // proves the span is **later** than the statement the answer rests on, and that is the direction the mechanism
  // is named for. `ed4ddc30` is the measurement: its only offered span is `30 dozen at the moment` from the
  // January turn, the answer's own `20 dozen` is the March one, and the gold is `20`. Both checkable fields pass
  // on that span, so without this check the pass would replace a correct answer with the value it supersedes.
  //
  // The answer's own statement is located by its text, and the comparison is skipped when it cannot be located:
  // an answer the reader composed rather than copied has no turn to be later than, and refusing those would make
  // the guard's reach depend on the answer's phrasing. Same record is also skipped, for the same reason at a
  // smaller scale -- two values stated in one turn have an order no stamp records.
  const answerKey = comparisonKey(firstAnswer);
  let answerRecord: number | null = null;
  if (answerKey.length > 0) {
    for (const { record, index } of records.map((record, index) => ({ record, index }))) {
      if (comparisonKey(record.text).includes(answerKey)) answerRecord = index;
    }
  }
  if (answerRecord !== null && answerRecord !== last.index) {
    const spanStamp = stampKey(last.record.date);
    const answerStamp = stampKey((records[answerRecord] as EvidenceRecord).date);
    if (
      spanStamp !== null &&
      answerStamp !== null &&
      stampOrder(spanStamp) < stampOrder(answerStamp)
    ) {
      return { kind: 'keep', reason: 'not-later' };
    }
  }
  return {
    kind: 'replace',
    value: value.value,
    record: last.index,
    authorised: {
      later: recordAt(last.record),
      // `answerRecord` is the index the ordering check already located, so reusing it is what keeps the
      // receipt and the check from disagreeing about which record the previous answer came from.
      earlier: answerRecord === null ? null : recordAt(records[answerRecord] as EvidenceRecord),
    },
  };
}

/**
 * One substitution as the two strings it was: the answer the pass was handed, and the answer it shipped.
 *
 * ## Why the pair and not the replacement alone
 *
 * `replaced` counts substitutions and says nothing about which direction each went. `43001135439` published
 * `replaced 18` beside `refused 270`, and the eighteen were unreadable: `answer` holds what the pass shipped,
 * so a record shows a wrong final answer and cannot distinguish "the pass damaged a correct answer" from "the
 * answer was already wrong and the pass changed it into another wrong one". §14.110.1 had to re-derive the
 * direction by pairing the arm against a **previous** run's control arm, which cost a second dispatch of the
 * same population.
 *
 * The pair makes the direction a property of one record, so a run can be read the day it lands. `first` is the
 * string the product would have returned with the pass switched off on that question, which is the only
 * counterfactual the mechanism owes an accounting for.
 */
export type SupersessionRewrite = {
  /** What the route answered before the pass was consulted. */
  readonly first: string;
  /** What the pass shipped in its place. */
  readonly final: string;
};

/** An empty census, with every reason present at zero so an artifact never has to infer absence. */
export function emptySupersessionCensus(): {
  attempted: number;
  replaced: number;
  refusals: Record<SupersessionRefusal, number>;
  rewrites: SupersessionRewrite[];
} {
  return {
    attempted: 0,
    replaced: 0,
    // Empty rather than absent, on the opposite rule to `refusals`: a reason's zero is a measurement ("this
    // failure mode did not occur"), and a substitution's text is not something a zero can stand in for. A
    // reader distinguishes "no substitutions" from "not recorded" by `replaced`, which is always present.
    rewrites: [],
    refusals: {
      unreadable: 0,
      'no-change': 0,
      'no-quote': 0,
      agrees: 0,
      restates: 0,
      'not-in-evidence': 0,
      'date-not-on-line': 0,
      'not-later': 0,
    },
  };
}
