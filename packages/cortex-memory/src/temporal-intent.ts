/**
 * Which end of a supersession a question asks for, read from the question alone.
 *
 * The adjudicator's seven refusals all answer "is this substitution supported" and none answers "is it
 * wanted", which are different questions whenever the question names a value from before a change:
 * `50635ada` asks for the **previous** status, and the pass replaced a correct `Premier Silver` with the
 * `Premier Gold` the corpus moved to later -- seven times, on an authorisation every evidence check
 * passed. `docs/FIX-TEMPORAL-DIRECTION.md` is the reading behind every word and boundary rule below.
 *
 * The partition over the 72 `KU` questions is 60 `latest` / 10 `earlier` / 2 `both`, and the two
 * questions that ask for both ends are their own direction rather than a refusal: their golds span both
 * answers, so a replacement answers one half and drops the other.
 */

/** Which end of a value's history a question asks for. */
export type TemporalDirection = 'earlier' | 'latest' | 'both';

/**
 * The closed vocabularies, written as space-separated words rather than literal arrays.
 *
 * `entry-guard.mjs` budgets this package's closure in **source** bytes, and a literal array spends a
 * quote and a comma on every word. The split costs one call at module load and one `Set` of the same
 * size at runtime.
 */
const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

/** Words that name the value before a change, and words that name the one in force now. */
const EARLIER_WORDS = words(
  'previous previously earlier earliest before prior initially initial originally original',
);
const LATEST_WORDS = words('current currently now today latest recent recently still');

/** The multi-token forms: `most recent`, `so far`, `to date`, and the ended-habit pair. */
const LATEST_PAIRS: readonly (readonly [string, string])[] = [
  ['most', 'recent'],
  ['most', 'recently'],
  ['so', 'far'],
  ['to', 'date'],
  ['right', 'now'],
];
const EARLIER_PAIRS: readonly (readonly [string, string])[] = [
  ['used', 'to'],
  ['use', 'to'],
  ['just', 'started'],
];

/** What may sit between `first` and the span it bounds, and the units that make it a span. */
const COUNT_WORDS = words(
  'one two three four five six seven eight nine ten eleven twelve few several couple',
);
const TIME_UNITS = words(
  'day days week weeks month months year years hour hours minute minutes decade decades',
);

/** The words of a question, lowercased, with digits kept inside a word so `before20` is one token. */
function tokensOf(question: string): readonly string[] {
  return question.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * The clause with a comma-bracketed aside removed, when it has exactly one.
 *
 * `5a4f22c0` asks where Rachel works **now**, and its `previous` sits in the appositive that says who
 * she is. Exactly one pair is stripped, and only at exactly two commas: a three-comma clause is
 * `a, b, c, d`, whose asides alternate only in some styles of writing.
 */
function withoutAside(clause: string): string {
  const parts = clause.split(',');
  // Dropped by position rather than by index, so no branch here guards an `undefined` that `split`
  // cannot produce -- the coverage gate reported the first version's `parts[0] ?? ''` as unreachable.
  return parts.length === 3 ? parts.filter((_, index) => index !== 1).join(' ') : clause;
}

/** Whether `first` at `index` bounds a span of time rather than numbering a name. */
function firstBoundsASpan(tokens: readonly string[], index: number): boolean {
  const next = tokens[index + 1];
  if (next === undefined) return false;
  if (TIME_UNITS.has(next)) return true;
  if (!COUNT_WORDS.has(next) && !/^\d+$/.test(next)) return false;
  const after = tokens[index + 2];
  return after !== undefined && TIME_UNITS.has(after);
}

/**
 * The direction one clause names, or `null` when it names none.
 *
 * `earlier` wins inside a clause, because a clause names at most one direction and the earlier word is
 * the more specific claim: `50635ada` says "previous ... before I got the current status", where
 * `current` selects which status the previous one came before rather than asking for it.
 */
function directionOfClause(tokens: readonly string[]): TemporalDirection | null {
  let earlier = false;
  let latest = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (EARLIER_WORDS.has(token)) earlier = true;
    else if (token === 'first' && firstBoundsASpan(tokens, index)) earlier = true;
    else if (LATEST_WORDS.has(token)) latest = true;
  }
  const pairIn = (pairs: readonly (readonly [string, string])[]): boolean =>
    pairs.some(([a, b]) =>
      tokens.some((_, index) => tokens[index] === a && tokens[index + 1] === b),
    );
  if (pairIn(EARLIER_PAIRS)) earlier = true;
  if (pairIn(LATEST_PAIRS)) latest = true;
  return earlier ? 'earlier' : latest ? 'latest' : null;
}

/**
 * Which end of a value's history the question asks for.
 *
 * Split on `?` first, because a string may hold two questions with two directions. A clause with no
 * direction word contributes nothing rather than contributing `latest`: "previous? and now?" is two
 * directions, while "previous? at the shop?" is one.
 */
export function classifyTemporalIntent(question: string): TemporalDirection {
  let earlier = false;
  let latest = false;
  for (const clause of question.split('?')) {
    const direction = directionOfClause(tokensOf(withoutAside(clause)));
    if (direction === 'earlier') earlier = true;
    else if (direction === 'latest') latest = true;
  }
  return earlier && latest ? 'both' : earlier ? 'earlier' : 'latest';
}
