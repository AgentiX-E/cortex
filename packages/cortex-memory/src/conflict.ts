/**
 * Which statements in the window state the same detail twice, and which came later.
 *
 * ## The failure this is aimed at, named on the artifact
 *
 * On run `42355323615` — 500 questions, four repetitions, `deepseek-chat` as the reader — seven
 * `KU` questions are wrong in all four repetitions and nothing else in that capability is. Five of
 * the seven answer with a value the corpus **later replaced**, and the later statement is inside the
 * delivered window every time:
 *
 * | question | gold | the reply | the earlier statement | the later statement |
 * | --- | --- | --- | --- | --- |
 * | `ce6d2d27` | `Friday` | `Thursday` | 2023/06/16 "class on Thursday" | 2023/06/30 "class on Fridays" |
 * | `9ea5eabc` | `Paris` | `Hawaii` | 2023/05/26 "trip to Hawaii" | 2023/05/28 "trip to Paris" |
 * | `ed4ddc30` | `20` | `30 dozen` | 2023/01/11 "30 dozen at the moment" | 2023/03/15 "20 dozen right now" |
 * | `59524333` | `6:00 pm` | `7:00 pm` | 2023/02/11 "usually 7:00 pm" | 2023/05/30 "usually at 6:00 pm" |
 * | `a2f3aa27` | `1300` | `1250` | 2023/05/25 "1250 followers now" | 2023/05/25 "close to 1300 now" |
 *
 * Four of those five are what this file reaches **on the real windows**, not on the four-line
 * excerpts the table shows, and the fifth is a measured miss worth stating: `a2f3aa27`'s replacing
 * statement, "I think I'm close to 1300 now", sits inside a long turn whose best sentence by term
 * overlap is the turn's opening ("I'm looking to create a new Instagram post"), so it shares one term
 * with the question where the statement it replaces shares two. Every sentence of that turn is about
 * Instagram and only one of them carries the number, which is a **segmentation** problem rather than
 * a recency one; widening the term threshold until it reached that sentence would also admit every
 * turn that mentions Instagram once. It is recorded as a reach limit in
 * `docs/MEASURE-CONFLICT-SURFACING.md` §2 rather than tuned for, because a threshold fitted to one
 * question is not a mechanism.
 *
 * The shipped instruction block already says what to do with that pair — `knowledge-update` carries
 * "use the evidence with the latest date ... if it asks for the current or most recent value, reply
 * with the later one". The reader has the rule, has both statements, and answers with the earlier
 * one, which is a **comparison the reader has to find before it can perform**: the pair sits inside
 * 23,084 characters of conversation, and on `ce6d2d27` the earlier statement is turn 4 of 66.
 *
 * ## What this computes, and what it deliberately does not
 *
 * It does not decide which value is current. It finds the turns whose best sentence shares terms
 * with the **question**, keeps the earliest and the latest of those plus the most relevant ones, and
 * prints them in the order the evidence states them, with their dates.
 *
 * It does not fold the two statements into one, either: the block prints them and says which is the
 * later value, and the reader answers. That is the only direction that survived measurement — run
 * `42754985453` shows a sentence offering the *earlier* value as the answer costing three
 * conversions on questions that ask for the current one, and the one question it was written for
 * (`0977f2af`, "before the Air Fryer") is not reachable by this mechanism at all.
 *
 * ## Why the block is additive and the window is not touched
 *
 * `CortexMemory` inserts this block between the evidence and the question and changes nothing else.
 * The carried set, the rendering, the instruction block and the budget decision are byte-identical
 * to the control's, so a reading of a run with this on is attributable to the block. Rewriting or
 * reordering the evidence would move the delivered multiset as well, which is two variables in an
 * experiment whose entire value is that it has one.
 *
 * ## Why the endpoints are always kept
 *
 * The pair this exists to surface is exactly the earliest and the latest statement, and a cap that
 * kept "the six most relevant" would drop one end of it on the questions where every statement is
 * equally relevant — `ce6d2d27` has eight candidates tied at two terms, and relevance-ordered
 * selection keeps six of them, discarding the earlier statement of the very pair being repaired.
 * The endpoint rule costs two of the six slots and makes that unrepresentable.
 */

