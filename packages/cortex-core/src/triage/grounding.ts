/**
 * What binds a proposed atom to the sentence it came from, once "verbatim" is no longer the answer.
 *
 * ## Why the old rule had to go
 *
 * Gate 1 used to be `source.includes(candidate)`: an atom had to be a verbatim, contiguous run of the
 * sentence. It was chosen for a good reason -- a card that offers a sentence the person never said,
 * and publishes it on one click, is the worst failure in this product -- and it bought prompt
 * injection for free, because text a model was *told* to emit is not a substring of what the user
 * wrote.
 *
 * It also made distillation impossible. A summary is by definition not a substring, so the prompt
 * could only ever ask for the sentence cut at its clause boundaries, and that is what came back. The
 * first person to use the review instrument said it plainly: the atoms "did not extract any fact, a
 * preference, or a summary -- they cut the sentence into pieces", and the original read better.
 *
 * So the binding changes from **form** to **content**: an atom may drop anything, reorder anything,
 * and use ordinary inflections of the words it keeps. It may not introduce a number, a name, a
 * content word or a negation that the sentence does not contain. That is a weaker guarantee than
 * substring identity, and it is stated as weaker here rather than implied to be the same.
 *
 * ## What each test buys, and what it cannot
 *
 * | test | catches | cannot catch |
 * | --- | --- | --- |
 * | numbers | an invented date, amount or count -- the highest-cost hallucination, and the cheapest to check | a number written as a word |
 * | names | an entity the sentence never mentioned | a mis-cased common noun |
 * | content words | invented vocabulary, and an injected instruction (its words are not in the source) | a claim assembled only from the source's own words |
 * | negation | a dropped or added "not", which inverts a fact while keeping every word | scope: "I do not think it will ship" against "I think it will not ship" |
 *
 * The last row is the honest limit. **Reordering is permitted, so a sentence whose negation scopes
 * over a different clause can pass.** The backstop is not this file: it is that the card shows the
 * person the atom before anything is published, and the rule table classifies the atom again.
 *
 * ## Why the word test matches on a four-character prefix
 *
 * "Editing" against "edits" is the same word; a strict equality test would reject every correctly
 * inflected summary. A four-character stem accepts inflection, derivation and the common compounds
 * ("photo" / "photography"), and it also accepts some pairs that are not related ("office" /
 * "offline"). The bias is deliberate and points the safe way for this product: a permissive word test
 * produces a *wrongly generous* atom that a person still has to accept, while a strict one produces
 * no atoms at all and the feature measures as absent. The tests pin both directions.
 */

/** Reasons an atom fails content grounding. Each names the thing that was introduced. */
export type GroundingProblem = 'empty' | 'new-number' | 'new-name' | 'new-word' | 'new-negation';

export type GroundingResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: GroundingProblem;
      readonly detail: string;
      /**
       * The offending token, for the two problems where a single word is the diagnosis.
       *
       * Absent for `new-number` on purpose: a fabricated number is the one case where the invented
       * value is indistinguishable from a real one on sight, so the *count* is recorded and the
       * value is not. Absent for `new-negation`, where the whole atom is the evidence.
       */
      readonly token?: string;
    };

/**
 * Function words carry no claim, so their presence cannot be an invention.
 *
 * Kept deliberately small: every entry is a word that adds nothing if the model inserts it. Pronouns
 * are *not* here -- "it" and "they" are exactly what a summary has to remove, and while the gate
 * cannot demand their removal, it should not be the list that waves them through as content either.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'may',
  'might',
  'must',
  'shall',
  'should',
  'that',
  'this',
  'these',
  'those',
  'there',
  'then',
  'than',
  'so',
  'such',
  'also',
  'just',
  'very',
  'more',
  'most',
  'some',
  'any',
  'all',
  'both',
  'each',
  'about',
  'into',
  'onto',
  'over',
  'under',
  'after',
  'before',
  'during',
  'while',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'which',
  'what',
  'how',
  'why',
  'it',
  'its',
  'they',
  'them',
  'their',
  'theirs',
  'we',
  'us',
  'our',
  'ours',
  'you',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'i',
  'me',
  'my',
  'mine',
  // Determiners and connectives: they change the grammar of a sentence, not what it claims. Adding
  // one cannot turn "I moved in March" into a different fact, which is the bar for this list.
  'every',
  'each',
  'few',
  'many',
  'much',
  'other',
  'another',
  'same',
  'own',
  'only',
  'ever',
  'still',
  'yet',
  'again',
  'once',
  'because',
  'since',
  'until',
  'though',
  'although',
  'unless',
  'whether',
  'too',
  'quite',
  'rather',
  'almost',
  'around',
  'nearly',
  'between',
  'among',
  'without',
  'within',
  'across',
  'along',
  'behind',
  'beside',
  'near',
]);

/**
 * Words that invert a claim.
 *
 * Counted rather than compared, and only in the direction that matters: an atom may drop a negation
 * (a summary of "I never eat meat and I cycle to work" may keep only the cycling), but it may not
 * add one.
 */
