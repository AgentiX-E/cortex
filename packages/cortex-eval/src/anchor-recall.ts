/**
 * Anchor selection and session-neighbourhood restoration: a deterministic widening of the
 * candidate pool that asks the ranking for less than it currently has to do.
 *
 * ## The measurement this exists for
 *
 * §13.255.2 put the arm's worst cell on a specific question: for **145** of 500 questions the
 * gold turn that never arrived is a turn **the ranking never surfaced**, not a turn the budget
 * cut. §13.254.3 makes that narrower still -- on the multi-session route, where the effect is
 * largest, **not one** of the missing questions is room-limited. A wider prompt cannot buy a
 * turn no ranking offered, which is why the previous three rounds spent themselves on the room
 * and this one starts from the pool.
 *
 * ## Why this is a mechanism and not a tuning constant
 *
 * Widening `topK` was already spent: §13.54 raised the pool and the coverage did not move, which
 * says the missing turns are not just below the cut -- they score far below it. A count-bearing
 * question is the reason. Its own words name the **property** ("how many", "in total"), not the
 * **items**, so dense retrieval ranks the few statements that mention the property highly and
 * every other member of the set not at all. Raising a cut that the members are nowhere near does
 * nothing.
 *
 * The construction that reaches them is the one the leading systems use on an unchanged
 * turn-level memory: pick a small number of **anchors** by how much of the question they cover,
 * then restore each anchor's own session neighbourhood **verbatim**, without asking a model
 * anything. Chain on Demand (arXiv:2611.02480) allocates a fixed anchor budget by query
 * relevance, lexical diversity relative to the already-chosen anchors, and newly covered query
 * terms, and restores neighbourhoods deterministically. Turnbook's learned reranker is the same
 * family of move and is worth 4.8 points on a question set whose answers span sessions.
 *
 * ## What this module does not do
 *
 * No model call, no embedding, no score invented from nothing. A restored turn inherits a
 * **fraction of its anchor's measured score** and is always ranked below that anchor, so the
 * pool's head is exactly the retriever's own order. The two gates §13.254.5 wrote are structural
 * consequences rather than promises: zero added calls, and zero added prompt characters --
 * restoration changes which turns the ordering knows about, not how much room the reader gets.
 *
 * ## Why the selection key is lexicographic and not a weighted sum
 *
 * The three quantities are not commensurable: "how many question terms this turn newly covers" is
 * a count, "how similar this turn's words are to an anchor's" is a distance in `[0, 1]`, and the
 * retriever's score is a cosine fused across rankings. Adding them requires weights, and a weight
 * is a free parameter that no measurement in this campaign has priced. A lexicographic order
 * states the priorities instead: coverage first, then the retriever's own confidence, then
 * novelty, then the order the retriever returned. Every tie-break is total, so two builds of one
 * case produce one pool.
 */
import { extractLexicalKeywords } from './retrieval.js';

/**
 * How many anchors a question's pool may be organised around.
 *
 * Four, because the unit being restored is a **session neighbourhood** and the budget this
 * mechanism competes for is the prompt's, not the pool's: at `radius = 3` four anchors can restore
 * at most 24 turns against a registered pool of 256, so the addition is a rounding error in the
 * index's own cost and a bounded perturbation of the selection.
 *
 * Not an environment variable. A count that a dispatch could move would make two artifacts
 * differ by a number the configuration line could not state in a name, and this campaign's
 * comparison discipline is that a mechanism is a **name** -- `retrieval-anchored` -- whose
 * parameters are fixed where they are justified.
 */
const ANCHOR_COUNT = 4;

/**
 * How many turns on each side of an anchor are restored from its session.
 *
 * Three, which is the neighbourhood size the abstention path already reads (`contextRadius`) and
 * the smallest window that still contains a question/answer pair split across adjacent turns --
 * the shape a count-bearing question takes when the property and the item are stated in
 * consecutive turns ("I bought a bike last week." / "It cost 800.").
 *
 * The whole session is deliberately **not** restored. `expandContextWindowBySession` does that at
 * the admission layer, and §13.255.2's partition is about turns the ordering never scored: a
 * whole-session restoration would spend the pool on a session's unrelated turns, and the ordering
 * would then be choosing between neighbours of one anchor rather than between anchors.
 */
