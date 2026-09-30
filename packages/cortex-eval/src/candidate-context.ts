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
  /**
   * Pre-derived sides, used INSTEAD of deriving them from `groundTruth`/`answer`.
   *
   * Exists for the non-oracle channel. `groundTruth` is unknown at inference
   * time -- that is why the question is being asked -- so an arm that clusters
   * using it measures a system no deployment can reproduce. A caller that has
   * derived its sides from the retrieval result supplies them here and passes no
   * ground truth, which keeps the arm non-oracle while still giving the
   * clustering the two sides it requires.
   *
   * Takes precedence when present, including when it is an empty list: an empty
   * list means "the caller looked and found no competition", which is a decision
   * and not the same as "the caller had no opinion".
   */
  readonly sidesOverride?: readonly (readonly string[])[];
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
  // An explicit override wins, and is distinguished from "absent" by identity
  // rather than by emptiness: `sidesOverride: []` is a caller reporting that it
  // found no competition, which must not silently fall through to deriving sides
  // from a ground truth the caller deliberately did not supply.
  const sides = options.sidesOverride ?? candidateSides(options);
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
 * Derive two competing candidate sides from the RETRIEVAL RESULT alone.
 *
 * This is the non-oracle channel, and it exists because the two obvious ones do
 * not work (see docs/16 for the measurements):
 *
 *   - Deriving from `groundTruth` makes the arm oracle-assisted (docs/16.3).
 *   - Deriving from the question returns ONE side with the candidates merged
 *     (docs/16.4), so `discriminateContext` declines and the feature is inert.
 *
 * Both inputs here are available at inference time: `retrieved` is what the
 * retriever returned and `answer` is what the baseline arm produced. NEITHER IS
 * TRUTH, which is the property that makes an A/B run this way a measurement of a
 * deployable system. `answer` does not violate this -- it is the system's own
 * output, not the dataset's ground truth.
 *
 * How the sides are found
 * -----------------------
 * A candidate's identity is usually a MULTI-WORD span, and this is the fact that
 * makes a bag-of-words derivation fail. Measured on the fixture:
 *
 *   "I took the cargo bike to the coast last week."   -> took, cargo, bike, coast, last, week
 *   "I rode the racing bike to the coast for the race." -> rode, racing, bike, coast, race
 *
 * `bike` and `coast` are shared by both turns while `cargo` and `racing` are the
 * discriminators. So the mechanism is: find two-word spans that RECUR across
 * turns -- `cargo bike` and `racing bike` each appear twice -- and treat the
 * modifier as the candidate's identity. Requiring recurrence is what separates a
 * candidate from an incidental collocation, and it needs no vocabulary list.
 *
 * @param input `retrieved` are the turns; `question` is accepted for a
 *   consistent call shape but is not used to form a side, because the framing
 *   terms a question reduces to match nothing (docs/16.4).
 * @param input.answer the baseline arm's answer, used to recognise which
 *   recurring span the system already committed to. It never forms a side alone.
 * @returns zero, one or two sides. Fewer than two means no competition was
 *   found and the caller should decline to annotate -- guessing a pair would
 *   assert a choice the retrieval does not contain.
 */
