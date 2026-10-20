/**
 * Public types for `cortex-memory`.
 *
 * The composition layer's job is to make `cortex-core`'s value gates
 * *reachable*. Before this package existed, `decideWrite`, `decideRetrieval`,
 * `consolidate` and `resolveContradiction` had zero production callers — they
 * were covered by their own unit tests and imported by the barrel, and nothing
 * else. See `docs/AUDIT-CODE-VS-DOCS.md` §6.
 */
import type { LLM, ValueFunction } from '@agentix-e/cortex-core';
import type { EvidenceAsk, PromptContract, RelevanceUnits } from './prompt.js';

/** The knobs the admission gates expose. */
export type GateOptions = {
  /**
   * Admitted when `decideWrite` values the memory at **or above** this. `0`
   * admits everything and `1` admits nothing, because the default value
   * function is bounded by `confidence * sourceTrust * (0.5 + 0.5 * recency)`
   * and `recency < 1` strictly. Both extremes are asserted in the tests: a gate
   * that only ever opens and a gate that only ever closes are equally
   * indistinguishable from a gate that is not wired.
   */
  threshold: number;
  /**
   * Answered when `decideRetrieval` values the best candidate at or above this.
   *
   * A separate field from {@link threshold} because the two decisions answer
   * different questions and a run may legitimately want opposite settings:
   *
   *   `threshold`          -- is this turn worth *keeping*?
   *   `retrievalThreshold` -- is the kept evidence good enough to *answer from*?
   *
   * Collapsing them was a real defect, found by dispatch `37094200823`. The arm
   * ran with `threshold: 0` (keep everything -- the identity configuration), and
   * with one shared field that also meant "answer from anything", so the
   * abstention path had no gate and every abstention in the run was the model's
   * wording rather than the layer's decision. The measured result was 6.40%
   * against the reference pipeline's 85.20%, with a 95.40% abstention rate --
   * the shape of a system that declines everything.
   *
   * Unlike {@link threshold}, `0` here means "answer whenever anything was
   * admitted", which is the identity configuration for this gate.
   */
  retrievalThreshold: number;
  /**
   * Upper bound on how many admitted turns may reach the prompt, counted across
   * all presented sessions. Bounding is the point — see
   * `selectSessionBudget` for why a session is admitted whole or not at all.
   */
  sessionBudget: number;
  /** Replaces `cortex-core`'s `defaultValueFunction` when supplied. */
  valueFunction?: ValueFunction;
  /**
   * Source trust stamped on every memory admission constructs. In `[0, 1]`.
   *
   * Defaults to `0.5`, which is what `createMemory` establishes and what this
   * layer passed unconditionally until the ceiling was measured. It is a field
   * rather than a constant because the value function is bounded by
   * `confidence * sourceTrust * (0.5 + 0.5 * recency)`, and with `sourceTrust`
   * fixed the layer could not express a fully-trusted memory at all: the ceiling
   * was `0.5`, so `threshold > 0.5` admitted nothing and the gate was a two-state
   * switch. Dispatch `37110579101` is what made it visible -- a retrieval
   * threshold of `0` could not close a gate whose maximum observable value was
   * `0.5`, which is why the repaired program scored what the unrepaired one did.
   *
   * The field does not change the default, and that is deliberate rather than
   * incidental: a caller that sets nothing gets exactly the previous behaviour, so
   * every measurement taken before this field existed keeps its meaning. What
   * grows is the reachable set, not the shipped configuration. See
   * `docs/DESIGN-CORTEX-MEMORY.md` §6.4.
   */
  sourceTrust?: number;
  /**
   * Per-turn confidence for admission, as a function of the turn's content.
   *
   * Raises the ceiling without providing variation, and the two are separate
   * repairs in a specific order. §49 measured the second one failing on its own:
   * with `sourceTrust: 1` every admitted turn carries exactly `1`, so the
   * reachable range is the set `[0, 1]` and yet every cut inside it is still
   * all-or-nothing. The gate was reachable and useless.
   *
   * The reason is that this layer pinned all three value-function factors for
   * every turn -- `confidence` left at `createMemory`'s default, `sourceTrust` one
   * value per admission by construction, `recency` exactly `exp(0)` because
   * `lastAccessedAt === createdAt` -- so there was no per-turn difference to
   * threshold. `confidence` is the only factor with room, and this field is it.
   *
   * Supplied as a callback rather than a `number[]` so it is evaluated against the
   * turn it is deciding: a parallel array could disagree with the input order
   * without any type noticing, and admission is the last place that can notice.
   *
   * The signal itself is the caller's to own. A real quality estimate is lexical
   * overlap, retrieval rank, or an embedding score, and **none of them live in
   * this package** -- `cortex-memory` depends on `cortex-core` only and reads no
   * embedding model, so measuring turn quality here would make the composition
   * layer depend on a retrieval mechanism it is supposed to sit above. The layer
   * owns the mechanism; whoever has a measurement injects one. That is the same
   * boundary `valueFunction` and `CortexMemoryOptions.llm` already use.
   *
   * Defaults to absent, which leaves `confidence` at `createMemory`'s `1` and
   * therefore reproduces the pre-existing constant behaviour exactly. See
   * `docs/DESIGN-CORTEX-MEMORY.md` §6.5.
   */
  confidenceFor?: (turn: string) => number;
};

