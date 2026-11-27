/**
 * The second look: one query written after a first pass has been ranked.
 *
 * ## The defect this is written against
 *
 * Run `44962474136`'s wrong `MR` questions delivered **every** gold turn and still listed two of three
 * and two of four items. Both blocks were under the room. That is neither a retrieval result nor a room
 * result, and it is the population `enumerated` was designed for -- which made `MR` worse by 6.2
 * questions. The mechanism registered for it is a **second look aimed by what the first one showed**: a
 * reader that lists two of three and then searches for the third has a chance, and a reader handed the
 * same turns twice does not.
 *
 * ## Why the query is written from a digest rather than from the question
 *
 * `queryExpansion=llm` already writes phrases, and it writes them **blind**: one call per question,
 * before any index exists, from the question alone. On the paired `MR` roster that is `S17`, **+1.75
 * points against a bar of +5** -- inside this campaign's own 2.5-question noise floor. The one thing
 * that separates this mechanism from that reading is what the model has in front of it when it writes:
 * a line from each of the turns the first pass already ranked. A model that can see "blazer at the dry
 * cleaner" is a model that can ask for the boots.
 *
 * ## Why one query and not a plan
 *
 * The room is the scarce resource and this stage spends none of it. One query buys one extra ranking
 * pass, and the union is ordered by the same signal the prompt uses, so the second look costs ordering
 * rather than characters. A plan of three queries would triple the retrieval bill to buy votes this
 * stage cannot use: `RelevanceCase.queries` already fuses four phrases on the blind path and that path
 * moved 1.75 points.
 *
 * ## Why the refusal verdicts are typed
 *
 * Every one of them is a *paid* outcome: the model was consulted and produced something this stage will
 * not search with. A single `null` would report "the mechanism fired on 118 of 121" for a run where it
 * fired on 80 and declined on 38, and the two are different findings about the same bill. `NONE` is the
 * verdict the prompt actually offers -- a reader that judges its list complete should say so rather
 * than invent a query -- so it is a first-class state and not an error.
 */

/**
 * How the second look is configured.
 *
 * Every field is a bound on a bill or on a prompt, and the defaults are the registered configuration.
 * `k` is the width of the second ranking rather than of the union: the union's ordering is the prompt's
 * own signal, so a wider `k` adds candidates rather than positions.
 */
export type ReaderSearchOptions = {
  /** How many turns of the second ranking may carry a score into the union. */
  readonly k: number;
  /** How many first-pass turns the model is shown. */
  readonly digestTurns: number;
  /** How many characters of each first-pass turn the model is shown. */
  readonly digestChars: number;
  /** The longest query this stage will search with. */
  readonly maxQueryChars: number;
  /** The answer budget of the one decision call. */
  readonly maxTokens: number;
};

/**
 * The registered configuration.
 *
 * `digestTurns: 16` at `digestChars: 120` is a decision prompt of roughly 2,000 characters -- about 600
 * tokens in, 32 out, one call per multi-session question. Sixteen rather than the thirty-two the probe
 * digests because the turns that matter for "what is missing" are the ones the first pass ranked first:
 * a fourth page of the list is the part the reader has already decided not to use.
 *
 * `k: 16` is the narrowest width that can hold a second opinion over a corpus whose sessions run to
 * roughly 190 turns; wider widths were not measured and are not claimed.
 */
export const DEFAULT_READER_SEARCH: ReaderSearchOptions = {
  k: 16,
  digestTurns: 16,
  digestChars: 120,
  maxQueryChars: 120,
  maxTokens: 32,
};

/**
 * Validate a partially stated configuration.
 *
 * Rejected rather than clamped, for the reason every reader in this codebase rejects: a `k` of zero
 * ranks nothing and reports a mechanism that found no evidence, and a NaN bound compares false against
 * every total and therefore never stops. A wrongly configured stage has to fail where it was configured.
 */
export function readerSearchOptions(
  partial: Partial<ReaderSearchOptions> = {},
): ReaderSearchOptions {
  const resolved: ReaderSearchOptions = { ...DEFAULT_READER_SEARCH, ...partial };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `readerSearch.${name} must be a positive integer, got ${String(value)}. Every field of this ` +
          'stage is a bound on a prompt or on a bill, and a bound that cannot be read is one the run ' +
          'cannot honour.',
      );
    }
  }
  return resolved;
}

/** One first-pass turn, as the digest sees it. */
export type DigestRow = { readonly text: string; readonly score: number };

/**
 * The lines the model reads: the highest-ranked first-pass turns, cut to a fixed width.
 *
 * Truncation is by code unit rather than by word, because the cut is a bill and a word boundary would
 * make the same setting cost different amounts on different corpora. The marker is appended inside the
 * budget rather than after it, so `digestChars` is the width of the line rather than of the text plus
 * three.
 *
 * Ties keep arrival order (`sort` is stable and the comparator is the score alone), which is the same
 * tie-break `rankedCandidates` uses -- a digest that reordered equal-scored turns would show the model a
 * different first pass from the one the prompt was built with.
 */
export function digestOf(
  rows: readonly DigestRow[],
  options: ReaderSearchOptions,
): readonly string[] {
  return [...rows]
    .sort((a, b) => b.score - a.score)
    .slice(0, options.digestTurns)
    .map((row) => {
      const text = row.text.trim().replace(/\s+/g, ' ');
      if (text.length <= options.digestChars) return text;
      // One character of the budget is spent on the mark, so every line is at most `digestChars`.
      return `${text.slice(0, options.digestChars - 1)}\u2026`;
    });
}

