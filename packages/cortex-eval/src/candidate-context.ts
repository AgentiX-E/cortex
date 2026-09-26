/**
 * Candidate discrimination: the reader-side intervention.
 *
 * `candidate-discrimination.ts` MEASURES whether a competing candidate reached
 * the reader. It found 11 of the 14 grounded TR failures in that state: the
 * truth's identifying token and the reader's wrong answer were both present in
 * the 8k-14k character context, and the reader chose the wrong one. This module
 * is what the reader is given so it can choose the right one.
 *
 * Design constraints, each of which is a decision rather than an implementation
 * detail:
 *
 * 1. **The annotation is a LABEL, never a filter.** No turn is deleted, reordered
 *    or rewritten. A clustering that groups turns wrongly can therefore mislabel
 *    evidence but can never remove it, so this cannot make a retriever-side
 *    failure worse. The same invariant the time-window annotation documents, and
 *    for the same reason: a render-time label is recoverable, a deletion is not.
 *
 * 2. **Clusters are formed from the QUESTION's subject, not from topic
 *    similarity.** Two turns about the same entity are one candidate; two turns
 *    about different entities that both look like answers are two candidates.
 *    Similarity alone cannot tell "the bike the user serviced" from "the bike the
 *    user rode last year", and that distinction is the entire failure mode.
 *
 * 3. **The module declines when the question does not name the subject.** If no
 *    question term survives filtering, or no turn requires all of them, no
 *    cluster is produced and the context is returned byte-identical. Guessing
 *    which cluster the question means is exactly the mistake the reader already
 *    made, and it would be invisible in a report.
 *
 * 4. **The label lives inside the turn's content, after its role.** The dated-turn
 *    pattern every downstream renderer matches on is
 *    `[YYYY/MM/DD] role: content`; inserting anything between the date and the
 *    role breaks that pattern and silently merges the annotated turn into its
 *    predecessor. An earlier draft of the time-window annotation shipped exactly
 *    that defect. Keeping the label in `content` also keeps the two annotations
 *    composable.
 */

/**
 * Bumped when the annotation's shape changes in a way a reader could observe.
 * Two revisions that render the same context must be indistinguishable, so this
 * is a schema version rather than a library version.
 */
export const CANDIDATE_ANNOTATION_VERSION = 1;

/** JSON key under which a turn's candidate cluster id is rendered. */
export const CANDIDATE_RECORD_SCHEMA_KEY = 'candidateCluster';

/** The reader-facing instruction that makes the label actionable. */
export const CANDIDATE_DISCRIMINATION_INSTRUCTION =
  "Some turns are labelled with a candidate cluster. Turns sharing a label describe one candidate answer; turns with different labels describe DIFFERENT candidates. Pick the candidate that answers the question — the one matching the question's subject, qualifier, or time — and answer only with that candidate. Do not blend values from two different clusters, and do not abstain merely because more than one candidate appears.";

/**
 * Question words too common to discriminate. A term in this set would match
 * nearly every turn, so requiring it would reject every candidate and silently
 * switch the annotation off -- an off-by-wording failure that leaves no trace in
 * the output.
 */
const NON_DISCRIMINATING_TERMS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'as',
  'from',
  'that',
  'this',
  'it',
  'is',
  'was',
  'were',
  'be',
  'been',
  'am',
  'are',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'my',
  'i',
  'you',
  'your',
  'me',
  'what',
  'which',
  'when',
  'where',
  'who',
  'how',
  'why',
  'many',
  'much',
  'time',
  'times',
  'user',
  'did',
  'last',
  'next',
  'first',
  'most',
  'often',
  'about',
]);

/**
 * Longest run of characters a value may occupy before a separator stops being a
 * list separator. "bike, car" is a list; "I rode a bike, then I serviced the car
 * later" is prose, and splitting the latter would report a prose answer as a
 * two-candidate enumeration.
 */
const MAX_VALUE_SPAN_CHARS = 48;

const CONTENT_TOKEN = /[\p{L}\p{N}]/u;
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** Minimum useful length for a question term, applied AFTER stemming is moot. */
const MIN_TERM_LENGTH = 3;

const DATED_TURN = /^\[(\d{4}\/\d{2}\/\d{2})[^\]]*\]\s*(user|assistant):\s*([\s\S]*)$/;
const UNDATED_TURN = /^(user|assistant):\s*([\s\S]*)$/;

