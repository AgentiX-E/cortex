/**
 * Query expansion for the multi-session route: the question rewritten into the
 * phrases the evidence is likely to use.
 *
 * ## The defect this is written against
 *
 * Three prompt-side attempts have been measured and each failed: the structure
 * (`enumerated`), the membership review (`audit`), and the first pass's own ledger
 * (`sweep`). §13.96 read the result and moved the diagnosis: the deficit is not how
 * long the list is, and it is not the reader's willingness to walk the evidence. It
 * is **which mentions the reader treats as instances** -- a matching decision made
 * before any list exists.
 *
 * That decision is made by retrieval, and retrieval has a measurable blind spot on
 * this workload. `--numbers` on `39416366870` found the gold digit string nowhere in
 * the window for **12 of the 44** wrong MR answers that state a number. A digit that
 * appears nowhere was never read, so no wording reaches it. The reference pipeline
 * carries `expansionQueries` for exactly this reason: its trace shows three phrases
 * whose words the question does not contain, and its retrieval runs over all four.
 *
 * ## Why phrases and not synonyms
 *
 * The failing questions count or aggregate past activities. Their evidence is written
 * as the activity ("led a consumer-research project"), while the question names a
 * category ("how many projects"). A synonym of the category retrieves every session
 * that mentions the category; an activity phrase retrieves the sessions that describe
 * one. So the prompt asks for **action plus object**, and the parser refuses bare
 * category nouns only in the sense that it refuses what the model returned as a
 * sentence rather than as a phrase.
 *
 * ## Why this module is offline-pure except for one call
 *
 * Everything except {@link expandMultiSessionQueries} is a pure function of strings,
 * which is what lets the parser's refusals be asserted directly. The one call is the
 * model's, and it is made **before** the relevance index is built rather than during
 * a question: `CortexMemory`'s `relevanceFor` is a synchronous table lookup, so a
 * phrase produced at answer time would read the index's floor score and the mechanism
 * would be unmeasurable. That is a fact about the seam, not a preference -- see
 * `relevance-index.ts` §"Why the queries are the question alone", which this module
 * is the registered exception to.
 */
import type { LLM } from '@agentix-e/cortex-core';

/**
 * How many phrases one question is expanded into when the caller names no width.
 *
 * Four rather than the reference pipeline's three: the three-phrase budget is the
 * number its own retrieval caps at (`queryExpansionTopKPerQuery`), and this arm fuses
 * queries by reciprocal rank over one pool, so a fourth phrase buys a stronger vote
 * for a session two phrases already point at without lengthening any single list.
 * It is a bound rather than a target, and a question whose expansion returns nothing
 * usable falls back to the bare question rather than padding the list.
 */
const DEFAULT_EXPANSION_PHRASES = 4;

/**
 * The shortest phrase the parser keeps.
 *
 * Three characters is the point below which a "phrase" is a token the model emitted to
 * fill the list (`2`, `-`, `n/a`). The reference pipeline's own notes record the model
 * reproducing a bare `2` verbatim, and a one- or two-character query is embedded as
 * noise that competes with the question for the same pool.
 */
const MIN_PHRASE_CHARS = 3;

/**
 * The longest phrase the parser keeps.
 *
 * Phrases are retrieval queries, not sentences: a model that explains itself produces
 * a clause whose embedding is dominated by the explanation. 80 characters is above
 * every activity phrase in this dataset's own traces and below every refusal.
 */
const MAX_PHRASE_CHARS = 80;

/**
 * Substrings that mark a response as a refusal rather than a list.
 *
 * ## Why this is load-bearing rather than defensive
 *
 * The reference pipeline's own trace records the failure: asked to expand, the model
 * answered `"I don't have access to your past conversations or evidence sessions"`,
 * and the three sentences of that refusal were carried into retrieval as **phrases**.
 * Retrieval then ran on text unrelated to the question, the reader declined, and the
 * artifact recorded an abstention that had nothing to do with the evidence.
 *
 * A refusal is recognised instead of being truncated, because truncation would keep
 * its first clause -- which is the most generic one -- and every downstream count
 * would then describe a query set the run never intended to issue.
 */
const REFUSAL_MARKERS: readonly string[] = [
  "i can't",
  'i cannot',
  'i can not',
  "i don't have",
  'i do not have',
  "i'm unable",
  'i am unable',
  'unable to',
  'no access to',
  'as an ai',
  'sorry',
];