const ANCHOR_RADIUS = 3;

/**
 * What a restored turn keeps of its anchor's score, per step away from the anchor.
 *
 * ## Why a half, and what round ten did to the argument for changing it
 *
 * The first dispatch of this mechanism (`41990597116`, §13.257) put MR eight questions down and its
 * paired comparison against the previous dispatch read **5 wins to 18 losses** (`p = 0.0106`). The
 * obvious repair was a steeper decay, on the theory that a turn one step from the top anchor claims
 * half of it and therefore ranks inside the measured head.
 *
 * The artifact says otherwise, and the reason is a field this campaign had not read this way before:
 * **11 of those 18 losses arrived on prompts whose 64-bit digest is unchanged**. Identical bytes
 * cannot be a treatment effect -- they are the reader and the judge drifting, at **3.49%**, against
 * the **3.2%** measured when two dispatches were byte-identical in every field (§13.255.3). The
 * displacement theory has a second problem in the same table: the mechanism's real room cost was
 * **54 characters** out of a 46,816-character median prompt and **0.19 turns** per question. There is
 * nothing there for a decay to fix.
 *
 * So this stays a half. Lowering it would be tuning a knob against a defect that the artifact does
 * not support, which is the move §13.257.5 registers as the failure mode of the whole campaign.
 *
 * Stated as a decay rather than as a flat "just below the anchor" because the distance is real
 * information: the turn adjacent to an anchor is likelier to be the rest of the same statement than
 * the fourth one out.
 */
const ANCHOR_DECAY = 0.5;

/**
 * How deep into the retrieved list an anchor may be chosen from.
 *
 * ## Why the walk is bounded by a constant and not by the pool's own length
 *
 * The bound used to be `hits.length`, and that made `top_k` a parameter of *this mechanism* rather
 * than of the retrieval. §13.280 measured the consequence on two artifacts that differ in that one
 * number: **63 of 500 questions** delivered a different gold set, 28 losing coverage and 35 gaining
 * it, and on `MR` the moved population reads 60.0% against 80.2% for the stable one. The walk's
 * first key is question-term coverage, so a hit at rank 300 that names two question terms takes an
 * anchor slot from a hit at rank 3 that names one -- and the displaced anchor's neighbourhood is
 * what leaves the window. Widening the pool could therefore *remove* evidence.
 *
 * 256 is the registered pool width, so this constant is where `min(hits.length, 256)` lands for a
 * dispatched run, and it is what makes the pool a function of the question and the retrieval ranking
 * alone. Two widths then differ only by hits ranked below every hit of the narrower pool, and since
 * the delivered window is narrower than that pool in every archived record (largest 232 at `top_k =
 * 256`, 238 at 512) neither a hit nor a restored turn can be pushed out of it: the delivered prompt
 * becomes byte-identical across widths, which is the property `anchor-width-invariance.test.ts`
 * asserts.
 *
 * Not an environment variable, for the reason `ANCHOR_COUNT` gives: a bound a dispatch could move
 * would make two artifacts differ by a number the configuration line cannot state in a name.
 */
const ANCHOR_SCAN_TURNS = 256;

/**
 * The three parameters a caller may override, resolved to the registered values in one place.
 *
 * ## Why this is exported rather than inlined at each call site
 *
 * Two callers need the resolved numbers: the restoration itself, and the index's census, which
 * writes them into the artifact so a run says what it administered. Reading `?? ANCHOR_DECAY` in
 * both would be two definitions of one registration, and the failure mode is silent -- a dispatch
 * that moved the constant would update one of them and the artifact would then describe a decay
 * the pool was not built with. That is the defect class §13.63 and §13.27 both fixed by making a
 * parameter travel with the record instead of with the code that reads it.
 *
 * ## Why the artifact needs the numbers when the name already implies them
 *
 * `retrieval-anchored` names a **family**; the decay is a **point on its axis**, and the two
 * dispatches of this campaign sit at different points because the first one's neighbourhood
 * displaced evidence the reader needed (§13.257). A reader holding two artifacts of the same name
 * would otherwise have no way to see that, and the run that repairs the regression would be
 * indistinguishable from the run that caused it.
 */