export function retrievalCandidateSides(input: {
  readonly question: string;
  readonly retrieved: readonly TurnLike[];
  readonly answer?: string | number | null;
}): readonly string[][] {
  // Assistant turns are excluded because `sideForTurn` excludes them: a side
  // built only from the assistant's vocabulary would match no turn and produce
  // an empty cluster.
  const userTurns = input.retrieved.filter((turn) => parseTurn(turn.text).role !== 'assistant');
  if (userTurns.length === 0) return [];

  // Recurring two-word spans, as modifier -> the turns it appears in.
  const spans = new Map<string, Set<number>>();
  for (const turn of userTurns) {
    const terms = contentTerms(parseTurn(turn.text).content);
    for (let i = 0; i + 1 < terms.length; i += 1) {
      const modifier = terms[i]!;
      const head = terms[i + 1]!;
      const key = `${modifier} ${head}`;
      const seen = spans.get(key) ?? new Set<number>();
      seen.add(turn.index);
      spans.set(key, seen);
    }
  }

  // Group spans by their HEAD word: "cargo bike" and "racing bike" compete
  // because they are alternatives for the same slot.
  //
  // Recurrence is required of the SLOT, not of each modifier, and getting that
  // backwards was the first implementation's bug. Measured on the fixture, only
  // `racing bike` recurs across turns while `cargo bike` appears once, so a
  // filter applied before grouping discards the very alternative that makes the
  // pair. What recurrence establishes is that the head names a real slot -- a
  // word several turns use to talk about the same thing -- and once the slot is
  // established, every modifier filling it is a candidate, however often it
  // appears.
  const byHead = new Map<string, { modifier: string; turns: Set<number> }[]>();
  for (const [key, turns] of spans) {
    // `head === undefined` is not checked because it cannot happen: every key was
    // built above as two content terms joined by a space, and `contentTerms`
    // never emits an empty term. A guard here would be a branch no input can
    // take, which reads as safety and is only a second copy of the invariant.
    const space = key.indexOf(' ');
    const head = key.slice(space + 1);
    const group = byHead.get(head) ?? [];
    group.push({ modifier: key.slice(0, space), turns });
    byHead.set(head, group);
  }

  // A slot competes when it holds at least two modifiers AND its alternatives
  // actually diverge, which is established by RECURRENCE somewhere in the slot.
  //
  // Recurrence is required of the SLOT, not of each modifier, and it is checked
  // in BOTH directions -- a modifier that recurs, or a head seen more than once.
  // Getting either wrong has a measured cost:
  //
  //   - Filtering before grouping discarded `cargo bike` (mentioned once) on the
  //     fixture, leaving the slot with one alternative and returning [] -- the
  //     feature switching itself off.
  //   - Anchoring on a recurring MODIFIER alone dropped a three-alternative bike
  //     slot (`cargo`/`racing`/`touring`, each once) in favour of a two-
  //     alternative car slot (`blue` twice, `red` once), so the retrieval raised
  //     a three-way choice and the annotation reported the two-way one.
  //
  // The head count is what the second case needs: `bike` appears in three turns
  // and `car` in three, but `bike` is the slot with the most alternatives, and
  // the number of turns mentioning the head is a measure of how much the
  // retrieval is ABOUT that slot. Counting the head and the modifiers together
  // means the requirement is satisfied by either kind of evidence, which is the
  // property both failures were missing.
  const competitive = [...byHead].filter(
    ([, group]) =>
      group.length >= 2 &&
      (group.some((entry) => entry.turns.size >= 2) || headTurnCount(group) >= 2),
  );

  // The slot with the most competing modifiers is the one the question is about,
  // because a question that names alternatives produces several of them. Ties go
  // to the alphabetically first head so the choice does not depend on iteration
  // order.
  const best = competitive.sort((a, b) =>
    a[1].length === b[1].length ? (a[0] < b[0] ? -1 : 1) : b[1].length - a[1].length,
  )[0];
  if (best === undefined) return [];
  const [headWord, group] = best;

  // At most two sides, because `discriminateContext` labels a binary choice and
  // a third alternative would make a label ambiguous. The answer, when it names
  // one of the modifiers, decides which two -- otherwise the first two by
  // alphabetical modifier keep the result deterministic.
  const ordered = [...group].sort((a, b) => (a.modifier < b.modifier ? -1 : 1));
  const answerTerms = new Set(contentTerms(input.answer));
  const chosen = ordered.length <= 2 ? ordered : pickWithAnswer(ordered, answerTerms);

  // Each side is the modifier plus the shared head, so a turn is matched on the
  // full candidate ("cargo bike") rather than on a word the candidates share.
  return chosen.map((entry) => [entry.modifier, headWord]);
}

/**
 * How many distinct turns mention a slot, however they spell the alternative.
 *
 * A slot is "discussed" when more than one turn names SOMETHING that fills it,
 * even if each alternative is named once. That is the evidence a recurring
 * modifier provides and the evidence a three-way bike slot provides without any
 * modifier recurring -- the retrieval returns to the slot even though it never
 * returns to one modifier.
 */
function headTurnCount(group: readonly { turns: Set<number> }[]): number {
  const turns = new Set<number>();
  for (const entry of group) {
    for (const index of entry.turns) turns.add(index);
  }
  return turns.size;
}

/** Narrows more than two alternatives to the two the answer points at. */
function pickWithAnswer(
  ordered: readonly { modifier: string; turns: Set<number> }[],
  answerTerms: ReadonlySet<string>,
): { modifier: string; turns: Set<number> }[] {
  const mentioned = ordered.filter((entry) => answerTerms.has(entry.modifier));
  // Strictly one, not "at least one". A hedged answer naming two alternatives is
  // not a commitment, and treating it as one makes the surviving pair depend on
  // the ORDER OF THE HEDGE: measured, 'racing and touring bike' returns
  // [racing, cargo] under `>= 1` but [cargo, racing] under `=== 1`.
  if (mentioned.length !== 1) return ordered.slice(0, 2);
  // The partner always exists: this is only called with more than two
  // alternatives, so some entry differs from the winner. Searching for it rather
  // than indexing keeps the winner out of its own pair without needing a guard
  // for a case that cannot arise.
  const winner = mentioned[0]!;
  const partner = ordered.find((entry) => entry.modifier !== winner.modifier)!;
  return [winner, partner];
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