/**
 * A label the model may echo before the list, stripped from the first item.
 *
 * The prompt ends with the label on its own line, so a completion that continues that
 * line rather than starting a new one returns `Activities: led a project, ...`. Left in
 * place, the first phrase carries a word no evidence turn contains and loses its slot
 * to the other three.
 */
const ECHOED_LABEL = /^(?:specific\s+)?(?:activities|items|phrases|queries)\s*:\s*/i;

/** Leading list decoration: `1.`, `2)`, `-`, `*`, `•`. */
const LIST_DECORATION = /^(?:\d+[.)]|[-*\u2022])\s*/;

/** Quotes a model wraps a phrase in, in either direction and either width. */
const WRAPPING_QUOTES = /^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g;

/**
 * The prompt. Multi-session only, and that is a second argument for its shape.
 *
 * A single prompt that served every capability would have to hedge between counting
 * activities, comparing values and ordering events; the reference pipeline carries
 * four prompts for that reason. This arm dispatches expansion to one route, so the
 * instruction can be written for the one thing that route asks.
 */
function buildExpansionPrompt(question: string, limit: number = DEFAULT_EXPANSION_PHRASES): string {
  return [
    'You are helping retrieve the evidence sessions for a multi-session question.',
    'The question counts or aggregates activities the user described in the past, and its evidence sessions are recalled by the ACTIVITY, not by a bare object noun.',
    'Given the question, list the specific ACTIVITIES whose wording would appear in the evidence: each phrase combines an action with its object and any distinguishing detail.',
    'Do not list bare category nouns; include the action so the right session is matched instead of every session that mentions the same object.',
    'Do not invent names, brands or activities that the question does not imply.',
    `Output only a comma-separated list of at most ${String(limit)} short phrases, with no explanation, no numbering and no quotation marks.`,
    '',
    `Question: ${question}`,
    '',
    'Activities:',
  ].join('\n');
}

/**
 * One phrase's worth of cleaning, or `null` when the item is not a phrase.
 *
 * Split out so the rejection rules are one function rather than a chain inside the
 * loop: every branch here is a distinct refusal, and the test suite names each one.
 */
function cleanPhrase(item: string): string | null {
  // Trimmed first, because the decoration patterns are anchored: a list rendered as
  // `a, - b` leaves the second item with a leading space, and an unanchored pattern would
  // then keep the hyphen as part of the phrase.
  const undecorated = item.trim().replace(LIST_DECORATION, '').replace(ECHOED_LABEL, '');
  const unquoted = undecorated.replace(WRAPPING_QUOTES, '');
  // Collapsed rather than trimmed alone: a phrase broken across a line is still one
  // phrase, and the embedding sees the whitespace as a token boundary.
  const phrase = unquoted.replace(/\s+/g, ' ').trim();
  if (phrase.length < MIN_PHRASE_CHARS || phrase.length > MAX_PHRASE_CHARS) return null;
  const lowered = phrase.toLowerCase();
  if (REFUSAL_MARKERS.some((marker) => lowered.includes(marker))) return null;
  return phrase;
}

/** Case-, whitespace- and punctuation-insensitive form, for equality against the question. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?.!,;:]+$/g, '')
    .trim();
}

/**
 * Whether the response opened by declining, which makes the whole response a refusal.
 *
 * ## Why the head decides, and the items alone do not
 *
 * The reference pipeline's recorded failure was three sentences of a refusal, and only the
 * first of them carried the refusal's own words -- `I don't have access to ...`, followed by
 * `so I can't identify ...` and `I can help if you share context`. Filtering item by item
 * kept the third sentence, which reads as a plausible activity phrase and would have been
 * embedded as one. The head is the position a refusal announces itself in, so the head is
 * what is tested; an item below it is still filtered individually, for the mixed case where
 * the model lists something and then apologises for the rest.
 */