export function resolveAnchorParameters(options: {
  readonly count?: number;
  readonly radius?: number;
  readonly decay?: number;
}): { readonly count: number; readonly radius: number; readonly decay: number } {
  return {
    count: options.count ?? ANCHOR_COUNT,
    radius: options.radius ?? ANCHOR_RADIUS,
    decay: options.decay ?? ANCHOR_DECAY,
  };
}

/** One turn the retriever surfaced, with the score it gave it. */
export type ScoredTurn = {
  readonly text: string;
  readonly score: number;
};

/** What the pool became, and enough of its provenance for an artifact to explain it. */
export type AnchoredPool = {
  /** Turn texts in descending score order, ties in the retriever's own order. */
  readonly order: readonly string[];
  /** Every scored turn, the retriever's and the restored ones. */
  readonly scores: ReadonlyMap<string, number>;
  /**
   * Positions in `order` of the turns this module chose as anchors.
   *
   * Carried so an artifact can say how many anchors a question actually produced rather than how
   * many the configuration allowed: a question whose hits all repeat the same words yields one
   * anchor, and that is a different fact from four.
   */
  readonly anchors: readonly number[];
  /** How many turns restoration added. Zero is a real, common and reported state. */
  readonly restored: number;
};

/**
 * The words a text carries, for coverage and novelty.
 *
 * The token pattern is `retrieval.ts`'s, deliberately: the keywords this module counts as
 * "covered" come from `extractLexicalKeywords`, and a second tokenisation that split hyphens or
 * kept two-letter words would make "the question named this" and "the turn contains it" two
 * different statements about the same pair of strings.
 *
 * No length filter and no stopword filter, because the only caller compares against a set that is
 * already filtered -- coverage is counted over `extractLexicalKeywords(question)`, so a turn's
 * function words cannot enter it. Novelty, by contrast, must see every token: two turns differing
 * only in "bike" and "bikes" are the same statement, while the words shared by all English prose
 * cancel out of a cosine-style overlap rather than deciding it. Filtering here would be a second
 * definition of "a word" beside the one `retrieval.ts` already owns.
 */
function tokensOf(text: string): ReadonlySet<string> {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9']*/g);
  if (tokens === null) return new Set<string>();
  return new Set(tokens);
}

/**
 * The share of the two sets' union that both hold.
 *
 * No empty-set guard, because the call site cannot produce one: `a` is the set of a candidate that
 * covered a question term the chosen anchors had not, so it holds at least one token, and the
 * denominator is therefore at least 1. A guard here would be dead code that reads as evidence the
 * invariant can break -- and the coverage gate would report it as exactly that.
 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/**
 * Choose the turns the pool should be organised around, best first.
 *
 * The first anchor is the retriever's own best hit, unconditionally. That is not a special case
 * for convenience: it makes the mechanism **monotone** against the shipped ordering -- with
 * `count = 1` and `radius = 0` the pool this module returns is the pool the retriever returned,
 * score for score -- so an ablation that moves nothing is attributable to restoration rather than
 * to a reshuffled head.
 *
 * Every later anchor must earn its place by naming something of the question the chosen anchors
 * have not yet named. A hit that only repeats words already covered is skipped **rather than
 * ranked lower**, and the walk stops when no candidate adds a term. That stopping rule is what
 * keeps the mechanism from becoming "restore four neighbourhoods whatever they are": on a question
 * whose whole pool is one statement restated, one anchor is the honest answer, and restoration
 * then spends its radius around the one turn the question actually points at.
 *
 * Returns positions into `hits`, so the caller keeps the objects it already has.
 *
 * The walk is bounded by `ANCHOR_SCAN_TURNS` rather than by `hits.length`: a bound that followed the
 * pool made the chosen anchors a function of `top_k`, which is a retrieval parameter, and made
 * widening the pool able to displace a better-ranked anchor. §13.280 measured that on two artifacts
 * and `anchor-width-invariance.test.ts` asserts the property that replaced it.
 */