import type { AdmittedTurn } from './admission.js';

/**
 * One turn that states something about what the question asks.
 *
 * `sentence` is the turn's own words, truncated, rather than a paraphrase: the block's job is to
 * show the reader two statements it already has, and a rewritten statement would be a claim about
 * the evidence that the evidence does not make.
 */
export type ConflictStatement = {
  /** The turn's timestamp exactly as the evidence prints it, or absent when it carries none. */
  readonly date: string | undefined;
  /** The sentence of that turn that mentions the most of the question's terms. */
  readonly sentence: string;
  /** Zero-based position in the window, so a caller can tie the block back to the evidence. */
  readonly position: number;
};

/** How much of the window {@link conflictStatements} is allowed to print. */
export type ConflictOptions = {
  /**
   * Upper bound on statements in the block.
   *
   * Six rather than "all of them" because the block is charged to the same room the evidence is:
   * at six statements of at most {@link ConflictOptions.sentenceChars} it is ~1.2k characters on a
   * ~48k prompt, and an uncapped block on a broad question (`a2f3aa27` has 3 candidates, but
   * "how many followers" over a year of chat could have thirty) would spend the room the mechanism
   * is supposed to be helping the reader spend well.
   *
   * Two is the floor: below it there is no pair to compare and {@link renderConflicts} prints
   * nothing, so a value under two would silence the feature rather than narrow it, which is a
   * configuration mistake worth failing on rather than obeying.
   */
  readonly maxStatements?: number;
  /**
   * How many distinct question terms a sentence must share to be a candidate.
   *
   * Two, measured rather than chosen: one term matches on filler ("what", "have", "about" are
   * stopwords, but "class" alone matches a roasting class, a cooking class and a yoga class), and
   * three drops the statement this feature exists to find — `a2f3aa27`'s "I've been meaning to
   * check my current follower count — I think I'm close to 1300 now" shares two of `{follower,
   * instagram, 1300}` with its question, and the 3-term threshold keeps only the older 1250.
   */
  readonly minTerms?: number;
  /** Upper bound on the characters one statement contributes. Truncation is marked with `…`. */
  readonly sentenceChars?: number;
};

const DEFAULT_MAX_STATEMENTS = 6;
const DEFAULT_MIN_TERMS = 2;
const DEFAULT_SENTENCE_CHARS = 180;

/**
 * Words that carry no subject, and are therefore not evidence of one.
 *
 * Kept short deliberately. A long list is a second tokenizer that has to be maintained against the
 * question shapes in the dataset, and every word on it is a word the block cannot match on; the two
 * that matter here are the interrogatives (which appear in every question and therefore score every
 * sentence equally) and the auxiliaries (which do the same through grammar rather than topic).
 */
const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'all',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'both',
  'but',
  'can',
  'could',
  'did',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'into',
  'its',
  'itself',
  'just',
  'many',
  'more',
  'most',
  'much',
  'must',
  'myself',
  'neither',
  'nor',
  'not',
  'now',
  'off',
  'once',
  'only',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'too',
  'under',
  'until',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
]);

/** Length at which a token is long enough to be about something. */
const MIN_TERM_CHARS = 3;

/**
 * The words of a string, folded to the form two occurrences of one idea share.
 *
 * Plural folding is the only stemming done here, and it is done with three suffix rules rather than
 * a stemmer: the tokens that have to meet are nouns the question names (`coin`/`coins`,
 * `follower`/`followers`, `class`/`classes`), and a Porter stemmer would additionally fold `trip`
 * into `trip` and `trips` into `trip` — which these rules also do — while risking folds nobody
 * asked for on a population where a false match is a wrong pair in the block.
 */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9:'-]*/g) ?? []) {
    const token = raw.replace(/^['-]+|['-]+$/g, '').replace(/'s$/, '');
    if (token.length < MIN_TERM_CHARS) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(foldPlural(token));
  }
  return out;
}