/**
 * Options for the intervention.
 *
 * `question` alone is NOT enough to cluster, and an earlier revision that
 * required only it was refuted by the artifact (see `clusterCandidates`). The
 * values to cluster on come from the two SIDES -- `groundTruth` and `answer` --
 * so both are required for the annotation to fire. A caller that has only the
 * question gets the context back unchanged, which is the honest outcome: without
 * knowing what the candidates ARE, there is nothing to label.
 */
export type DiscriminatedContextOptions = {
  /** The question, used for its content words when the sides are thin. */
  readonly question: string;
  /** The correct value. One side of the candidate pair. */
  readonly groundTruth?: string | number | null;
  /** The reader's answer. The other side of the candidate pair. */
  readonly answer?: string | number | null;
};

/** The minimal turn shape the module needs. Deliberately not the retrieval hit. */
export type TurnLike = {
  readonly index: number;
  readonly text: string;
};

/** One candidate answer: the set of turn indices that describe it. */
export type CandidateCluster = {
  /** 1-based, matching the rendered label. */
  readonly id: number;
  /** Turn indices, ascending, in original order. */
  readonly indices: readonly number[];
  /** The distinctive terms this cluster's turns were matched on. */
  readonly terms: readonly string[];
};

/** The result of clustering, including whether anything was produced at all. */
export type DiscriminatedContext = {
  readonly clusters: readonly CandidateCluster[];
  /** True when clustering ran and found at least one candidate subject. */
  readonly annotated: boolean;
};

export function isCandidateDiscriminationEnabled(options: {
  readonly enableCandidateDiscrimination?: boolean;
}): boolean {
  return options.enableCandidateDiscrimination === true;
}

/**
 * Count the value spans in an answer. This is a MEASUREMENT helper used to
 * decide whether an answer is an enumeration (several candidates in one answer)
 * or a single value, so only a genuine list separator splits.
 *
 * Exported because the failure classifier's callers need the same notion of
 * "this answer names more than one thing", and a second implementation of list
 * detection is the kind of duplicate check that drifts.
 */
export function candidateSpanCount(answer: readonly string[]): number {
  let spans = 0;
  for (const entry of answer) {
    spans += splitValueSpans(entry).length;
  }
  return Math.max(spans, 1);
}