function selectAnchors(
  question: string,
  hits: readonly ScoredTurn[],
  count: number = ANCHOR_COUNT,
): number[] {
  if (count <= 0 || hits.length === 0) return [];
  const questionTerms = new Set(extractLexicalKeywords([question]));
  const terms = hits.map((hit) => tokensOf(hit.text));
  // The scan bound, not the pool's length. See `ANCHOR_SCAN_TURNS`: reading `hits.length` here is
  // what let a retrieval parameter decide which anchors this mechanism chose.
  const reach = Math.min(hits.length, ANCHOR_SCAN_TURNS);
  const anchors: number[] = [0];
  const covered = new Set<string>();
  for (const term of terms[0]!) {
    if (questionTerms.has(term)) covered.add(term);
  }

  while (anchors.length < count) {
    let best = -1;
    let bestFresh = 0;
    let bestNovelty = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let position = 0; position < reach; position += 1) {
      if (anchors.includes(position)) continue;
      let fresh = 0;
      for (const term of terms[position]!) {
        if (questionTerms.has(term) && !covered.has(term)) fresh += 1;
      }
      // The stopping rule, per candidate: a hit that covers nothing new cannot be an anchor, and
      // it cannot be rescued by being novel or highly scored -- both are secondary keys.
      if (fresh === 0) continue;
      let worstOverlap = 1;
      for (const chosen of anchors) {
        const overlap = jaccard(terms[position]!, terms[chosen]!);
        if (overlap < worstOverlap) worstOverlap = overlap;
      }
      const novelty = 1 - worstOverlap;
      const score = hits[position]!.score;
      const better =
        best < 0 ||
        fresh > bestFresh ||
        (fresh === bestFresh &&
          (novelty > bestNovelty ||
            // `>` rather than `>=`, so the retriever's own order wins a complete tie. That is the
            // same tie-break `selectByRelevance` uses, and it is what makes the pool a function
            // of the ranking rather than of this loop.
            (novelty === bestNovelty && score > bestScore)));
      if (better) {
        best = position;
        bestFresh = fresh;
        bestNovelty = novelty;
        bestScore = score;
      }
    }
    if (best < 0) break;
    anchors.push(best);
    for (const term of terms[best]!) {
      if (questionTerms.has(term)) covered.add(term);
    }
  }

  return anchors;
}

/**
 * Widen `hits` with the session neighbourhoods of its anchors, verbatim.
 *
 * ## Why the neighbourhood is taken from `sessions` and not from the flat context
 *
 * A flat `context` cannot tell "the next turn" from "the first turn of the next session", and
 * crossing that boundary is not a neighbourhood: the adjacent turn of another session is a
 * different conversation. The boundary is therefore read the same way
 * `expandContextWindowBySession` reads it, from `sessions` in order, so the two layers agree about
 * where a session ends. When a case carries no boundaries the pool is returned **unchanged** --
 * not approximately, but as the same order and the same numbers -- because a caller that has no
 * boundary to offer has no neighbourhood to restore.
 *
 * ## Why the restored score is a fraction of the anchor's and not a fresh measurement
 *
 * Nothing measured these turns. Writing the anchor's own score would make a neighbour tie with the
 * statement that retrieved it; writing the floor would make the restoration pointless. A decayed
 * share is the weakest claim that still ranks: it says "this turn sits beside evidence the
 * question matched", which is exactly what the boundary tells us and nothing more. It also keeps
 * the pool's head intact -- for every adopted turn `score < anchor.score`, so no restored turn can
 * displace a hit the retriever ranked above its anchor.
 *
 * ## Why the merge re-sorts by score
 *
 * `goldRanks` reads this array as a ranking, so an order that disagreed with the scores would make
 * a delivered turn's position a fact about insertion rather than about relevance. Ties fall back to
 * the retriever's order for hits and to corpus position for restored turns, which is total.
 */