const NEGATIONS = /\b(?:not|no|never|none|nobody|nothing|nowhere|neither|nor)\b|n't\b/gi;

/**
 * Endings that inflect a word without changing what it names.
 *
 * `ing` before `ed` and `es` before `s`, longest first: "taking" must not lose only the "ing" and keep
 * a trailing "k" as if it were part of the root.
 */
const INFLECTIONS = /(?:ingly|ing|edly|ies|es|ed|ly|s)$/;

/** The root a word shares with its inflections, or the word itself when stripping would gut it. */
function root(word: string): string {
  const stripped = word.replace(INFLECTIONS, '');
  return stripped.length >= 3 ? stripped : word;
}

/**
 * Is `word` the same word as one the sentence contains?
 *
 * The first version compared four-character prefixes for equality, and the first diagnostic run found
 * the hole in one line: the model wrote "I take a comedy writing workshop" for a sentence that says
 * "I've been taking a comedy writing workshop", and `take` / `taki` are not equal. A legitimate
 * inflection was refused as an invention. **The gate had been raising the cost of the only rewrite
 * the prompt could not express any other way.**
 *
 * So the comparison is now: strip the inflection from both sides, then require the shorter root to be
 * a prefix of the longer. "tak" is a prefix of "take"; "kid" is not a prefix of "children". The
 * looseness this buys ("hous" against "household") is the same looseness the four-character rule
 * already had, and it is pinned by a test.
 */
function attestedWord(word: string, sourceWords: readonly string[]): boolean {
  const own = root(word);
  return sourceWords.some((candidate) => {
    const other = root(candidate);
    const shorter = own.length <= other.length ? own : other;
    const longer = shorter === own ? other : own;
    return shorter.length >= 3 && longer.startsWith(shorter);
  });
}

/** Digit runs, with thousands separators removed so "1,200" and "1200" compare equal. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((run) => run.replace(/[,]/g, ''));
}

/** Letters only: what a word test should compare, without punctuation or possessives attached. */
function wordsIn(text: string): string[] {
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).map((word) =>
    word.replace(/['’]s$/, '').replace(/['’-]+$/, ''),
  );
}

function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * Is `candidate` a faithful compression of `source`?
 *
 * Faithful means: every number, every name, every content word and every negation in the candidate is
 * attested in the source. Order, sentence shape, length and inflection are free.
 */