/**
 * The decision prompt.
 *
 * Three properties are load-bearing and each was a choice against an alternative:
 *
 * - **The list is the question's own first pass**, not a sample of the corpus. The stage exists to ask
 *   what the ranking missed, and a corpus sample would make the model's query a function of arrival
 *   order.
 * - **`NONE` is offered explicitly.** Without an out, a model asked for a query writes one, and a paid
 *   search for a query the model did not believe in is the one outcome this stage cannot distinguish
 *   from a mechanism that helps.
 * - **The activity rule is stated.** `query-expansion.ts` records why: these questions count past
 *   activities, their evidence is written as the activity ("led a consumer-research project"), and a
 *   synonym of the category retrieves every session that mentions the category.
 */
export function buildSecondLookPrompt(
  question: string,
  digest: readonly string[],
  options: ReaderSearchOptions,
): string {
  const listed =
    digest.length === 0
      ? '- (the first pass selected nothing)'
      : digest.map((line) => `- ${line}`).join('\n');
  return [
    'You are helping a memory system look twice. A first pass ranked the turns below for the question.',
    'Write ONE search query that would find evidence the list is missing.',
    '',
    'Rules:',
    '- One line, no explanation, no numbering, no quotation marks.',
    `- At most ${String(options.maxQueryChars)} characters.`,
    '- Name an activity with its object ("ran a half marathon"), never a bare category ("exercise").',
    '- If the list already covers the question, answer exactly NONE.',
    '',
    `Question: ${question}`,
    '',
    'Turns the first pass selected:',
    listed,
    '',
    'Query:',
  ].join('\n');
}

/** What one decision call produced, as a state rather than as a string. */
export type SecondLookVerdict =
  | { readonly kind: 'query'; readonly query: string }
  | { readonly kind: 'refused'; readonly reason: 'empty' | 'echo' | 'instruction' | 'too-long' };

/**
 * Whole lines that are a refusal and nothing else.
 *
 * Matched exactly rather than by prefix, because `none of the boots at Zara arrived` is a query about a
 * memory and `NONE` is the out the prompt offers. A prefix test would refuse the first one, and the model
 * would then have spent a call writing a query this stage discarded.
 */
const REFUSAL_LINES: readonly string[] = ['none', 'n/a', 'no query'];

/**
 * Lower-cased openings that mark a reply as an instruction rather than a query.
 *
 * Matched on the **start** of the line as a phrase rather than anywhere in it: "the file I cannot find" is
 * a legitimate query about a memory, and a substring test would refuse it. `none` is the one refusal the
 * mechanism *wants* -- a reader that judges its list complete should cost one decision call and no search.
 */
const REFUSAL_OPENINGS: readonly string[] = [
  'i cannot',
  "i can't",
  'i am unable',
  "i'm unable",
  'sorry',
  'unable to',
  'there is no',
  'no additional',
];

/** Labels a model puts in front of the thing it was asked for. */
const LABELS: readonly string[] = ['query:', 'search:', 'search query:', 'the query is'];

/**
 * Read the model's reply as a query, or say precisely why it is not one.
 *
 * The order of the checks is the order of specificity: an empty reply is refused before it can be read
 * as an echo, an echo is refused before its length can be measured, and a too-long reply is refused
 * rather than truncated. Truncation was the first implementation and it is wrong for the reason
 * `query-expansion.ts` gives for `MAX_PHRASE_CHARS`: a model that explains itself produces a clause
 * whose embedding is dominated by the explanation, and the first 120 characters of that clause are
 * still that clause. The search would then be run, billed, and attributed to a query nobody wrote.
 */
export function parseSecondLookQuery(
  raw: string,
  question: string,
  options: ReaderSearchOptions,
): SecondLookVerdict {
  const line =
    raw
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '') ?? '';
  let text = line.replace(/^[-*>\d.)\s]+/, '').trim();
  const label = LABELS.find((candidate) => text.toLowerCase().startsWith(candidate));
  if (label !== undefined) text = text.slice(label.length).trim();
  text = text.replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019]+$/g, '').trim();

  if (text === '') return { kind: 'refused', reason: 'empty' };
  const lower = text.toLowerCase();
  // Terminal punctuation and a trailing clause are not part of the verdict: `none.` and `NONE` are the same
  // answer, and so are `no query` and `no query - the list is complete`.
  const head = lower
    .replace(/[.!:;,]+$/g, '')
    .replace(/\s+-\s+.*$/g, '')
    .trim();
  if (
    REFUSAL_LINES.includes(head) ||
    REFUSAL_OPENINGS.some(
      (opening) =>
        lower === opening || lower.startsWith(`${opening} `) || lower.startsWith(`${opening}.`),
    )
  ) {
    return { kind: 'refused', reason: 'instruction' };
  }
  if (normalise(text) === normalise(question)) return { kind: 'refused', reason: 'echo' };
  if (text.length > options.maxQueryChars) return { kind: 'refused', reason: 'too-long' };
  if (text.length < 3) return { kind: 'refused', reason: 'empty' };
  return { kind: 'query', query: text };
}

/**
 * The comparison key for "is this the question again".
 *
 * Case, whitespace, terminal punctuation and surrounding quotes are not meaning: a model that returns
 * the question with a question mark appended has written no query, and searching it would reproduce the
 * first pass at the price of a call. Diacritics are deliberately **not** folded -- two different Unicode
 * spellings of one word embed differently, so they are different queries.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.]+$/g, '')
    .trim();
}
