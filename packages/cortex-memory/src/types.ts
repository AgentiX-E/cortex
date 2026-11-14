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
import type { EvidenceAsk, PromptContract, RelevanceUnits, TurnCutMarker } from './prompt.js';
import type { SearchIndexOptions } from './retrieval/search-index.js';
import type { WidthPlanOptions } from './width.js';
import type { TurnWindow } from './excerpt.js';

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

/**
 * The roles the window a question was shown actually contained.
 *
 * ## What question this answers that a boolean could not
 *
 * Screening run `43465626013` failed its own audit with
 * `FAIL roles evidenceRoles=['user'] on ['multi-session','temporal']; 4 window(s) carry an assistant
 * turn`. Settling it took a manual reconstruction of four records, because the artifact recorded the
 * filter's **configuration** and nothing about its **effect**. This is the effect.
 *
 * `counts` is keyed by whatever strings the classifier returns, so a census cannot run out of buckets
 * when a dataset introduces a role this package has never heard of. The arithmetic is closed:
 * `sum(counts) + unclassified === total`, and `total` is the length of the same window
 * {@link CortexMemory.lastRetrievedContext} reports — so the artifact can check the two against each
 * other rather than infer one from the other.
 *
 * ## Why `unclassified` is a bucket of its own and not a role named `unknown`
 *
 * The filter's contract says a turn whose role cannot be read is **kept** — dropping it would turn a
 * classifier bug into an empty prompt, which reads as a dataset with no evidence. So
 * `unclassified > 0` is the escape hatch working and `assistant > 0` under `evidenceRoles: ['user']`
 * is the filter not working. A single field could not tell those apart, and telling them apart is the
 * whole reason the audit's line was ambiguous.
 *
 * The name matters: a classifier is free to return the string `"unknown"` as a role — the vocabulary
 * belongs to the caller — and a field named `unknown` would then mean two things at once. `counts`
 * holds whatever the classifier says; `unclassified` holds the turns it said **nothing** about.
 */
