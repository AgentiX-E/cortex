/**
 * The words a plan may select on, taken from the question and from nowhere else.
 *
 * ## Why a stoplist rather than a model
 *
 * Because the candidate set is the thing being *measured*, and a model that produced keywords would
 * make the measurement circular: the ceiling would be "what a model happened to think of" rather than
 * "what the question itself names". A closed, inspectable rule is also what makes the ceiling
 * reproducible from the question text alone, which is the property the offline harness needs.
 *
 * ## Why the stem is crude
 *
 * `baking` has to reach `baked`, and a real stemmer would reach further -- `properties` to `property`,
 * `purchased` to `purchase` -- at the cost of collisions the corpus is full of (`reading` to `read`
 * is fine; `running` to `run` also matches `runs` in a different sense). The suffix strip here is the
 * smallest rule that closes the gap the autopsy actually showed: the ledger's own texts say `baked`
 * and `sold` where the questions say `baking` and `sell`. It is deliberately not a stemmer, and the
 * ceiling it produces is therefore a lower bound on what a wider vocabulary could reach -- a bound
 * that errs toward not dispatching, which is the direction an error should point before a run.
 *
 * ## Why the list is capped
 *
 * A question's content words are also a budget: every keyword becomes a row in the resolution table
 * the plan prompt carries, and the table's job is to be smaller than the evidence it replaces. Eight
 * is more than the longest question in the corpus supplies after the stoplist, so the cap is a guard
 * against a pathological question rather than a filter that removes information.
 */

/**
 * Words that name no subset of a history.
 *
 * The list mixes three kinds: grammatical words, the question frames this corpus asks in (`how many`,
 * `how much`, `total`), and time words (`week`, `month`, `year`) which the *scope* already bounds --
 * a keyword filter for `week` would select the turns that happen to spell it, not the turns inside a
 * week.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'how',
  'many',
  'much',
  'did',
  'does',
  'was',
  'were',
  'have',
  'has',
  'had',
  'what',
  'which',
  'when',
  'where',
  'who',
  'whom',
  'that',
  'this',
  'these',
  'those',
  'with',
  'from',
  'been',
  'being',
  'there',
  'their',
  'about',
  'into',
  'over',
  'total',
  'altogether',
  'combined',
  'most',
  'least',
  'number',
  'times',
  'last',
  'past',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
  'day',
  'days',
  'you',
  'your',
  'can',
  'could',
  'would',
  'should',
  'tell',
  'give',
  'list',
  'name',
  'currently',
  'since',
  'after',
  'before',
  'during',
  'while',
  'also',
  'just',
  'them',
  'they',
]);

/** How many keywords a plan prompt may carry. */
const MAX_KEYWORDS = 8;

/**
 * The content words of a question, lowercased, stemmed crudely, deduplicated and sorted.
 *
 * Sorted rather than in question order: the table a caller renders is then a function of the
 * question's *set* of words, so two questions that differ only in word order produce the same table
 * and the same plan -- which is the determinism the prompt tests check.
 */
export function questionKeywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
  const stems = words
    .map((word) => word.replace(/(?:ing|ed|es|s)$/, ''))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  // The words before the stems, so the cap drops a stem rather than the word it came from: `something`
  // survives and `someth` does not, and a table row that selects nothing is worth less than the word
  // that produced it.
  return [...new Set([...words.sort(), ...stems.sort()])].slice(0, MAX_KEYWORDS);
}