function foldPlural(token: string): string {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  // The index is total: `length > 3` and `endsWith('es')` together guarantee position -3 exists,
  // so the alternative that would handle its absence is a branch no input can reach.
  if (token.length > 3 && token.endsWith('es') && 'sxz'.includes(token[token.length - 3]!)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * A turn's timestamp, from the prefix the evidence prints.
 *
 * The window's turns carry `[2023/06/30 (Fri) 22:49] user: …` as their content, which is what the
 * reader sees and therefore what the block must quote. Parsing it here rather than reading a field
 * is the same choice `formatEvidence` makes for the number: the block quotes the evidence, so it has
 * to read the evidence.
 */
function timestampOf(content: string): string | undefined {
  const match = /^\[([^\]]+)\]/.exec(content);
  return match?.[1];
}

/**
 * The sentences of a turn, with the addressing prefix removed.
 *
 * The prefix is stripped because `[2023/06/16 (Fri) 13:26] user:` shares no term with any question
 * yet lengthens every sentence, and because a block that reprinted it would print the date twice.
 * Split on sentence enders and on newlines: a turn in this corpus is a paragraph of prose, and its
 * newlines separate ideas rather than sentences.
 */
function sentencesOf(content: string): string[] {
  const body = content.replace(/^\[[^\]]*\]\s*[A-Za-z ]*:\s*/, '');
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12);
}

function overlap(sentence: string, terms: ReadonlySet<string>): number {
  let hits = 0;
  for (const term of new Set(contentTerms(sentence))) {
    if (terms.has(term)) hits += 1;
  }
  return hits;
}