export type RoleCensus = {
  /** Delivered turns per role the classifier named. */
  readonly counts: Readonly<Record<string, number>>;
  /** Delivered turns the classifier returned `undefined` for. */
  readonly unclassified: number;
  /** Delivered turns in the window. Always `sum(counts) + unclassified`. */
  readonly total: number;
};

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
   * Per-route readers, for the one axis that was measured as a per-route effect.
   *
   * §13.197 ran the same arm on the same 220 questions twice with `thinking` as the only difference: `TR` gained four
   * questions with none lost and `KU` gained two, while `IE` lost sixteen. The mechanism is the block's closing line —
   * `temporal` and `multi-session` demand the number alone, and `flat` does not — so a reader that obeys the line is
   * better on the first two routes and worse on the third. One reader for six routes cannot express that; this map can.
   *
   * A route absent from the map uses {@link llm}, so a run that names one route does not have to name the other five,
   * and a run that supplies no map is **exactly** the behaviour every archived artifact was produced under.
   */
  readerByRoute?: Partial<Record<TurnCapRoute, LLM>>;
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
   * The same bound, per route, for the routes a run names. Absent means every route uses
   * {@link maxPromptChars} and the prompt is byte-identical to the one that option alone produces.
   *
   * ## The defect this exists for: a character room is not a depth
   *
   * A budget of characters is converted into a number of turns by each route's own turn length, and
   * the quantity that decides how much of the answer's evidence arrives is the **count**, not the
   * characters. Measured on `41546569106` (500 questions, `maxPromptChars` 48,000, adopted
   * configuration), the one room becomes five different depths:
   *
   * | route | chars per delivered turn | delivered turns | in-pool gold delivered |
   * | --- | ---: | ---: | ---: |
   * | `flat` | 723 | 61 | 93.6% |
   * | `knowledge-update` | 717 | 62 | 92.0% |
   * | `abstention` | 596 | 72 | 84.2% |
   * | `multi-session` | 215 | 174 | 90.6% |
   * | `temporal` | 205 | 179 | 85.6% |
   *
   * The coverage column is computed from the artifact's own `goldOverlap.goldRanks` -- for each
   * question, the share of in-pool gold turns whose rank is inside the depth actually delivered --
   * so it costs nothing to recompute and it is a property of the selection rather than of the reader.
   * Two consequences follow, and both are arithmetic:
   *
   * 1. **The routes with short turns are not short of room and are short of depth.** `multi-session`
   *    reads 174 turns for 46,264 characters while `flat` reads 61 for 46,864 -- the same room, a
   *    2.9x difference in how much of the ranking is paid for. Raising `multi-session` to full
   *    coverage costs 56,000 characters, because its turns are 215; doing the same for `flat` would
   *    cost 188,000.
   * 2. **The last third of every room buys the last tenth of the coverage.** From the same curve,
   *    `multi-session` reaches 79.0% coverage at depth 60 (12,900 characters) and 90.6% at 174;
   *    `flat` reaches 78.2% at depth 30 (21,700 characters) and 93.6% at 61.
   *
   * ## Why the reconciliation is per route rather than per question
   *
   * Because the depth a question needs is not observable before it is answered. The quantity that
   * *is* observable is the route, and the accuracy of a route tracks its coverage unevenly enough to
   * make the distinction worth acting on: on the same artifact, `multi-session` answers **84.0%** of
   * the questions whose in-pool gold was fully delivered against **65.2%** of those where it was not
   * (75 and 46 questions, 2.3 standard errors), while `flat` answers 94.8% and 97.3% on the same
   * split (77 and 73) -- i.e. its accuracy does not track its coverage at all.
   *
   * So the increment this option enables is a **redistribution at constant spend**: deepen the route
   * whose accuracy responds to depth, at the expense of the route whose does not. A run that uses it
   * to raise the total is running a different experiment, and one that uses it to lower the total is
   * running §13's retired budget sweep again -- which is why the arm records the map in the artifact
   * and the registration states the mean prompt length as a constraint rather than as an outcome.
   *
   * ## Why absence is the identity
   *
   * Every archived artifact was produced under one global room, and the campaign's readings are
   * comparisons against them. A missing route therefore falls back to {@link maxPromptChars} rather
   * than to a default of its own, so a run that names two routes leaves the other four byte-identical
   * and its delta is attributable to the two it named.
   */
  maxPromptCharsByRoute?: Partial<Record<TurnCapRoute, number>> | undefined;
  /**
   * How much evidence one question is worth, when the arm wants to stop paying for a fixed room.
   *
   * ## The measurement
   *
   * §13.302 answered "one room per route", which left the bill at **9,168** prompt tokens per question with
   * **67.3%** of it the two load-bearing routes at their full 48,460 characters (`cost.json`,
   * `cap.rooms`). §14.126 registers `C6` on the arithmetic that says where the money went: at **2x the gold
   * evidence** the same five hundred questions would bill **3,703** -- so 59.6% of the bill is not evidence,
   * it is the assumption that every question needs the same width.
   *
   * ## What this option is not
   *
   * Not a smaller room. `maxPromptChars` is one number per route and can only express "every question on
   * this route gets this much"; the mechanism here is per question, and it reads the question's own
   * relevance mass to decide. Nor is it a second selector: the funded prefix is what `chooseEvidence` would
   * have chosen first anyway, so the cut removes the **tail** rather than reordering the head.
   *
   * ## The risk, stated where it is chosen
   *
   * Relevance mass is not gold recall -- `a4996e51` is the recorded case of a decisive operand sitting in a
   * turn that shares no term with the question. So this mechanism can cut evidence that mattered, and its
   * registered negative form is `03` §14.126.2 clause 5: below 90.40% accuracy on 200 questions x 2
   * repetitions the family closes. Absent means the route's room is the only bound, which reproduces every
   * archived artifact.
   */
  widthPlan?: WidthPlanOptions | undefined;
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
   * Whether a turn the cap cut says so. Absent means it does not, which is every archived run.
   *
   * ## The defect it answers, named by its turn
   *
   * §13.187 read all five durable MR declines against the stored `featurePromptTexts` and found
   * their evidence genuinely absent -- except `a4996e51`, whose decisive turn was **delivered
   * and then cut mid-sentence** at `maxTurnChars`: the prompt reads `…I increase my work hours`,
   * and the next turn of the same conversation asks how to phrase those hours. Every contract in
   * `prompt.ts` tells the reader to decline when an operand is missing, so declining was the
   * correct behaviour on a prompt that had lost the operand without saying so. The artifact's
   * coverage count still reports the turn as delivered, which is true and does not help.
   *
   * ## Why absent is the default and not the treatment
   *
   * Every capped run ever dispatched was rendered without a marker, and `prompt-turn-cap.test.ts`
   * protects those bytes. A default of `'ellipsis'` would make each of them incomparable with the
   * same configuration re-run today, which is the one thing the campaign's artifacts are for --
   * so the marker is a dispatched value, exactly like the cap's width and its reach.
   *
   * ## Where it can act
   *
   * Only on a turn the cap actually cut: without a cap there is no cut, and a turn shorter than
   * the cap renders byte-identically. Forwarded through `#promptOptions` beside the cap so no
   * route can receive the marker without the cap that gives it meaning.
   */
  turnCutMarker?: TurnCutMarker | undefined;
  /**
   * Which slice of a long turn the cap keeps. Absent is `'head'`, which is every archived prompt.
   *
   * ## What it is for, and what it is not
   *
   * `maxTurnChars` caps how much of a turn a prompt carries; this decides **which** characters, and the two
   * are one decision's halves. The head is the part that happens to be first, and on this arm a ninth of the
   * delivered blocks reach the cap -- so a ninth of what the reader sees is a turn that stops, chosen by
   * position rather than by the question. `'match'` spends the same characters on the window around the
   * question's densest match and marks every elision it makes.
   *
   * It is **not** a cost lever. The cap's width does not move, so the bill does not move: `C6` (the width
   * plan) removed turns and was priced at a point per 6.8% of the bill, and this deliberately does not
   * touch that axis.
   *
   * ## Why absent is not `'match'`
   *
   * The same reason `turnCutMarker`'s default is `'none'`: every artifact in the archive was produced by the
   * head cut, and a default that moved would make each of them unreproducible from the code. A run says
   * which window it used, and the configuration line records it.
   */
  turnWindow?: TurnWindow | undefined;
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
   * ## Why it is injected, and what changed about that
   *
   * A relevance score is a retrieval measurement, and this package reads no
   * embedding model: the same boundary `confidenceFor` and `llm` already draw.
   *
   * That sentence used to be the whole answer, and it was not enough. It left the product unable to rank at
   * all unless the caller had already ranked -- so with no callback the budget was spent in arrival order
   * (`chooseEvidence` → `truncateCodePointSafe`), and "retrieval" was something the harness did and this
   * package consumed. `index` below is the repair: the product builds the index, fuses the channels and
   * composes the reranker itself, with the model injected the same way `llm` is. `relevanceFor` survives as
   * the **override** -- the arm passes `cortex-eval`'s index through it so a measured run and a shipped run
   * cannot drift apart -- and it wins when both are supplied, because a run that names a signal must be the
   * run that used it.
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
   * The product's own retrieval: an index built over the turns of the current question.
   *
   * Absent means the previous behaviour byte for byte -- `relevanceFor` when supplied, arrival order when
   * not -- which is what keeps this a single-variable dispatch rather than a silent change to every run
   * already on record. Present means `CortexMemory` scores the turns itself: postings over `contentTerms`,
   * an optional vector channel through `embed`, rank fusion (RRF) across the channels, and an optional
   * cross-encoder pass through `rerank`.
   *
   * ## Why the model is inside `index` and not inside this package
   *
   * `EmbedFn` is injected for the reason `LLM` is: the class composes a mechanism, and a mechanism that
   * constructs its own client cannot be run without a key, a network and a bill. An index with no `embed` is
   * a lexical index and a working one, so the product answers questions with no model at all -- which is
   * the property `relevance.ts` calls "I/O-free and model-free" and which the product had until now only by
   * refusing to retrieve.
   *
   * ## The cost, and the half of it that is gone
   *
   * The corpus arrives per question (`answerSessions(question, sessions)`), so the index is built per
   * question. That is the protocol's shape, not an oversight: a system that indexes a haystack once would
   * need an `ingest`, which this contract does not have.
   *
   * The **vectors** used to be rebuilt per question too, which on LongMemEval-S meant roughly five hundred
   * embedded texts per question for a corpus the instance had already been handed. They no longer are:
   * `CortexMemory` owns one `EmbeddingCacheStore` for its lifetime and passes it in as `SearchIndexOptions.store`,
   * so the second question over an unchanged corpus embeds its query and nothing else. `SearchCensus` reports
   * `embedTexts`, `memoHits` and `reuse`, because a batch count cannot tell five hundred texts from one.
   *
   * What is still per question is the postings list, the fusion and the reranker -- CPU rather than model
   * calls, and `SearchIndex.add` refuses to extend a primed index because a vector table computed over two
   * turns does not cover a third. A caller with a stable corpus can still hold one `SearchIndex` itself.
   */
  index?: SearchIndexOptions | undefined;

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
   * How many same-session turns on each side of an anchor `'anchor-window'` buys.
   *
   * Defaults to `2`, which is the reference implementation's frozen value
   * (`cod/expand.py`, `expand window ±2`), so naming the unit without naming a radius
   * reproduces the published configuration rather than an untested default.
   *
   * A property of **one** unit and inert on the other three, which is asserted rather
   * than assumed: see `anchor-window.test.ts`, "the radius is inert on the units it does
   * not belong to". A global radius applied to `'session'` would spend the room twice
   * and a silently ignored one would let an artifact report a window it never used.
   *
   * Rejected rather than clamped when it is not a non-negative integer: a fractional or
   * negative radius names no neighbourhood, and a clamp would make a dispatched
   * configuration describe a window the run did not use -- the §7.3 side-channel defect.
   */
  windowRadius?: number;
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
   * Whether the prompt names the statements that state the same detail twice.
   *
   * ## The failure it is aimed at
   *
   * Five of the seven `KU` questions that fail in all four repetitions of run `42355323615` answer
   * with a value the corpus **later replaced**, and the later statement is in the delivered window
   * every time: `ce6d2d27` says "class on Thursday" at turn 4 and "class on Fridays" at turn 29 and
   * answers `Thursday`; `59524333` says "usually 7:00 pm" in February and "usually at 6:00 pm" in May
   * and answers `7:00 pm`. The instruction block already says which of the two to prefer
   * (`knowledge-update` carries the "latest date" rule), so the reader has the rule and both
   * statements and still answers with the earlier one — the comparison is one it has to **find**
   * inside 23,084 characters before it can perform.
   *
   * With this on, `cortex-memory/src/conflict.ts` picks the turns whose best sentence shares terms
   * with the question, keeps the earliest and the latest of them plus the most relevant, and prints
   * them between the evidence and the question with their dates and one conditional line. It does
   * not decide which value is current, because the direction is in the question: `0977f2af` asks for
   * the gadget bought **before** the Air Fryer, i.e. the earlier of two values.
   *
   * ## Cost and reach
   *
   * About 1.2k characters on a 48k prompt (six statements at most, each at most 180 characters), and
   * the delivered evidence is untouched — the block is inserted after the budget decided the carried
   * set, so a run with this on carries exactly what its control carried. The reach is the five routes
   * that assemble through `#answerWithBareRetry`; the multi-session route renders session blocks and
   * is excluded, as `#withConflicts` records.
   *
   * Absent means off, and an off run's prompts are byte-identical to the ones before this option
   * existed.
   */
  conflicts?: boolean;
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

  /**
   * Give a decline that named nothing one question back, without offering the abstention token.
   *
   * ## The measurement
   *
   * `MEASURE-SOTA-FAILURES.md` §2: of 45 wrong declines on the shipped arm, **30 are a bare
   * `INSUFFICIENT_EVIDENCE`** with nothing around it. The ask already calls that shape invalid and it was produced
   * 21 times on the two routes that never retry, so the sentence is advice — the parser accepts the shape and
   * nothing happens. Meanwhile `ABS`, the only capability whose gold is a decline, reads 30/30 with **29 of its 30
   * answers being that same token**: the shape is optimal exactly where it is graded.
   *
   * ## Reach, and why it is two routes rather than three
   *
   * `flat` and `temporal`, which carry the 21 first-attempt bare declines. `multi-session` already runs
   * `reviewPass: 'recover'`; adding a second retry there would make any movement two variables. The abstention
   * route is excluded outright — a bare decline there is the correct answer and this option would spend a call to
   * turn a right answer into a wrong one.
   *
   * Default `false`, which is the shipped behaviour and the setting every archived artifact was produced under.
   */
  reviewBareDecline?: boolean;
  /**
   * Repair a reply that broke the contract it was rendered with, once, and without changing the evidence.
   *
   * ## The measurement that asked for it
   *
   * `MEASURE-ORACLE-CEILING.md` §7.4 reads all 35 questions the arm loses with the gold sessions in the window and
   * classifies fourteen of them as contract violations: eight refusals in prose and six lists of quotations. Both
   * populations are invisible to the two retries the product already carries -- the bare retry needs the token and
   * nothing else, and the recovery pass is told `answered: true` because `parseAnswer` reads "Not specified in the
   * evidence" as an answer. So those questions are re-asked by nothing, and the bare retry reported `72/72`
   * converted in the same run.
   *
   * The hand classification gave the kinds' sizes but not their denominators, and `tools/reply-shape-census.mjs`
   * measured both over three artifacts (§13.334): the refusals are 3 to 5 per run and every one is a loss, while
   * the lists of quotations are 42 to 47 per run and only 7 to 13 are losses. That is why `commitment` is the kind
   * dispatched and `shape` is registered and refused.
   *
   * ## Why the licence is that a refusal can never be right here
   *
   * `abstention` is the only capability whose gold is a decline, and it reads 30/30 with 29 of its 30 answers
   * being the bare token -- so the repair is excluded on that route at the call site, and on every route it does
   * reach a refusal is wrong by construction. That is what licenses a prompt that says a refusal is not
   * acceptable (`buildCommitPrompt`) instead of one that merely points at the evidence again.
   *
   * ## Cost
   *
   * At most one extra consultation per question, only on questions that already answered in a broken shape, and
   * the retry carries `AssembledPrompt.carried` -- the exact text the first call read -- so it can never be the
   * longer prompt `§13.147` removed from the bare retry.
   *
   * Default absent, which is the shipped behaviour and the setting every archived artifact was produced under.
   */
  replyRepair?: ReplyRepair;
  /**
   * How many times the multi-session route consults the model on one prompt, and whether the
   * answers are reduced by majority. `1` (the default) is the shipped behaviour.
   *
   * ## Why this exists
   *
   * §13.100.2 measured two runs of one configuration against each other: **24 of 121**
   * multi-session answers differ, 59 of 500 states differ dataset-wide, and the evidence layer
   * reproduces to the character. The reader's judgement is what moves. Three consultations and
   * a strict majority spend that movement instead of trying to suppress it, which is the one
   * mechanism in this campaign whose target is a measured property of the instrument rather
   * than a hypothesis about the arm.
   *
   * ## Why it is here and not in the prompt
   *
   * The prompt is byte-identical across the samples -- that is the whole design. A prompt
   * change would be the fourth attempt of a kind that has failed three times (§13.93, §13.94,
   * §13.96), and it would confound the sample count with the wording.
   *
   * ## Why `1` rather than an absent field means "off"
   *
   * `1` is a count, and the product already reads the option as a count. An absent field also
   * means one, so every archived run keeps its meaning. The arm refuses any other value at its
   * own boundary, which is where a dispatch value is validated.
   *
   * ## The refusal of two multi-pass mechanisms at once
   *
   * Combining this with `reviewPass: 'audit'` would consult the model six times per question,
   * and nothing has measured what the two passes do to each other. The constructor refuses the
   * combination rather than letting a dispatch produce a configuration whose reading nobody can
   * attribute -- the same rule `evidenceRoles` follows when it is named without a classifier.
   */
  selfConsistency?: number;
  /**
   * The reference pipeline's time-window reorder, as two injections.
   *
   * `windowOf` resolves the window a question names against the date it was asked, and `dateOf`
   * reads the date a delivered turn carries. The product owns neither: a product that parsed
   * `[2023/02/15 (Wed) 01:41]` would make the product's behaviour a fact about one dataset's
   * rendering, which is the argument `roleOfTurn` and `relevanceFor` already settle.
   *
   * ## What the product does with them
   *
   * A **stable partition of the delivered set** -- the turns the window admits first, both blocks in
   * their original order. That is `temp_query_search_pruning.py`'s `ranked_items_new = left + right`
   * without its inference call, and it is a permutation by construction, so the mechanism can be
   * registered as an increment of its own (§13.151.5, §13.153): the delivered multiset is invariant
   * and the only thing a reading can attribute movement to is order.
   *
   * ## Why it is applied after the budget and not before
   *
   * Before the budget, a promotion changes which turns survive the cut -- the delivered set moves and
   * the mechanism is no longer a reordering. `buildPrompt` therefore promotes `carried`, the set the
   * budget already bought, and never `turns`.
   *
   * ## Why an absent window is not an error
   *
   * Most questions name no period at all. `windowOf` returning `undefined` is the ordinary case and
   * leaves the prompt byte-identical to a run without this option, which is what keeps "the mechanism
   * fired and moved nothing" distinguishable from "the mechanism was administered".
   */
  windowOrdering?: WindowOrdering;
};