function opensAsRefusal(raw: string): boolean {
  // `split` returns at least one element for any input, the empty string included, so the
  // first is always a string. The assertion states that rather than carrying a `?? ''` whose
  // right operand no test could reach -- the DEAD-branch shape this campaign removes.
  const head = raw.split(/[,;\n]+/)[0] as string;
  const lowered = head.toLowerCase();
  return REFUSAL_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Parse the model's list into distinct phrases that are not the question itself.
 *
 * ## Why the question is removed from its own expansion
 *
 * A phrase identical to the question adds a second vote for the ranking the bare
 * question already produced, which is the definition of no expansion: it would make a
 * run whose model echoed the input read as a run that expanded it. Equality is compared
 * after normalising case, whitespace and trailing punctuation, so `How many projects
 * did I lead?` and `how many projects did i lead` collapse to one.
 *
 * ## Why duplicates are folded rather than counted
 *
 * The queries are fused by reciprocal rank. Two copies of one phrase are two votes for
 * the same ranking -- a weight, not a phrase -- and the fusion would then favour
 * whichever phrase the model happened to repeat. Folding keeps the count in the
 * artifact equal to the number of distinct queries actually issued.
 */
function parseExpansion(
  raw: string,
  question: string,
  limit: number = DEFAULT_EXPANSION_PHRASES,
): string[] {
  if (opensAsRefusal(raw)) return [];
  const asked = comparable(question);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(/[,;\n]+/)) {
    const phrase = cleanPhrase(item);
    if (phrase === null) continue;
    const key = comparable(phrase);
    if (key === '' || key === asked || seen.has(key)) continue;
    // Checked here, after folding and before the push, for two reasons: a repeat the `seen`
    // set already removed cannot spend a slot, and a bound of zero returns nothing rather
    // than one phrase -- a post-push check would return one, which a caller reads as "the
    // model produced one" rather than "the bound was zero".
    if (kept.length === limit) break;
    seen.add(key);
    kept.push(phrase);
  }
  return kept;
}

/** One question the expansion may reach. `capability` is the routing fact. */
export type ExpansionTarget = {
  readonly question: string;
  readonly capability: string;
};

/**
 * What the expansion produced, in the shape the artifact needs.
 *
 * `questions` counts the **distinct** questions expansion was attempted for, so a run
 * can state its reach independently of what the model returned; `phrases` counts the
 * distinct phrases the index was actually built with; `empty` counts the questions the
 * parser refused completely. The three are separate because a run whose `phrases` is 0
 * with `questions` 121 has a model problem, while one whose `questions` is 0 has a
 * wiring problem, and a single number cannot tell them apart. `questions` always equals
 * `byQuestion.size + empty`, which the suite asserts rather than assumes.
 */
export type QuestionExpansion = {
  readonly byQuestion: ReadonlyMap<string, readonly string[]>;
  readonly questions: number;
  readonly phrases: number;
  readonly empty: number;
};

/**
 * The capability whose questions this module expands.
 *
 * Named here rather than passed by the caller, because the reason expansion is confined
 * to one route is structural: the four untouched capabilities are this dispatch's
 * internal control, and their `promptChars` and window turns must reproduce the prior
 * run to the character. A caller that could name a different capability would make that
 * control a parameter, and a parameter is a thing a later run changes.
 */
const EXPANDED_CAPABILITY = 'MR';

/**
 * Ask the model for each multi-session question's activity phrases, once per question.
 *
 * ## Why a failure is thrown rather than degraded
 *
 * A run dispatched with `queryExpansion=llm` that silently answered from unexpanded
 * queries would publish an artifact whose configuration claims a treatment the prompts
 * never received -- the §10.10 shape, where a recorded configuration never reaches the
 * decision it names. So a transport error propagates and the run fails, and a refusal is
 * not an error but a **refused expansion**: it is counted in `empty`, the question keeps
 * its bare query, and the artifact says how many questions that happened to.
 *
 * ## Why each distinct question is asked once
 *
 * The dataset carries one row per question, but an arm that runs several repetitions
 * builds its index once per repetition, and a caller may hand the same text twice. An
 * expansion call is a model call, so the loop keeps a `seen` set: the count stays a fact
 * about the run's questions rather than about how many times the loop was entered, and
 * two repetitions cannot disagree about the phrases because the same call produced them.
 */
export async function expandMultiSessionQueries(
  llm: Pick<LLM, 'complete'>,
  targets: readonly ExpansionTarget[],
  limit: number = DEFAULT_EXPANSION_PHRASES,
): Promise<QuestionExpansion> {
  const byQuestion = new Map<string, readonly string[]>();
  const seen = new Set<string>();
  let questions = 0;
  let phrases = 0;
  let empty = 0;
  for (const target of targets) {
    if (target.capability !== EXPANDED_CAPABILITY) continue;
    if (seen.has(target.question)) continue;
    seen.add(target.question);
    questions += 1;
    const raw = await llm.complete(buildExpansionPrompt(target.question, limit));
    const parsed = parseExpansion(raw, target.question, limit);
    if (parsed.length === 0) {
      // Not stored: an empty list means "retrieve with the bare question", which is the
      // same state as never having been expanded, and storing `[]` would make
      // `byQuestion.has` true for a question that gained no query.
      empty += 1;
      continue;
    }
    byQuestion.set(target.question, parsed);
    phrases += parsed.length;
  }
  return { byQuestion, questions, phrases, empty };
}