/**
 * The routes a prompt is built for, and therefore the routes a per-turn cap can be aimed at.
 *
 * ## Why a list and a derived union rather than a union alone
 *
 * The reach is dispatched as a comma-separated list of names and validated against the arm's own
 * copy of them (`cortex-eval` cannot import this package -- the dependency runs the other way), so
 * the names have to exist **at runtime** here as well. Deriving the union from the list means the
 * six names are declared once and a seventh cannot be added to one form without the other, which
 * is the failure `test_ask_table_parity.py` was written for after `enumerated` was added to a
 * union and to no table.
 */
export const TURN_CAP_ROUTES = [
  'multi-session',
  'temporal',
  'flat',
  'knowledge-update',
  'abstention',
  'assistant',
] as const;

/** One of the six paths `CortexMemory` builds a prompt for. */
export type TurnCapRoute = (typeof TURN_CAP_ROUTES)[number];

/** Construction options for {@link CortexMemory}. */
export type CortexMemoryOptions = {
  /**
   * The text generator. Injected rather than constructed, so this package
   * depends on `cortex-core`'s `LLM` contract and not on any provider. The
   * benchmark arm that supplies a real provider does so in step 3; nothing here
   * owns an API key or a network call.
   */
  llm: LLM;
  /**
   * Epoch milliseconds used for every time-stamped decision. Injected because
   * admission value depends on age, and a test that cannot pin the clock cannot
   * assert on a value.
   */
  now: number;
  /** Which gate configuration to apply. */
  gate: GateOptions;
  /** Report attribution label; defaults to `cortex-memory`. */
  name?: string;
  /** Upper bound on prompt length in UTF-16 code units. */
  maxPromptChars?: number;
  /**
   * Upper bound on the characters one turn may contribute to the prompt. Absent means none.
   *
   * ## The measurement it answers
   *
   * §13.34.3 argued the evidence room is not the constraint from **counts** -- a median of
   * 26 turns in the window against a median gold set of 24 -- and `--turns` on the adopted
   * run's artifact shows the other half of that room's arithmetic: the delivered turns have
   * a **median of 272 characters** with a p90 of 2,305, so 26 of them are 7,072 characters
   * in a 24,000-character room. The room is spent on a tail rather than on turns, which is
   * why the cut that decides coverage falls at rank 26 while the pool holds 64 (§13.66: the
   * pool carries 73.2% of the gold, the delivery 54.2%).
   *
   * ## Why it sits beside `maxPromptChars` and not on the gate
   *
   * It is a **prompt assembly** input: it decides how much of a turn is *shown*, among turns
   * the gate has already kept. A cap on admission would move the gate, which is a different
   * experiment, and a cap on `lastRetrievedContext` would make the artifact describe a
   * prompt the model never read. Forwarded through `#promptOptions` to every route, because
   * the renderer the cap lives in is the renderer every route uses.
   *
   * The cost, stated at the point where the trade is made rather than discovered: a turn
   * whose decisive fact sits deep inside a long narrative loses it.
   */
  maxTurnChars?: number | undefined;
  /**
   * Which routes the per-turn cap reaches. Absent means all of them.
   *
   * ## Why reach is a separate field rather than a second value of `maxTurnChars`
   *
   * §13.72 measured the 400-character cap over every route and found **+13 on MR and −30 on IE**
   * in the same run: MR's declines halved as their coverage rose (21% → 54%), while IE's thirty
   * lost questions went `correct → abstention` at a median coverage of **100%** — complete
   * evidence, and the model withdrew forty-two times instead of fifteen. A single switch cannot
   * express both, and the difference is not a matter of degree: no smaller cap turns a complete
   * window into a partial one on a question that needs one turn.
   *
   * So the width stays where §13.67 registered it and the **reach** moves, which is the pattern
   * `renderingRoutes` (§12.9) and the ask's own route table (§13) already use — an explicit list,
   * recorded in the artifact, with the untouched routes byte-identical to their control.
   *
   * ## Why absent means all
   *
   * Because that is what §13.68 shipped and what run `39180819474` measured: an absent list must
   * reproduce the previous behaviour exactly, or the run that rejected the global cap could not be
   * compared against the one that tests the narrowed form. An empty list is the other end — a cap
   * configured to reach nothing — and it is a legitimate way to disable the option without
   * removing it.
   */
  maxTurnCharsRoutes?: readonly TurnCapRoute[] | undefined;
  /**
   * Which turns the prompt budget is spent on, as a score over the question and
   * the turn. Absent leaves the budget character-clipped exactly as before.
   *
   * ## Why it sits here and not on `GateOptions`
   *
   * It is a **prompt assembly** input, so it belongs beside `maxPromptChars`, which
   * is the budget it competes for. `GateOptions` decides what is *kept* and what may
   * be *answered from*; this decides what is *shown* among the turns already kept,
   * and it has no effect at all unless the budget binds. Putting it on the gate
   * would suggest it can change an admission decision, which it cannot and must
   * not — a signal that moved admissions would make the next run's delta
   * uninterpretable, two variables having moved at once.
   *
   * ## Why it is injected rather than computed here
   *
   * A relevance score is a retrieval measurement, and this package reads no
   * embedding model: the same boundary `confidenceFor` and `llm` already draw. On
   * the arm the signal comes from `cortex-eval`'s own retrieval, so the ranking the
   * reference pipeline uses and the ranking the feature selects with are one
   * ranking rather than two.
   *
   * ## What it is for, measured
   *
   * Run `38114272884` spent every evidence room on a prefix of the arrival order,
   * which on this arm is the dataset's haystack order because nothing here ranks
   * anything. The gold turn sat inside that prefix for 12.4% of questions while the
   * median gold session sat at 22% of the haystack. A budget is not usefully small
   * or large; it is usefully **spent on the right turns**.
   *
   * Reaches every route, including the multi-session one, through `#promptOptions`.
   * See `PromptOptions.relevanceFor` for the selection and presentation rules.
   */
  relevanceFor?: (question: string, turn: string) => number;
  /**
   * The unit the evidence room is spent in. Absent means `'turn'`.
   *
   * ## Why it is a separate knob from `relevanceFor`
   *
   * The signal says how a turn is scored; this says what a score buys. They are
   * different decisions and the experiment requires them to move independently, which
   * is why §13.27 holds the signal at `retrieval` and moves only this. A unit folded
   * into the signal's name would make a run that changed only the unit
   * indistinguishable, in its own configuration line, from one that changed the
   * scoring.
   *
   * ## Where it reaches, which is one route
   *
   * The **multi-session** route only. `buildPrompt` is handed no session boundary, so
   * a selection in sessions cannot be expressed on flat, temporal, knowledge-update,
   * abstention or assistant, and the option is inert there -- not by a guard but
   * because those plans carry no `sessionOf`. That is what makes §13.27 a
   * single-variable dispatch: MR moves and no other capability can.
   *
   * `§13.26` measured why MR needs it: accuracy runs 14.3%, 33.3%, 41.5%, 66.7% across
   * the first four bands of `goldOverlap` coverage, while MR's carried count has a
   * median of 14 against a median `total` of 24. A turn-unit budget scatters a session
   * across the window; the reference pipeline completes it and scores 86.78% on MR.
   */
  relevanceUnits?: RelevanceUnits;
  /**
   * Overrides the contract the **abstention route** uses, without touching the others.
   *
   * Exists for §12.5's registered experiment. §12.4 measured that the feature side
   * repaired no question at all (`b✗f✓ = 0`) while its abstentions were the model's
   * (`reason: "llm"`), and §12.3 measured that no `retrievalThreshold` can carry the arm.
   * The surviving hypothesis is therefore about what is *presented* to the model, and
   * this field is the single variable that changes it.
   *
   * Named for the route rather than for the contract so that a caller cannot accidentally
   * rewrite the extractive or temporal routes: those are separate arms' subjects and a
   * rendering change there would be a second uncontrolled variable in a run whose whole
   * value is that it has one. The route's own contract is what decides whether this
   * applies, and a value that is not a known contract is rejected rather than defaulted
   * -- a silently-ignored override would publish an artifact claiming a rendering the run
   * never used, which is the §7.3 side-channel defect.
   *
   * Defaults to absent, so every prior artifact keeps its meaning.
   */
  promptContract?: PromptContract;
  /**
   * Which instruction block every route asks with. §13's single variable.
   *
   * A separate field from `promptContract` because they are separate axes: a contract
   * selects a *rendering*, an ask selects an *instruction block*, and §13.2 requires
   * them to be movable independently. Reusing `promptContract` for both would repeat
   * the §12.9 error from the other side -- one name carrying two variables.
   *
   * Absent means each route uses its own block, which is the shipped behaviour and what
   * every prior artifact was produced with.
   */
  ask?: EvidenceAsk;
  /**
   * The kinds of turn the evidence may be built from. Absent means every turn.
   *
   * ## The measurement this answers
   *
   * §13.82 read the 48,000-character run and measured the **composition** of the room rather
   * than its size: on the multi-session route **51.9% of the rendered characters are assistant
   * turns**, on temporal 50.1%, and on the three uncapped routes 75.8-77.3%. The reference
   * pipeline, which reaches 85.95% on multi-session with a 24,000-character budget, restricts
   * retrieval to user turns and states the reason in its own source: *"the facts live in the
   * user's statements; assistant turns are verbose generated chatter that dilutes the answer
   * signal"*. This arm reaches 68.60% with 48,000 and reads everything.
   *
   * ## Why the product takes a classifier instead of parsing roles itself
   *
   * `[date] role:` is one dataset's format, not a property of a turn. A parser here would make
   * the product's behaviour a fact about that dataset and would leave the next one silently
   * unfiltered -- the §10.10 class, a recorded configuration that never reaches the decision it
   * names. So the product owns the **filter** and the caller owns the **format**, through
   * {@link CortexMemoryOptions.roleOf}.
   *
   * ## `undefined` from the classifier is not an excluded role
   *
   * A turn whose role cannot be read is **kept**. Dropping it would turn a classifier bug into
   * an empty prompt, which reads as a dataset with no evidence rather than as the defect it is.
   *
   * ## An empty list is refused rather than honoured
   *
   * It would admit nothing on every reached route, which is a decline every time; §13.80's
   * lesson is that a value which cannot work is rejected at the boundary instead of producing a
   * run whose reading looks like a measurement. Naming no roles at all (absent) is how a run
   * expresses "no filter".
   */
  evidenceRoles?: readonly string[] | undefined;
  /**
   * Which routes {@link CortexMemoryOptions.evidenceRoles} reaches. Absent means all of them.
   *
   * ## Why the reach exists before the filter has been measured
   *
   * Two reasons, and the second is the one that decides it. First, §13.73's pattern: a filter
   * that reaches every route moves three capabilities the experiment is not asking about, and
   * 75.8-77.3% of *their* rendered characters are assistant turns -- a global filter is not a
   * neutral change for them. Second, the reach is the experiment's own internal control: the
   * untouched routes must reproduce their control's window **to the turn**, which is a check no
   * number in the treated routes can supply.
   *
   * Absent means every route, so a run that names no reach reproduces the shipped behaviour, and
   * an empty list reaches nothing -- a legitimate way to disable the filter without removing the
   * classifier.
   */
  evidenceRolesRoutes?: readonly TurnCapRoute[] | undefined;
  /**
   * How to read a turn's role. Required whenever {@link CortexMemoryOptions.evidenceRoles} is
   * named, and refused at construction otherwise.
   *
   * A filter without a classifier is an inert configuration: the artifact would record
   * `evidenceRoles: ["user"]` while the run kept every turn, which is exactly the shape §10.10
   * recorded for the retrieval gate and §13.69 for a stale dispatch value. Throwing at
   * construction makes that state unrepresentable rather than invisible.
   */
  roleOf?: (turn: string) => string | undefined;
  /**
   * A second consultation that audits the first pass's list, on the multi-session route only.
   *
   * ## What it is for, and why membership rather than arithmetic
   *
   * §13.93's sweep made the reader walk **all forty-four sessions** of a window -- median 44 session
   * lines, every record scanning, none skipped -- and the median count of item-bearing lines stayed
   * at **two**. Record `0a995998` shows the shape: the question asks about items to *pick up or
   * return from a store*, the window holds a blazer at the dry cleaner and two mentions of boots at
   * Zara, and the response lists the two boots mentions, merges them into one item and answers `1`.
   * The evidence was carried and read; what the reader got wrong is **which items enter the list**.
   *
   * So this pass is not a re-ask and not a retry of an abstention -- those have their own measured
   * histories and this option deliberately leaves both alone. It shows the model the same evidence
   * and its own first response, and asks for three membership decisions: items missing, entries that
   * merge two events, and entries the evidence does not support.
   *
   * ## Why `none` is a value and not only an absent field
   *
   * It doubles the consultations on the route it reaches, and every archived artifact was produced
   * without it. A run that wants to state the absence in its configuration can, which is why the
   * artifact prints `none` for an absent field rather than omitting the concept.
   *
   * ## Why the reach is implicit
   *
   * The pass lives in `answerSessions`, so it reaches the multi-session route by construction and no
   * other route can be configured into it. §13.92's experiment is why this is stated rather than
   * left to a reach option: that ask's reach moved three routes at once, and the run could not
   * separate the treatment from the cost.
   */
  reviewPass?: ReviewPass;
};

/**
 * Which second consultation a run performs, if any.
 *
 * `audit` is the only implemented pass, and it is named rather than boolean so a second pass with a
 * different question can be added without a flag whose meaning depends on the build.
 */
export type ReviewPass = 'none' | 'audit';