/**
 * The two readers {@link CortexMemoryOptions.windowOrdering} needs.
 *
 * Both are pure and synchronous, and both are supplied by the caller because both are facts about a
 * corpus: `dateOf` reads whatever stamp a turn's rendering carries, and `windowOf` turns a qualifier
 * plus the question's own date into an inclusive `YYYY/MM/DD` range.
 */
export type WindowOrdering = {
  /**
   * The date a delivered turn carries, or `undefined` when it carries none.
   *
   * `undefined` is the ordinary answer for a turn this corpus renders without a prefix, and it must
   * stay an answer rather than becoming a `'1970/01/01'`: a defaulted date would put every undated
   * turn inside every window that spans the epoch, which is the direction that silently promotes.
   */
  readonly dateOf: (content: string) => string | undefined;
  /**
   * The window the question names, or `undefined` when it names none.
   *
   * `questionDate` is `undefined` on the routes that are not given one, and a resolver must answer
   * `undefined` there rather than substituting a clock: a qualifier resolves against the date the
   * question was asked and nothing else.
   */
  readonly windowOf: (
    question: string,
    questionDate: string | undefined,
  ) => { readonly start: string; readonly end: string } | undefined;
};

/**
 * Which second consultation a run performs, if any.
 *
 * Named rather than boolean for the reason it was always named: a second pass with a different
 * question is a different value, not a different build. `recover` is the second one.
 *
 * - `none` — one consultation, which is the state every archived run is in.
 * - `audit` — after an answer, re-ask over the evidence, restricted to membership.
 * - `recover` — after a **decline that contradicts its own Step 1 list**, ask once with the list
 *   quoted and no evidence re-sent (`abstention-recovery.ts`).
 * - `tally` — after an answer to a **count-or-total question**, ask for the same list with every line
 *   tagged by what it contributes, and answer with the sum of the tags (`tally.ts`). The audit pass
 *   already reviews membership and is instructed *not* to adjust a total, because run `42054107910`
 *   measured 22 correct answers destroyed by that request; this value is the arithmetic the audit
 *   refuses to do, computed outside the model instead of asked of it again.
 *
 * The passes are mutually exclusive on purpose. `audit` consults every answered question, `recover`
 * consults only a decline, and `tally` consults a count-or-total question that was answered, so a run
 * that could do two would be two treatments behind one value and could not say which move. Making
 * them values of one field says that in the artifact.
 *
 * `spec` is the fourth and it is not a variant of `tally`: the tally pass asks the reader for a
 * numbered list and sums it, while `spec` asks for a *plan* -- a scope, a conjunction of field filters
 * and an operation -- and runs it over a ledger the programme compiled before the question arrived.
 * The two differ in what the model is asked to produce (prose items versus a typed object), in when
 * the ledger exists (after the question versus before it), and in what a failure leaves behind (a
 * wrong list versus a plan whose filters and supporting steps can be printed.)
 *
 * - `supersede` — after an answer on the **knowledge-update route**, ask which later statement
 *   supersedes the value the answer rests on, and substitute only when the proposed span is copied
 *   character for character out of the evidence **and** the date it claims sits on the same evidence
 *   record (`supersede.ts`). This is the only value whose target is a failure the prompt already
 *   forbids: the `knowledge-update` contract states the latest-consistent-value rule on every one of the
 *   seven questions that fail in all four repetitions of `42355323615`, and it fails 24 times out of 24
 *   (`MEASURE-FAILURE-STABILITY.md` §3). A rule that is present and fails every time is a comparison the
 *   reader is being asked to perform over 23,084 characters, so this pass asks for the comparison alone
 *   and gives the decision to a function.
 *
 * The three mechanisms that *substitute* an answer -- `tally`, `spec`, `supersede` -- are the three that
 * had to be given an authorization gate, and the order in which they were built is the order in which
 * the campaign learned it: `tally` had none and lost 9.5 questions; `spec` had none and lost 39, 43 of
 * its 46 flips damages (`MEASURE-PLAN-SHAPE.md`); `supersede` was written with one.
 */
