/**
 * What a card may be a question *about*: a claim, not a request.
 *
 * ## The measurement that forced this file
 *
 * Step 17 left the boundary in this state: a row the rules defer is stored privately and the card
 * queue is the only way it can ever reach the shared store. `release()` refuses deferrals and says
 * why -- "a deferral is a question, and the card queue is how it is answered."
 *
 * Step 18 ran the rule layer over the 46,951 unique user sentences a real LongMemEval-S run actually
 * admitted. **40,961 of them are deferrals** (87.2%), so the queue's premise -- that a deferral is a
 * rare "we cannot tell" -- is false at this workload: deferral is the normal case, not the exception.
 * And 73.6% of those sentences contain a question mark. So the queue was, on real speech, mostly
 * asking the owner whether a colleague should be allowed to read things like:
 *
 *     Can you write the texts for the PowerPoint presentation ?
 *     please continue, provide 10 additional examples
 *     Thank you
 *
 * That is not a volume complaint, it is a **correctness** one: `accept` publishes the card's text, so
 * a card about a request publishes a request into the organisation's knowledge. The sentence a
 * colleague reads would be a task someone gave their assistant.
 *
 * ## What this module decides, and what it deliberately is not
 *
 * It splits a turn into sentences and keeps the ones that **assert something**. A sentence asserts
 * when it is not a question, does not open with a request marker, and is long enough to carry
 * anything at all. Those three tests are syntactic; this is not a classifier, has no model, and
 * cannot be tuned to be cleverer later without changing what the product promises.
 *
 * The consequence for the product is stated where it belongs (`docs/02`): the card's `text` becomes
 * the claims inside the turn, and `sourceText` keeps the turn, so the export can still answer "did
 * they say that?".
 *
 * ## The two properties that make it safe, and how each one is measured
 *
 * 1. **It does not lose claims that were already being asked about.** All 40 `defer` rows of the
 *    hand-labelled fixture still produce a card (40/40). Those rows are the only set on which
 *    "should this have been a question?" was decided by a person before any rule existed.
 * 2. **Its blind spot is bounded and named.** A claim fused into a question by a comma conjunction
 *    -- "I like the idea of categorizing my coupons by type, but how do I decide which categories to
 *    prioritize?" -- is one sentence and goes with the question. On the real corpus that is **99 of
 *    40,961 deferrals (0.24%)**, and the reading in `test/card-volume/result.json` carries the
 *    number so a later change cannot quietly enlarge it.
 *
 * ## Why abbreviations are protected in the permissive direction
 *
 * Splitting after `Dr.` would cut "Hi Dr. Grove, ..." into a two-word fragment, and a fragment can
 * fall below the word floor and take a real claim with it. Not splitting after a corporate suffix
 * (`Inc.`) merges two sentences into one longer one, which can only *add* text to a card. The list is
 * therefore built to merge rather than to cut, and the bias is deliberate: the failure it prevents is
 * silent loss, the failure it accepts is clumsy wording.
 */

/**
 * Tokens whose trailing period does not end a sentence.
 *
 * Titles and months are here because they are followed by a name or a number; `inc`/`ltd`/`co` are
 * here because a false split after them produces a fragment, and a fragment is how a claim gets lost.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'eg',
  'ie',
  'approx',
  'fig',
  'inc',
  'ltd',
  'co',
  'dept',
  'est',
  'al',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

/**
 * Openers that make a sentence a request rather than a claim.
 *
 * Anchored, and required to be followed by whitespace or the end of the sentence, so that a word
 * which merely *starts* with one of these (`Write-ups are due Friday`) is not mistaken for the
 * imperative. `what`/`how`/`why` are included because a question phrased without a question mark is
 * still a question; that is the shape most of the missed ones took in the corpus.
 */
const REQUEST_OPENERS =
  /^(?:please|can you|could you|would you|will you|do you|did you|are you|tell me|give me|show me|help me|let'?s|keep going|go on|do it|write|make|create|generate|list|explain|summari[sz]e|provide|suggest|recommend|draft|translate|continue|add|remove|update|change|find|fix|calculate|compute|compare|rewrite|shorten|expand|format|convert|what|how|why|when|where|who|which|whose)(?:\s|$)/i;

/**
 * The shortest run of words that can carry a claim. Below this a sentence is a fragment.
 *
 * This is also what handles acknowledgements, and the fact that it does was measured rather than
 * assumed. The first version of this module carried a list of pleasantries ("thanks", "sounds good",
 * "got it") matched against the whole sentence; on the 46,951-turn corpus that list matched **zero**
 * sentences of three words or more, because every acknowledgement in the list is one or two words and
 * had already been refused by the floor. The list was a dead branch, so it is gone: the floor is the
 * rule, and there is one rule instead of two that disagree about nothing.
 */
const MIN_CLAIM_WORDS = 3;

/** Words in a sentence, counting anything with a letter or a digit as a word. */
function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
}

/**
 * The sentence a turn is made of, punctuation attached, whitespace normalised.
 *
 * Splits after `.`, `!` or `?` runs that are followed by whitespace or the end of the text, and
 * skips the split when the token before the period is an abbreviation or a single capital letter
 * (an initial: `J. Smith`). A period inside a number (`3.5`) is not followed by whitespace, so it
 * never splits.
 *
 * A run without terminal punctuation is one sentence, because a caller that passed a fragment meant
 * it as one: this function is used to *join* a card's text too, and inventing boundaries there would
 * change what the owner agreed to.
 */
export function splitSentences(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return [];

  const sentences: string[] = [];
  let start = 0;
  const boundary = /[.!?]+(?=\s|$)/g;
  let match = boundary.exec(flat);
  while (match !== null) {
    const end = match.index + match[0].length;
    const before = flat.slice(start, match.index);
    const tail = /([A-Za-z.]+)$/.exec(before)?.[1] ?? '';
    const word = tail.replace(/\.$/, '');
    const isInitial = /^[A-Z]$/.test(word);
    if (!isInitial && !ABBREVIATIONS.has(word.toLowerCase())) {
      sentences.push(flat.slice(start, end).trim());
      start = end;
    }
    match = boundary.exec(flat);
  }
  if (start < flat.length) sentences.push(flat.slice(start).trim());
  return sentences.filter((sentence) => sentence.length > 0);
}

/**
 * Whether one sentence asserts something a colleague could act on.
 *
 * Three refusals, in the order a reader would apply them: it asks rather than says; it instructs
 * rather than says; or it is too short to carry anything at all.
 */
export function isClaim(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (wordCount(trimmed) < MIN_CLAIM_WORDS) return false;
  if (trimmed.endsWith('?')) return false;
  return !REQUEST_OPENERS.test(trimmed);
}

/**
 * The claims inside one turn, in the order they were said.
 *
 * Empty means the turn contains nothing to ask about -- every sentence in it is a question, a
 * request or an acknowledgement -- and the card queue opens no question for it. That is not a lost
 * door: there is no claim behind it to share.
 */
export function claimsIn(text: string): string[] {
  return splitSentences(text).filter(isClaim);
}