function clip(sentence: string, limit: number): string {
  if (sentence.length <= limit) return sentence;
  return `${sentence.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The words that make a statement a *value* rather than a mention of a subject.
 *
 * ## Why this exists, and what it cost to learn
 *
 * The first version of this module printed any two statements about the question's subject. Run
 * `42754985453` measured what that is worth: it converted **three** of the four reachable questions
 * (`ce6d2d27` 0/4 → 3/4, `9ea5eabc` 0/4 → 4/4, `ed4ddc30` 0/4 → 4/4) and **broke five** that the
 * control answered correctly in every repetition (`6a1eabeb`, `89941a93`, `c7dc5443` 4/4 → 0/4,
 * `f9e8c073` 3/4 → 0/4, `852ce960` 2/4 → 0/4), for a net **-2** questions on byte-identical
 * evidence. A block that names no gold is a prompt perturbation, and on 31 of these 72 questions
 * the block did exactly that.
 *
 * So the population is now the statements that state a **value**, and the block fires only when two
 * of them state **different** values. That is the difference between "related statements" — what
 * the first version printed, and what the artifact priced — and a conflict, which is what the
 * mechanism was always supposed to be about.
 */
const WEEKDAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

const MONTHS = new Set([
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/**
 * Words that are capitalised for grammar rather than because they name something.
 *
 * A statement starts with a capital, so the sentence's own first word is excluded by position in
 * {@link valueSignature} instead of by this list; what remains here is the vocabulary that begins
 * clauses ("And", "But", "By", "If", "So", "The", "When") and the pronouns a capitalised sentence
 * opens with.
 */
const NOT_A_NAME = new Set([
  'a',
  'actually',
  'also',
  'and',
  'anyway',
  'as',
  'at',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'he',
  'her',
  'here',
  'his',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'just',
  'let',
  'maybe',
  'my',
  'no',
  'not',
  'now',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'some',
  'that',
  'the',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'we',
  'well',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'with',
  'would',
  'yes',
  'you',
  'your',
]);

/**
 * The values a sentence states: weekdays, months, clock times, numbers and capitalised names.
 *
 * Deliberately not a parser. It has to answer one question -- do these two statements disagree about
 * a value -- and every additional kind of token it recognises is another way for two statements about
 * the same subject to look like a conflict when they are not. A capitalised word is included because
 * the corpus states places and products that way ("trip to Hawaii", "Instant Pot"), and excluding
 * the sentence's first word is what keeps ordinary prose from looking like a proper noun.
 */
export function valueSignature(sentence: string): string[] {
  const out = new Set<string>();
  const words = sentence.match(/[A-Za-z0-9][A-Za-z0-9:'’.-]*/g) ?? [];
  words.forEach((raw, index) => {
    const token = raw.replace(/[.,;:]+$/, '');
    const lower = token.toLowerCase().replace(/'s$/, '');
    if (WEEKDAYS.has(lower) || MONTHS.has(lower)) {
      out.add(lower);
      return;
    }
    // A clock time or a number, either written out or as digits, is a value whatever else it is.
    if (/^\d+(?:[:.]\d+)?(?:am|pm)?$/i.test(token)) {
      out.add(lower);
      return;
    }
    if (index > 0 && /^[A-Z]/.test(token) && !NOT_A_NAME.has(lower) && lower.length >= 3) {
      out.add(lower);
    }
  });
  return [...out].sort();
}

/**
 * The statements in the window that are about what the question asks, in evidence order.
 *
 * Returns fewer than two when the window states nothing twice, which is the correct answer for a
 * question whose subject appears once — and for one whose subject the reader has to infer, such as
 * `0977f2af`, where the two gadgets and the question share no term at all. That case is a documented
 * reach limit rather than a defect: this mechanism matches words, and the value it is asked for is
 * named only by its relation to another thing.
 */
export function conflictStatements(
  question: string,
  turns: readonly AdmittedTurn[],
  options: ConflictOptions = {},
): ConflictStatement[] {
  const maxStatements = options.maxStatements ?? DEFAULT_MAX_STATEMENTS;
  const minTerms = options.minTerms ?? DEFAULT_MIN_TERMS;
  const sentenceChars = options.sentenceChars ?? DEFAULT_SENTENCE_CHARS;
  if (maxStatements < 2) {
    throw new RangeError(
      `maxStatements must be at least 2: below that there is no pair to compare, so the value ` +
        `would silence the mechanism rather than narrow it (got ${maxStatements})`,
    );
  }
  const terms = new Set(contentTerms(question));
  if (terms.size === 0) return [];

  const scored: { position: number; score: number; sentence: string; date: string | undefined }[] =
    [];
  turns.forEach((turn, position) => {
    let best: { score: number; sentence: string } | undefined;
    for (const sentence of sentencesOf(turn.content)) {
      const score = overlap(sentence, terms);
      if (score === 0) continue;
      if (best === undefined || score > best.score) best = { score, sentence };
    }
    if (best === undefined) return;
    scored.push({
      position,
      score: best.score,
      sentence: best.sentence,
      date: timestampOf(turn.content),
    });
  });

  if (scored.length < 2) return [];
  // The two rules that decide the population, and the second one is a correction found by running
  // this over the **real windows** rather than over the fixtures:
  //
  //   - `a2f3aa27` asks "how many followers do I have on Instagram now". The statement that answers
  //     it — "I think I am close to 1300 now" — shares **one** term with the question, while the
  //     statement it replaces shares two ("1250 followers on Instagram"). A population that kept
  //     only the best-scoring band therefore kept the replaced value and dropped the replacing one,
  //     which is the failure inverted.
  //   - On the real 62-turn window the band held a pair (the two 1250 statements), so an
  //     "open the band when it is empty" rule never fired. Measured: the block named `1250` twice
  //     and `1300` not at all.
  //
  // So the latest mention of the subject is always kept, whatever its score, because recency is the
  // thing this block exists to make visible and the latest mention is the one a reader would have to
  // reach by reading to the end of 23k characters. The conditional closing line is what makes a
  // weak last mention safe: it is not labelled current, only ordered.
  const qualifying = scored.filter((entry) => entry.score >= minTerms);
  const latest = scored[scored.length - 1]!;
  const candidates = qualifying.some((entry) => entry.position === latest.position)
    ? qualifying
    : [...qualifying, latest];
  if (candidates.length < 2) return [];

  // Only the statements that state a value, and only when two of them state different ones. This is
  // the gate run `42754985453` bought: without it the block printed any two statements about the
  // subject, converted three reachable questions and broke five correct ones.
  const valued = candidates
    .map((entry) => ({ ...entry, values: valueSignature(entry.sentence) }))
    .filter((entry) => entry.values.length > 0);
  if (valued.length < 2) return [];
  if (new Set(valued.map((entry) => entry.values.join('|'))).size < 2) return [];

  // The endpoints are kept first, then the rest by relevance. `valued` is in evidence order, so
  // `[0]` and `[length - 1]` are the earliest and latest statements that state a value.
  const kept = new Set<number>([valued[0]!.position, valued[valued.length - 1]!.position]);
  const byRelevance = [...valued].sort((a, b) =>
    b.score === a.score ? b.position - a.position : b.score - a.score,
  );
  for (const entry of byRelevance) {
    if (kept.size >= maxStatements) break;
    kept.add(entry.position);
  }

  return valued
    .filter((entry) => kept.has(entry.position))
    .map((entry) => ({
      date: entry.date,
      sentence: clip(entry.sentence, sentenceChars),
      position: entry.position,
    }));
}

/**
 * The block, or the empty string when there is nothing to compare.
 *
 * The closing line is conditional ("when two of these state different values …") rather than
 * asserting that the last entry is the answer, because the block is a sample of the statements and
 * not a resolution of them.
 *
 * It is also **directional**, and that is a correction with a measurement behind it. The first
 * version ended with a third sentence — "If the question asks about a previous state, the earlier
 * statement is the answer" — which existed to serve `0977f2af` ("what did I buy before the Air
 * Fryer"). Run `42754985453` priced it: the sentence primed the reader to take the earlier value and
 * it did, on `6a1eabeb` (5K personal best, 25:50 → 27:12), `89941a93` (bikes, 4 → "Three") and
 * `c7dc5443` (volleyball record, 5-2 → 3-2) — all three answered correctly by the control and all
 * three "current" questions the sentence had no business touching. `0977f2af` is not reachable by
 * this mechanism at all (it shares no term with either gadget), so the sentence bought nothing and
 * cost three conversions.
 */
export function renderConflicts(statements: readonly ConflictStatement[]): string {
  if (statements.length < 2) return '';
  const lines = statements.map((entry) =>
    entry.date === undefined ? `- ${entry.sentence}` : `- [${entry.date}] ${entry.sentence}`,
  );
  return [
    'RELATED STATEMENTS (the same ones appear in the evidence, in this order):',
    ...lines,
    'When two of these state different values for the same thing, the later statement is the value',
    'now and the earlier one is the value it replaced.',
  ].join('\n');
}

/**
 * The block for one question, computed once and inserted between the evidence and the question.
 *
 * A convenience over the two functions above so that `CortexMemory` cannot render a block it did not
 * compute, or compute one it does not render.
 */
export function conflictBlock(
  question: string,
  turns: readonly AdmittedTurn[],
  options: ConflictOptions = {},
): string {
  return renderConflicts(conflictStatements(question, turns, options));
}

/**
 * Put the block between the evidence and the question, or hand the prompt back untouched.
 *
 * ## Why the insertion is a function and not three lines in `CortexMemory`
 *
 * Because the marker is the one thing this can get wrong, and a function can be tested for both of
 * its answers while a private method of the memory can only be reached through a prompt that has a
 * marker — which is every prompt, so the "no marker" answer would be a branch nothing could reach
 * and the coverage ratchet on `memory.ts` would fail on it, correctly, for the wrong reason.
 *
 * `\n\nQUESTION: ` is the separator every builder uses between its sections
 * (`buildPrompt` assembles `[evidence, '', question, '', ask]` and joins with `\n`, and
 * `buildSessionPrompt` does the same), so the block lands as a section of its own rather than as a
 * third newline after the evidence. A prompt without that separator is returned unchanged rather
 * than given the block at the end: a block after the question would be evidence arriving after the
 * thing it is meant to inform, and a caller that produced such a prompt has a defect this function
 * must not disguise.
 */
export function insertRelatedStatements(prompt: string, block: string): string {
  if (block === '') return prompt;
  const marker = '\n\nQUESTION: ';
  const at = prompt.lastIndexOf(marker);
  if (at < 0) return prompt;
  return `${prompt.slice(0, at)}\n\n${block}${prompt.slice(at)}`;
}