export type ReviewPass = 'none' | 'audit' | 'recover' | 'tally' | 'spec' | 'supersede';

/**
 * Which reply-contract repairs a run administers, if any.
 *
 * A union rather than two booleans because the two kinds are disjoint populations and a run has to be able to
 * administer one of them: `commitment` alone prices the refusal repair, `shape` alone prices the answer-shape
 * repair, and `both` is the arm that asks what two deterministic repairs together recover. `off` is a value
 * rather than an absent field so a control arm can state that it ran the control, which is the reading
 * §13.187.6D gives `queryExpansion`.
 *
 * The reach is decided by the reply rather than by the route: `reply-repair.ts` reads the first reply and returns
 * at most one plan, and a reply that is the bare token belongs to `reviewBareDecline` instead -- so a run with
 * both treatments on still consults at most once more per question.
 *
 * ## `shape` is a value and is not dispatched, and the numbers are why
 *
 * `tools/reply-shape-census.mjs` counts both columns over three archived artifacts: 42 to 47 replies per run are
 * lists of quotations, and only **7 to 13 of them are wrong** -- the other 35 to 38 are correct answers that happen
 * to be lists, because a preference question legitimately answers with a recommendation set. `commitment` plans
 * **3 to 5** and every one of them is wrong. So the shape repair would consult nine times as many questions to
 * reach a third as many, and two thirds of what it re-asked would be answers that were already right. The value
 * exists so the mechanism can be measured rather than argued about, and §13.334 records the refusal.
 */
export type ReplyRepair = 'off' | 'commitment' | 'echo' | 'shape' | 'both';