export function restoreAnchorNeighbourhoods(
  hits: readonly ScoredTurn[],
  context: readonly string[],
  sessions: readonly (readonly string[])[],
  options: {
    readonly question: string;
    readonly count?: number;
    readonly radius?: number;
    readonly decay?: number;
  },
): AnchoredPool {
  const { count, radius, decay } = resolveAnchorParameters(options);
  const anchors = hits.length === 0 ? [] : selectAnchors(options.question, hits, count);
  const untouched = (): AnchoredPool => ({
    order: hits.map((hit) => hit.text),
    scores: new Map(hits.map((hit) => [hit.text, hit.score])),
    // The selection is reported even when nothing can be restored around it. `radius = 0` -- or a
    // case that carries no boundaries -- is then read as "anchors chosen, no neighbourhood spent",
    // which is the ablation that separates the two halves of this mechanism, and a run whose
    // `anchors` total is zero is a different finding from one whose `restored` total is.
    anchors: anchors.map((anchor) => anchor),
    restored: 0,
  });
  if (anchors.length === 0 || sessions.length === 0 || radius <= 0) return untouched();

  // Position in the flat context and the boundaries it belongs to. `indexOf` on the array would be
  // a scan per anchor and would silently answer the first occurrence for a text that appears twice;
  // the map is built once and records the same first occurrence, deliberately, because a session
  // owns a position and a duplicated text does not create a second one.
  const positionOf = new Map<string, number>();
  for (let position = 0; position < context.length; position += 1) {
    const text = context[position]!;
    if (!positionOf.has(text)) positionOf.set(text, position);
  }
  const sessionOfPosition: number[] = [];
  const positionsOfSession: number[][] = [];
  let cursor = 0;
  for (const session of sessions) {
    const owned: number[] = [];
    for (let index = 0; index < session.length; index += 1) {
      sessionOfPosition[cursor] = positionsOfSession.length;
      owned.push(cursor);
      cursor += 1;
    }
    positionsOfSession.push(owned);
  }

  const scores = new Map(hits.map((hit) => [hit.text, hit.score]));
  let restored = 0;
  for (const anchor of anchors) {
    const hit = hits[anchor]!;
    const position = positionOf.get(hit.text);
    // A hit the flat context does not hold is a caller disagreeing with itself, and the honest
    // answer is to restore nothing around it: inventing a neighbourhood would need a boundary
    // that the mismatch says we cannot locate.
    if (position === undefined) continue;
    const session = sessionOfPosition[position];
    if (session === undefined) continue;
    const owned = positionsOfSession[session]!;
    const at = owned.indexOf(position);
    for (let distance = 1; distance <= radius; distance += 1) {
      const before = at - distance;
      const after = at + distance;
      if (before < 0 && after >= owned.length) break;
      const share = hit.score * Math.pow(decay, distance);
      for (const neighbour of [before, after]) {
        if (neighbour < 0 || neighbour >= owned.length) continue;
        const text = context[owned[neighbour]!]!;
        // A turn the retriever already scored keeps its measured score. Overwriting it with a
        // decayed share would be this module contradicting a measurement it did not make.
        if (scores.has(text)) continue;
        scores.set(text, share);
        restored += 1;
      }
    }
  }

  // Three keys, and the third is what makes the order total: `score` is the number the reader's
  // selection consumes, `tie` is the retriever's own position for a hit (so a measured score is
  // never re-ordered among equals), and `position` is the corpus position for a restored turn (so
  // two neighbours restored at the same decay keep the order they are read in).
  //
  // No fourth key. A text comparison used to sit here and it was dead: two entries can share a tie
  // only if both are non-hits, and every non-hit in this map was restored from a distinct corpus
  // position -- so the first two keys separate every pair the third does not, and `Array#sort` is
  // stable for the rest. Dead code in a comparator is not harmless: it invites the reader to think
  // the order can be arbitrary, which is the opposite of what this function promises.
  const hitOrder = new Map<string, number>();
  hits.forEach((hit, position) => hitOrder.set(hit.text, position));
  const order = [...scores.entries()]
    .map(([text, score]) => ({
      text,
      score,
      tie: hitOrder.get(text) ?? Number.MAX_SAFE_INTEGER,
      position: positionOf.get(text) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => b.score - a.score || a.tie - b.tie || a.position - b.position)
    .map((entry) => entry.text);

  return {
    order,
    scores,
    anchors: anchors.map((anchor) => order.indexOf(hits[anchor]!.text)),
    restored,
  };
}