export function contentGrounded(candidate: string, source: string): GroundingResult {
  const atom = candidate.trim();
  if (atom === '') return { ok: false, problem: 'empty', detail: 'the atom is blank' };

  const sourceWords = wordsIn(source);
  const sourceLower = sourceWords.map(lower);
  const sourceNumbers = new Set(numbersIn(source));

  const inventedNumber = numbersIn(atom).find((number) => !sourceNumbers.has(number));
  if (inventedNumber !== undefined) {
    return {
      ok: false,
      problem: 'new-number',
      detail: `the atom says ${JSON.stringify(inventedNumber)}, which is not in the sentence`,
    };
  }

  const sourceNegations = (source.match(NEGATIONS) ?? []).length;
  const atomNegations = (atom.match(NEGATIONS) ?? []).length;
  if (atomNegations > sourceNegations) {
    return {
      ok: false,
      problem: 'new-negation',
      detail: `the atom negates ${atomNegations} time(s) and the sentence ${sourceNegations}`,
    };
  }

  const atomWords = wordsIn(atom);
  for (const [index, word] of atomWords.entries()) {
    const bare = word.replace(/['’-]+$/, '');
    const folded = lower(bare);

    // A capitalised token is a name unless it opens the atom: a summary may start a sentence with any
    // word, and the first word of a sentence is capitalised for reasons that have nothing to do with
    // being a name.
    const isName = index > 0 && /^[A-Z][A-Za-z'’-]+$/.test(bare);
    if (isName) {
      if (!sourceLower.some((candidateWord) => candidateWord === folded)) {
        return {
          ok: false,
          problem: 'new-name',
          detail: `the atom names ${JSON.stringify(bare)}, which the sentence does not mention`,
        };
      }
      continue;
    }

    if (folded.length < 4 || FUNCTION_WORDS.has(folded)) continue;
    if (!attestedWord(folded, sourceLower)) {
      return {
        ok: false,
        problem: 'new-word',
        detail: `the atom uses ${JSON.stringify(bare)}, which the sentence does not`,
        token: bare,
      };
    }
  }

  return { ok: true };
}

/**
 * Whether the atom is literally a piece of the sentence.
 *
 * Not a gate -- a measurement. It is the number that says whether the proposer is distilling or
 * cutting, and it is what the first review of A3 asked for without being able to name it: on
 * `triage-proposer/v2` this rate was effectively 1.0, because the gate made it so.
 */
export function isVerbatimRun(candidate: string, source: string): boolean {
  const needle = foldForRun(candidate);
  return needle !== '' && foldForRun(source).includes(needle);
}

/**
 * Contractions, folded to their expansion.
 *
 * The first version of this function folded only case, whitespace, dash and quote form and trailing
 * punctuation, and it reported the v4 run as **20.6%** verbatim. That number was flattering and the
 * flattery had a name: an atom that changed nothing but `I'll` to `I will` counted as a rewrite. Two
 * of the twenty cards were exactly that. Writers expand contractions; it is a typographic choice, not
 * a distillation, and a measurement that credits it is measuring the wrong thing.
 *
 * Folding contractions here moves the same run to **44.1%**, which is the number that gets quoted.
 */
const CONTRACTIONS: ReadonlyMap<string, string> = new Map([
  ["i'll", 'i will'],
  ["i'm", 'i am'],
  ["i've", 'i have'],
  ["i'd", 'i would'],
  ["it's", 'it is'],
  ["that's", 'that is'],
  ["they're", 'they are'],
  ["we're", 'we are'],
  ["you're", 'you are'],
  ["don't", 'do not'],
  ["doesn't", 'does not'],
  ["didn't", 'did not'],
  ["isn't", 'is not'],
  ["aren't", 'are not'],
  ["can't", 'cannot'],
  ["won't", 'will not'],
]);

function foldForRun(value: string): string {
  let folded = lower(value).replace(/[‘’']/g, "'").replace(/[–—−]/g, '-');
  for (const [contraction, expansion] of CONTRACTIONS) {
    folded = folded.split(contraction).join(expansion);
  }
  return folded
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

/**
 * A time expression, matched loosely and only for measurement.
 *
 * The proposer is asked to keep the time a statement belongs to. There is no gate for that, because a
 * gate would need a date parser and would then be wrong about "the summer I turned nine". What there
 * is, is this: whether the sentence contained a time and whether any atom kept one. The rate is a
 * reading, and a bad rate is a prompt problem rather than a rejection.
 */
const TEMPORAL =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|today|tomorrow|tonight|morning|afternoon|evening|week|weekend|month|year|spring|summer|autumn|fall|winter|recently|lately|ago|since|last|next|earlier|later|currently|now|\d{4})\b/i;

export function looksTemporal(text: string): boolean {
  return TEMPORAL.test(text);
}

/** What one card's atoms say about whether the proposer is distilling or cutting. */
export type DistillationOf = {
  readonly atoms: number;
  /** Atoms that are literally a piece of the sentence, punctuation aside. */
  readonly verbatim: number;
  /** `null` when the sentence named no time, so there was nothing to keep. */
  readonly timeKept: boolean | null;
};

/**
 * The two readings that say whether an atom set is a summary or a set of slices.
 *
 * `verbatim` is the one that matters. On `triage-proposer/v2` it was forced to equal `atoms` by the
 * gate itself, which is why the first review of A3 could say the atoms were "the sentence cut into
 * segments" and be exactly right. It is a measurement rather than a gate because a legitimate atom
 * *may* be one clause of a long sentence -- what must not happen is that every atom is.
 */
export function distillationOf(source: string, atoms: readonly string[]): DistillationOf {
  return {
    atoms: atoms.length,
    verbatim: atoms.filter((atom) => isVerbatimRun(atom, source)).length,
    timeKept: looksTemporal(source) ? atoms.some((atom) => looksTemporal(atom)) : null,
  };
}