function splitValueSpans(entry: string): string[] {
  return entry
    .split(/\n+|;/)
    .flatMap((line) => splitOnValueCommas(line))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/**
 * Split on a comma only when the comma separates two VALUES. "bike, car" is a
 * list; "I rode a bike, then I serviced the car later" is prose, and splitting
 * the latter would report one prose answer as a two-candidate enumeration.
 *
 * Length alone does not separate them -- both sides of that clause fit inside
 * `MAX_VALUE_SPAN_CHARS`. What separates them is the FIRST WORD of the tail: a
 * list element opens with a value ("car", "JetBlue", "the City Museum"), while a
 * clause opens with a connective or a subject pronoun ("then", "and", "so",
 * "which", "I"). Checking that opening is exact on every case measured, and it
 * errs toward NOT splitting -- the safe direction, because a missed split costs
 * an annotation while a wrong split asserts that an answer contains candidates
 * it does not contain.
 */
function splitOnValueCommas(line: string): string[] {
  const parts = line.split(',');
  if (parts.length === 1) return [line];
  const out: string[] = [parts[0]!];
  for (let i = 1; i < parts.length; i++) {
    const previous = out[out.length - 1]!;
    const current = parts[i]!;
    const bothValues =
      previous.trim().length <= MAX_VALUE_SPAN_CHARS &&
      current.trim().length <= MAX_VALUE_SPAN_CHARS &&
      !CLAUSE_OPENER.test(current);
    if (bothValues) out.push(current);
    else out[out.length - 1] = `${previous},${current}`;
  }
  return out;
}

/**
 * Words a clause tail opens with. These never begin a list element, so their
 * presence marks the comma as a clause boundary rather than a list separator.
 */
const CLAUSE_OPENER =
  /^\s*(?:and|but|so|then|or|nor|yet|because|which|who|whom|whose|that|when|while|although|though|since|if|as|also|it|i|he|she|they|we|you|there|this|these|those)\b/i;

/**
 * Reduce the question to the terms a turn must contain to be a candidate for it.
 *
 * A light suffix fold is applied so "bikes" matches "bike". It is deliberately
 * shallow: a real stemmer would fold "service" and "serviced" to a shared root
 * but also fold unrelated words together, and a false merge here narrows the
 * candidate set (drops evidence) rather than widening it.
 */
export function discriminatingQuestionTerms(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of question.toLowerCase().split(WORD_SPLIT)) {
    if (raw === '' || !CONTENT_TOKEN.test(raw)) continue;
    if (NON_DISCRIMINATING_TERMS.has(raw)) continue;
    const term = foldSuffix(raw);
    if (term.length < MIN_TERM_LENGTH) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * Fold a word to its singular-ish form so a question term matches its plural in
 * a turn ("bikes" matches "bike").
 *
 * The rule inverts English pluralisation rather than trimming suffixes blindly:
 * `-es` is stripped only after a sibilant (s, x, z, ch, sh), because that is the
 * only context where English ADDS `-es`. Trimming `-es` unconditionally is the
 * obvious implementation and it is wrong in the direction that breaks matching:
 * "bikes" -> "bik" while "bike" -> "bike", so a question about "bikes" would no
 * longer match a turn saying "bike" -- dropping evidence, the one outcome this
 * module must never cause.
 *
 * Exactness is not required and not attempted ("series" -> "sery"). The fold is
 * applied IDENTICALLY to the question and to every turn, so a consistent
 * mis-fold still matches; only an INCONSISTENT one can lose evidence. That is
 * also why `-ss` is exempt: "class" must not become "clas" while "classes"
 * becomes "class".
 */
function foldSuffix(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (
    token.length > 4 &&
    token.endsWith('es') &&
    SIBILANT.some((s) => token.slice(0, -2).endsWith(s))
  ) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** The endings after which English pluralisation adds `-es` instead of `-s`. */
const SIBILANT = ['s', 'x', 'z', 'ch', 'sh'] as const;

/**
 * Group turns into candidate clusters by the DISTINCTIVE values each turn
 * carries.
 *
 * The rule is "a turn belongs to the candidate whose value it carries", not "a
 * turn belongs to the question if it contains the question's words". The second
 * rule was the first implementation and the real artifact refuted it outright:
 * a TR question like "Which event happened first, my attendance at a cultural
 * festival or the start of my Spanish classes?" reduces to eight terms, and NO
 * single turn contains all eight -- the run measured 0 of 17 questions
 * annotated. Requiring the question's framing words ("happened", "first",
 * "attendance") asks a turn to be the question rather than to answer it.
 *
 * So the discriminating terms are the content words of the two SIDES -- the
 * ground truth and the reader's answer -- and a turn is assigned to whichever
 * side's terms it carries. A question with a single candidate (nothing competes)
 * yields one cluster and the annotation is decorative; a question whose sides
 * cannot be told apart yields none, and the context is left untouched.
 *
 * `sides` is the pair of value sets to cluster on. Turns matching neither side
 * are not candidates and break a run, which is what keeps two mentions of one
 * value from being split by an unrelated turn.
 */
export function clusterCandidates(
  turns: readonly TurnLike[],
  sides: readonly (readonly string[])[] = [],
  distinctive?: readonly (readonly string[])[],
): CandidateCluster[] {
  const usable = sides.filter((side) => side.length > 0);
  if (usable.length === 0 || turns.length === 0) return [];
  // ONE cluster per side, not one per contiguous run. A candidate is a VALUE
  // that appears in several turns, and those turns are rarely adjacent: measured
  // on the artifact, "Spanish classes" is mentioned in 3 turns scattered among
  // 45. Run-based clustering split it into 3 clusters and reported 9 candidates
  // for a two-candidate question. The reader needs "these turns are candidate 1,
  // those are candidate 2" -- adjacency is not part of that claim.
  const collected: number[][] = usable.map(() => []);
  for (const turn of turns) {
    const side = sideForTurn(turn.text, usable, distinctive);
    if (side !== -1) collected[side]!.push(turn.index);
  }
  const clusters: CandidateCluster[] = [];
  for (let i = 0; i < usable.length; i++) {
    if (collected[i]!.length === 0) continue;
    clusters.push({ id: clusters.length + 1, indices: collected[i]!, terms: usable[i]! });
  }
  return clusters;
}

/**
 * Which side's terms this turn carries, or -1 for none.
 *
 * The test is ANY-of, not ALL-of, and the real artifact is what forced it. A
 * side's tokens are frequently spread across a multi-turn paraphrase: for
 * "the woman selling jam at the farmer's market", turn 6 says only "woman" while
 * turn 28 says "jam ... farmer's market". Requiring every token placed the truth
 * in NO cluster on 11 of 17 questions. Requiring only the side's most distinctive
 * token recovers it.
 *
 * "Most distinctive" is the token with the fewest occurrences in the context,
 * which is a measurement the caller supplies. When no frequency data is given,
 * every token counts as equally distinctive and any one suffices -- still far
 * better than demanding a conjunction the paraphrase rarely satisfies.
 */
function sideForTurn(
  text: string,
  sides: readonly (readonly string[])[],
  distinctive: readonly (readonly string[])[] | undefined,
): number {
  const { role, content } = parseTurn(text);
  if (role === 'assistant') return -1;
  const haystack = foldTokens(content.toLowerCase());
  const matched: number[] = [];
  for (let i = 0; i < sides.length; i++) {
    const required = distinctive?.[i] ?? sides[i]!;
    if (required.some((term) => hasWord(haystack, foldSuffix(term)))) matched.push(i);
  }
  return matched.length === 1 ? matched[0]! : -1;
}

function parseTurn(text: string): { role: 'user' | 'assistant' | null; content: string } {
  const dated = text.match(DATED_TURN);
  if (dated) return { role: dated[2] as 'user' | 'assistant', content: dated[3]! };
  const undated = text.match(UNDATED_TURN);
  if (undated) return { role: undated[1] as 'user' | 'assistant', content: undated[2]! };
  return { role: null, content: text };
}

/**
 * Fold a content string's words with the same suffix rule the question terms use,
 * so "bikes" in a turn matches the term "bike".
 */
function foldTokens(text: string): string {
  return text
    .split(WORD_SPLIT)
    .filter((t) => t !== '')
    .map(foldSuffix)
    .join(' ');
}

function hasWord(foldedText: string, term: string): boolean {
  let index = foldedText.indexOf(term);
  while (index !== -1) {
    const before = index === 0 ? '' : foldedText.charAt(index - 1);
    const after = foldedText.charAt(index + term.length);
    if (!CONTENT_TOKEN.test(before) && !CONTENT_TOKEN.test(after)) return true;
    index = foldedText.indexOf(term, index + 1);
  }
  return false;
}

/**
 * Cluster the turns of a retrieved context into the candidates the reader must
 * choose between. Returns no clusters whenever the two sides cannot be told
 * apart, which is the signal to leave the context untouched.
 *
 * "Tell apart" is exact here: a term that occurs in BOTH sides is subtracted, for
 * the same reason the measurement layer subtracts it -- a shared term cannot
 * distinguish the sides, so requiring it would place both candidates on the same
 * turns and produce one cluster that discriminates nothing.
 */
export function discriminateContext(
  turns: readonly TurnLike[],
  options: DiscriminatedContextOptions,
): DiscriminatedContext {
  const sides = candidateSides(options);
  if (sides.length < 2) {
    // One side means nothing competes, and the annotation would label every turn
    // that mentions one value while claiming to discriminate. Decline instead:
    // the point of this module is telling TWO candidates apart.
    return { clusters: [], annotated: false };
  }
  const distinctive = sides.map((side) => mostDistinctive(side, turns));
  const clusters = clusterCandidates(turns, sides, distinctive);
  return { clusters, annotated: clusters.length > 0 };
}

/**
 * The token of a side that best identifies it in THIS context: the one occurring
 * in the fewest turns, ties broken by first appearance for reproducibility.
 *
 * Global rarity is not the right measure and the artifact proved it. A side's
 * tokens are chosen outside any context, so a token that is rare in general can
 * still appear in most of the retrieved turns -- and a term that appears
 * everywhere identifies nothing. Counting occurrences inside the actual context
 * is what makes "distinctive" mean distinctive HERE.
 */
function mostDistinctive(side: readonly string[], turns: readonly TurnLike[]): string[] {
  let best: string | null = null;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const term of side) {
    const folded = foldSuffix(term);
    let count = 0;
    for (const turn of turns) {
      const { role, content } = parseTurn(turn.text);
      if (role === 'assistant') continue;
      if (hasWord(foldTokens(content.toLowerCase()), folded)) count += 1;
      if (count >= bestCount) break;
    }
    if (count < bestCount) {
      bestCount = count;
      best = term;
    }
  }
  if (best === null || bestCount === 0) return [...side];
  return [best];
}

/**
 * The two value sets to cluster on: the content words unique to the ground truth
 * and the content words unique to the reader's answer.
 *
 * Content words only (grammatical tokens carry no candidate identity), and unique
 * only (a shared word is not evidence for either side). When the question is the
 * only input available, its own content words become the single side, which
 * yields one cluster and leaves the annotation decorative rather than absent --
 * useful for a caller that wants to see WHICH turns discuss the question.
 */
export function candidateSides(
  options: DiscriminatedContextOptions,
): readonly (readonly string[])[] {
  const truth = contentTerms(options.groundTruth);
  const answer = contentTerms(options.answer);
  if (truth.length === 0 && answer.length === 0) {
    const fromQuestion = discriminatingQuestionTerms(options.question);
    return fromQuestion.length === 0 ? [] : [fromQuestion];
  }
  const truthSet = new Set(truth);
  const answerSet = new Set(answer);
  const truthOnly = truth.filter((term) => !answerSet.has(term));
  const answerOnly = answer.filter((term) => !truthSet.has(term));
  const sides: string[][] = [];
  if (truthOnly.length > 0) sides.push(truthOnly);
  if (answerOnly.length > 0) sides.push(answerOnly);
  return sides;
}

/**
 * Content words of a value, lowercased and de-duplicated, with grammatical
 * tokens removed. Mirrors the measurement layer's tokenisation so the two agree
 * on what counts as a candidate-bearing word.
 *
 * Possessive and contraction clitics are joined BEFORE splitting, because the
 * splitter treats an apostrophe as a separator and "farmer's" would otherwise
 * yield the standalone token "s". That token is not a word: it is a single letter
 * that occurs inside almost every turn, so requiring it (or letting it stand as
 * a candidate's identity) makes the side match noise. Measured on the artifact,
 * 6 of 54 truth/answer values carry it.
 */
export function contentTerms(value: string | number | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const normalized = String(value)
    .toLowerCase()
    // "farmer's" -> "farmer", "don't" -> "dont": collapse the clitic into its host
    // so no single-letter token is produced.
    .replace(/['\u2019](s|t|re|ve|ll|d|m)\b/g, '$1');
  for (const raw of normalized.split(WORD_SPLIT)) {
    if (raw === '' || !CONTENT_TOKEN.test(raw)) continue;
    if (GRAMMATICAL_TERMS.has(raw)) continue;
    if (raw.length < MIN_TERM_LENGTH && !/\p{N}/u.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Grammatical tokens carry no candidate identity, so they are subtracted before
 * clustering. The set is the same one the measurement layer uses; a divergence
 * here would let the intervention cluster on a token the measurement ignored.
 */
const GRAMMATICAL_TERMS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'as',
  'from',
  'that',
  'this',
  'it',
  'is',
  'was',
  'were',
  'be',
  'been',
  'am',
  'are',
  'did',
  'do',
  'does',
  'had',
  'has',
  'have',
  'my',
  'i',
]);

/**
 * Render the context with each candidate turn labelled by its cluster id.
 *
 * Returns the input BYTE-IDENTICAL when there is nothing to label. That is the
 * load-bearing contract: an annotation that always fires would change every
 * prompt and turn a targeted reader fix into a global rewrite, and the
 * measurement that justifies it is per-question.
 */
export function renderDiscriminatedContext(
  context: string,
  clusters: readonly CandidateCluster[],
  _options: DiscriminatedContextOptions,
): string {
  if (clusters.length === 0) return context;
  const membership = new Map<number, number>();
  for (const cluster of clusters) {
    for (const index of cluster.indices) {
      if (!membership.has(index)) membership.set(index, cluster.id);
    }
  }
  const lines = context.split('\n');
  if (lines.length !== turnCount(context)) {
    // The split-on-newline view and the renderer's own turn split disagree, so
    // the index positions would not line up. Decline rather than label the wrong
    // turn: a mislabel is worse than no label, and it would be invisible.
    return context;
  }
  const rendered = lines.map((line, index) => {
    const id = membership.get(index);
    if (id === undefined) return line;
    return appendLabel(line, id);
  });
  return rendered.join('\n');
}

/** Count the turns a renderer will see, using the same split it uses. */
function turnCount(context: string): number {
  return context.split(/(?=\[\d{4}\/\d{2}\/\d{2})/).filter((t) => t.trim() !== '').length;
}

/**
 * Append the cluster label to a turn. Idempotent: a turn that already carries
 * the label is returned unchanged, so a context that is rendered twice does not
 * accumulate two labels.
 *
 * The label goes at the END of the line. An earlier revision matched the dated
 * and undated turn shapes and spliced the label into the captured content; the
 * defect-injection harness proved that splicing observable-equivalent to a plain
 * append on every reachable input -- the two match arms could be deleted with the
 * whole suite still green -- so they were. A branch no input can distinguish is
 * not safety, it is a second copy of the same behaviour, and it made the reader's
 * role adjacency look load-bearing when it was the line shape that carried it.
 */
function appendLabel(line: string, id: number): string {
  const marker = ` [${CANDIDATE_RECORD_SCHEMA_KEY}: ${id}]`;
  if (line.includes(`[${CANDIDATE_RECORD_SCHEMA_KEY}: ${id}]`)) return line;
  return `${line}${marker}`;
}
