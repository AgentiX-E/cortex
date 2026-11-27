/**
 * The known-good assembly: the one thing an installer is supposed to call.
 *
 * ## The gap this closes
 *
 * `CortexMemory` had **no non-test construction** outside `bench/run-ablation.ts`, and this package ships
 * `files: ["dist"]` with a single `.` export. So an integrator received a class with thirty optional fields
 * and no worked example of which combination runs: the only assembly that was known to work lived in the
 * measurement arm, which is not in the published package. Every published reading was produced by an
 * assembly a customer could not see, which is the same asymmetry `docs/PRODUCT-CAPABILITY-LEDGER.md` names
 * for capabilities.
 *
 * ## Three profiles, and why the list is closed
 *
 * | profile | what it adds over the one before | what it is for | measured on the registered instrument |
 * | --- | --- | --- | --- |
 * | `minimal` | nothing — an identity gate and no index | the smallest conformant memory; answers from the turns it is given, in the order it is given them | **39.55%** — the `relevanceSignal=none` arm, 500 questions × 4 passes, measured at the room table `S16` replaced (unranked delivery is a truncation of the same rooms, so this number is the one row here that has not been re-read since) |
 * | `reader` | the retrieval index (lexical, plus a vector channel when an embedder is supplied) | the ranking a count-bearing or superseded-value question needs | **91.25%** at the registered room, **7,448** prompt tokens per question — the `self-index` arm, same instrument, paired against the harness's own index at −1.5 questions (p = 1.0) and against the wider room table at −1 question (p = 1.0, `S16`) |
 * | `full` | the disclosure boundary: cards, releases, and erasure over all eight surfaces | a deployment where a person says something and can later withdraw it | same ranking; the boundary is not an accuracy mechanism |
 *
 * ## Why the default is `reader` and not the cheapest profile
 *
 * It **was** `minimal`, and the sentence that defended it — "the cheapest configuration that conforms" —
 * was true and cost **51.85 points**. The two numbers in the table are one measurement of one difference:
 * the same reader, budget, corpus and judge, with a ranking and without one. The unsignalled prompt is
 * `truncateCodePointSafe(render(turns), room)` (`prompt.ts`, `chooseEvidence`'s first branch), so it keeps
 * the head of the transcript and loses the newest turn — which is the turn a knowledge-update question
 * asks about and the turn a count-bearing question's last item sits in. `answerSessions` delivered
 * 48,460 characters of conversation and the answer was cut off the end of it.
 *
 * Two numbers in that table have moved since it was written and the profile has not: the room table is
 * narrower than the one every early reading was taken at (§32 gave `temporal` back its 24,000 characters),
 * and the row now states the bill beside the accuracy because the pair is the claim. `minimal` is quoted
 * at the room table it was measured at and says so -- an unranked prompt is truncated by the same room, so
 * that row's number is not a property of the profile alone.
 *
 * A library whose selling point is a measured number cannot default to the configuration the instrument
 * priced at less than half of it. `minimal` remains, because a smoke test and a conformance check want a
 * memory that ranks nothing, but it has to be **named** — and `assemble.test.ts` holds both ends: the
 * default builds an index, and `minimal` on the same corpus still loses the same turn.
 *
 * The default is the strongest profile that needs **no** additional input. `full` is stronger and is not the
 * default because it requires a second store: a default that throws on a call naming nothing is not a
 * default.
 *
 * Three rather than a matrix because a matrix of thirty options is what the class already is. Each profile
 * is a **worked** configuration — smoke-tested end to end through `remember` → `askStored` — and a caller who
 * needs a fourth composes `CortexMemory` directly, which is what the fields are for.
 *
 * ## The room a call that names none gets
 *
 * `{@link REGISTERED_ROOMS}`: `multi-session` at 48,460 characters and the other five at 24,000, which is
 * the table `S16` measured at **91.25% / 7,448 prompt tokens per question**. A caller who states a room
 * replaces the table; a caller who states a map overrides the routes it names and keeps the rest.
 *
 * This paragraph used to argue the opposite, and the argument is worth keeping because it was sound and its
 * conclusion was inverted. "The per-route table is the registered arm's configuration, and a second default
 * would be a second arm." True — and a composition root that declines to name the first arm does not decline
 * to have one: it inherits `CortexMemory`'s global 48,000 on all six routes, which is **not** any cell the
 * campaign priced and is dearer than the one that was. The default is therefore the first arm rather than a
 * second one, and `assemble-rooms.test.ts` pins it to `tools/arm-config-baseline.json` so the two cannot
 * drift apart in either direction.
 *
 * `minimal` is the exception and it is deliberate: its number (39.55%) was measured at the wide table, and
 * it renders the transcript in arrival order rather than ranking it, so a narrower room would move the bytes
 * of a reading nobody re-took. The profile exists for conformance and for smoke tests.
 *
 * ## Why `assembleMemory` and not the `createMemory` the design sketch names
 *
 * `cortex-core` already exports `createMemory`, which builds the domain's `Memory` value. Two functions with
 * one name, one import apart, is how a reader ends up calling the wrong one and getting a type error that
 * says nothing about which. This function is named for what it does to the parts it is given.
 */
import type { EmbedFn, EmbeddingCacheStore, LLM, Storage } from '@agentix-e/cortex-core';
import { EmbeddingMemo, MemoryEmbeddingCacheStore } from '@agentix-e/cortex-core';

import { Corpus } from './corpus.js';
import { REGISTERED_ROOMS } from './rooms.js';
import { DisclosureSession } from './disclosure/session.js';
import { CortexMemory } from './memory.js';
import { REGISTERED_ARM } from './registered-arm.js';
import type { SearchIndexOptions } from './retrieval/search-index.js';
import type { SupersededRendering } from './superseded.js';
import type {
  GateOptions,
  ReplyRepair,
  ReviewPass,
  TurnCapRoute,
  WindowOrdering,
} from './types.js';
import type { EvidenceAsk, PromptContract, RelevanceUnits, TurnCutMarker } from './prompt.js';
import type { TurnWindow } from './excerpt.js';
import type { ResolutionMode } from './resolution.js';
import { readerSearchOptions, type ReaderSearchOptions } from './reader-search.js';
import type { WidthPlanOptions } from './width.js';

/** How much of the product one call wires up. See the table in the module comment. */
export type AssemblyProfile = 'minimal' | 'reader' | 'full';

export type AssembleOptions = {
  /** The text generator. Injected, because this package owns no provider and no credential. */
  readonly llm: LLM;
  /**
   * Per-route readers: the one axis that was measured as a **per-route** effect rather than a global one.
   *
   * `#readerFor` in `memory.ts` is the consumer, and it falls back to {@link llm} for a route the map does
   * not name. That fallback is why this field had to be forwarded by hand while every other field could be
   * left alone: a run that names one route is a complete run, so nothing in the composition path fails when
   * the map cannot be expressed -- the caller simply gets the fallback reader on all six routes and a
   * reading that says the per-route rule did not help.
   *
   * ## What the measurement says, in one table
   *
   * `§13.197` ran the same arm on the same 220 questions twice with `thinking` as the only difference:
   *
   * | route | effect of turning thinking on |
   * | --- | --- |
   * | `temporal` | **+4** questions, none lost |
   * | `knowledge-update` | **+2** questions |
   * | `improvisational` (`IE`) | **−16** questions |
   *
   * The mechanism is the closing line of a block: `temporal` and `multi-session` end with *"reply with the
   * Step 2 number alone"* and a reader that obeys it does better there, while `flat` has no such line and the
   * same obedience costs it sixteen. One reader for six routes cannot express that, and a per-route map is
   * the only shape that can.
   *
   * ## The asymmetry this field is the evidence for
   *
   * Requirement eleven asks the design to support different LLM providers by injection. The contract has
   * always supported it -- `LLM` is one interface and `readerByRoute` is six slots of it -- but until this
   * line existed the published composition root could not reach the slots, so the support was real at the
   * type level and absent at the only construction path a customer has. `assemble-reader-by-route.test.ts`
   * holds it end to end with two stubs and no network: each route calls the reader it names, and a route the
   * map omits calls {@link llm}.
   */
  readonly readerByRoute?: Partial<Record<TurnCapRoute, LLM>> | undefined;
  /**
   * What the evidence room buys: the unit a relevance score is spent in, and the radius of the one unit
   * that has a neighbourhood.
   *
   * These two travel together and were both unreachable from here. `relevanceUnits` is the knob that lets
   * the **multi-session** route complete a session instead of scattering it, which is the mechanism
   * `§13.26` measured as the difference between 14.3% and 66.7% across the coverage bands; `windowRadius`
   * is `'anchor-window'`'s diameter, defaulting to the reference implementation's frozen ±2 so that naming
   * the unit without naming the radius reproduces the published configuration rather than an untested
   * default.
   *
   * Both are inert without an index: a unit is what a **score** buys, and with no embedder and no signal
   * there are no scores to spend. That is why the fields were easy to leave out and are still wrong to
   * leave out -- a caller who installs an index and reads `DESIGN-SESSION-TEXT-UNIT.md` has the whole
   * mechanism in front of them and no way to name it.
   *
   * The one guard the class keeps on this pair is deliberate: `'session-text'` on a route that carries no
   * session boundary **throws** rather than falling back to the turn unit, because an artifact labelled
   * `session-text` whose numbers are turn-unit numbers is worse than a failed run. Forwarding the field
   * forwards the guard with it, and `assemble-forwarding.test.ts` asserts both halves.
   */
  readonly relevanceUnits?: RelevanceUnits | undefined;
  /** Same-session turns bought on each side of an anchor for `'anchor-window'`. Rejected, not clamped. */
  readonly windowRadius?: number | undefined;
  /**
   * The per-question evidence budget: how much of the question's relevance mass the delivered evidence must
   * explain.
   *
   * This is the one option here that exists to **spend less**, not to score more, and requirement seventeen
   * is why it cannot stay harness-only. `§14.126` priced the fixed room at 9,168 prompt tokens per question
   * with 67.3% of it in two routes at full width; at twice the gold evidence the same five hundred questions
   * bill 3,703. The mechanism is per question because a room cannot say "this question needs less".
   *
   * Absent reproduces every archived artifact: no plan, no cut, the route's room is the only bound. Naming
   * it is a cost decision a caller makes, and its registered negative form (`C6`, below 90.40% accuracy)
   * closes the family rather than promoting it, so a caller who names it is running an experiment and the
   * artifact says so through `lastWidth()`.
   */
  readonly widthPlan?: WidthPlanOptions | undefined;
  /**
   * Two injections that reorder the window the way the reference pipeline does: the date a delivered turn
   * carries, and the window the question names.
   *
   * Forwarded for the same reason as the rest: it is a **replicated competitor mechanism**, it is off unless
   * named, and until this line a customer reading its measurement could not turn it on. The two functions
   * are the caller's because this package owns no date parser and no calendar.
   */
  readonly windowOrdering?: WindowOrdering | undefined;
  /**
   * Give a decline that named nothing one question back, without offering the answer.
   *
   * `reviewPass` is forwarded already; this is the sub-case of it that decides whether a *bare* decline is
   * worth one more call. A reply of `None` names no token, so there is nothing to audit -- the question is
   * whether the reader declined because the evidence was absent or because it did not look. Off by default,
   * because a second call costs a second prompt and the mechanism has no adopted reading.
   */
  readonly reviewBareDecline?: boolean | undefined;
  /**
   * Consultations per question, reduced by majority vote.
   *
   * The one option here that trades money for stability rather than for accuracy: three consultations cost
   * three prompts and can only move a question the reader answers inconsistently. Absent means one, which is
   * every archived artifact; a non-integer or a value below one is **rejected** by the class rather than
   * clamped, and `selfConsistency > 1` with `reviewPass: 'audit'` is refused as well, because two second
   * passes on one question would make the census count outcomes that no single reader produced.
   */
  readonly selfConsistency?: number | undefined;
  /** Epoch milliseconds for every time-stamped decision. A constant pins a run; nothing here reads the clock. */
  readonly now: number;
  /**
   * Where the transcript goes — and, for `full`, the private side of the disclosure boundary as well.
   *
   * Any `Storage`: `@agentix-e/cortex-storage/sqlite` or `/pg` in Node, `/opfs` or `/idb` in a browser. The
   * corpus reads and writes nothing else, which is what makes the same assembly run on all four.
   */
  readonly storage: Storage;
  /** Defaults to `reader`, so a call that names nothing gets the configuration that has a published reading. */
  readonly profile?: AssemblyProfile | undefined;
  /**
   * Which rendering the evidence is printed in. Absent means the registered arm's
   * `evidence-blocks-unsourced` ({@link REGISTERED_ARM}).
   *
   * ## Why this field exists at the composition root, and why its default is not `abstention`
   *
   * §12.5 adopted `evidence-blocks-unsourced` and every reading from `S9` onwards was taken with it, but
   * the option that selects it lived only on `CortexMemory`. The published entry point had no field for
   * it, so the one call `assembleMemory` documents produced `abstention` — a rendering that predates the
   * adoption and that no 500-question dispatch since `S9` has used. The number was published for one arm
   * and the entry point shipped another; `registered-arm.test.ts` is the assertion that the two are now
   * the same arm.
   *
   * The default follows `maxPromptCharsByRoute`'s rule rather than the four rendering fields' rule, and
   * the difference is not a mood: those four are mechanisms with no reading of their own (absent is the
   * historical rendering), while this one *has* a reading and it is the registered one. A default that
   * named `abstention` would be a second arm, which is exactly the argument the module comment makes
   * about the room table — and the paragraph it makes it in was wrong in the same direction.
   */
  readonly promptContract?: PromptContract | undefined;
  /**
   * Which instruction block every route asks with. Absent means the registered arm's `verbatim-acts`.
   *
   * §13.291 adopted it and §13.318 made it the shipping value; the reach is `multi-session`, `flat`,
   * `temporal` and `abstention`. Until this field existed, `CortexMemory` could ask with it and
   * `assembleMemory` — the function an installer calls — could not, so the arm's largest single
   * instruction change was unreachable from the published package. Requirement ⑯'s asymmetry, one level
   * up from where it was last found.
   *
   * `undefined` is not a third value: a caller who wants the reference block names
   * `promptContract: 'abstention'`, and `registered-arm.test.ts` walks that path.
   */
  readonly ask?: EvidenceAsk | undefined;
  /**
   * The room, in characters, for **one** assembled prompt, applied to every route that has no entry of its
   * own in {@link AssembleOptions.maxPromptCharsByRoute}. Absent means the table the registration measured
   * ({@link REGISTERED_ROOMS}) applies.
   *
   * ## Why there is a default here and the paragraph that refused one
   *
   * The module comment argued that a default in this file "would be a second arm: a run that changed only
   * this constant would move every published number while claiming to have changed nothing". The argument
   * is sound and its conclusion was inverted, which is what §32.6 of the plan records: the registered table
   * is the **first** arm, so a composition root that declines to name it does not decline to have one — it
   * takes `CortexMemory`'s global 48,000 instead. A bare `assembleMemory` call therefore shipped the fourth
   * table: not 91.25% at 7,448 tokens, not any cell `S15`/`S16` priced, and dearer than the one that was
   * measured.
   *
   * Stating a number here still means what it meant: one room on all six routes. The table is applied only
   * when the caller names **no** room at all, because a caller who writes `maxPromptChars: 30_000` is
   * choosing a shape and not filling a gap.
   */
  readonly maxPromptChars?: number | undefined;
  /**
   * Per-route rooms, merged **over** the registered table rather than replacing it.
   *
   * The merge is the whole point of the field's placement. A caller who wants one route quieter writes
   * `{ temporal: 8_000 }` and means it; without the merge the other five routes would fall to the global
   * 48,000, which is the unpriced configuration the default above removes, reintroduced by the option a
   * careful caller reaches for first.
   *
   * A route named here wins over {@link AssembleOptions.maxPromptChars} as well, for the same reason it wins
   * over the table: the more specific field is the caller's answer.
   */
  readonly maxPromptCharsByRoute?: Partial<Record<TurnCapRoute, number>> | undefined;
  /**
   * How one turn is printed: its width, which routes the width reaches, whether a cut says so, which
   * slice a cut keeps, and its form.
   *
   * ## Why these five reach the composition root at all
   *
   * Because every published accuracy number was produced with them and none of them was expressible here.
   * The registered arm is `maxTurnChars: 400` on two routes, and a caller of this function could not name
   * that width, the routes it stops at, the marker that makes a cut visible, the window that spends the
   * width on the part of a turn that answers the question, or the layering that is the only remaining path
   * to the cost target. A capability that exists in `CortexMemory` and not in the one function an installer
   * calls is a capability the published package does not have -- which is the asymmetry requirement ⑯ names,
   * arriving through a composition root instead of through a component.
   *
   * ## Why the width and its reach are defaulted and the other three are not
   *
   * The width and its reach are the two halves of the one rendering a 500-question dispatch priced, so this
   * file resolves them on the room table's rule: nothing named -> the registration, either named -> exactly
   * what was named, `minimal` -> neither. The other three -- the marker, the window, the form -- are
   * departures from that rendering, each measured on its own, and a composition root that turned one on
   * without being asked would be a second arm. `undefined` therefore still means "not passed" for those
   * three, and a bare call reproduces the bytes it produced before they existed.
   *
   * ## Why the width is per-turn and not per-prompt
   *
   * `maxPromptChars` above is the room; this is one turn's share of it. They compose the way a page and a
   * column do, and the two are separately measurable -- which is why the campaign priced the room table
   * (-18.8% of the bill, -1.15 points) separately from the width plan (-27.1%, -4.00 points).
   */
  readonly maxTurnChars?: number | undefined;
  /**
   * Which routes the width reaches. Absent is the registered reach, `multi-session` and `temporal`.
   *
   * ## The one capped configuration this function could express was the rejected one
   *
   * {@link AssembleOptions.maxTurnChars} was forwarded so the width every published number was taken at
   * could be named here. The width was never the whole rendering: the registered arm is `400` on
   * `multi-session` and `temporal` and **no cap** on the other four, and `maxTurnCharsRoutes` — a field
   * `CortexMemoryOptions` has carried, and this repository's manual has documented, since §13.72 — had no
   * counterpart on this interface. A caller who set the width therefore got the class's own default for
   * the reach, which is **every** route, which is the global cap one run measured at **+13 on `MR` and
   * −30 on `IE`** and did not adopt.
   *
   * That is a narrower asymmetry than requirement ⑯ names and a worse one: not a capability a customer
   * could not reach, but the only form of it they could reach being the one a measurement rejected. A
   * caller reading this page had two ways to be wrong — name no width, and render every turn whole while
   * the published number was taken with a cut; name the width, and run the cap over `IE`, the route it
   * costs thirty questions on.
   *
   * ## Why `[]` is allowed and why it is the opt-out
   *
   * `[]` is a cap that reaches nowhere: a way to state a width without spending it, which is how a sweep
   * turns the axis off without editing the configuration it compares against. Since the reach now defaults
   * to the registration, `[]` is also how a caller asks for the pre-cap rendering -- one named field, not a
   * flag. Naming it disables the default for the width as well, because a caller who says where a cap
   * reaches has stated this decision and deriving the other half for them would be a second answer.
   */
  readonly maxTurnCharsRoutes?: readonly TurnCapRoute[] | undefined;
  /**
   * How to read a turn's role, when the caller's corpus encodes one.
   *
   * ## Why the product takes a classifier instead of knowing the format
   *
   * A role is a property of the caller's transcript, not of this package: `cortex-memory` stores text, and the
   * three corpora in the campaign spell a role three ways (`[2023/02/15 (Wed) 03:14] user: …` in the haystack,
   * `user: …` in the fixture, and nothing at all in a corpus that only ever holds one speaker). Teaching the
   * product one of those would make it wrong on the other two and would put a dataset's format inside a
   * published library's prompt path. So the caller supplies the reader, exactly as it supplies `llm`, `embed`
   * and `valueFunction` — the same boundary those three draw.
   *
   * ## What it enables, and what it costs to omit
   *
   * Supplying it enables two things and they are separate on purpose. The **census**
   * (`memory.lastRoleCensus()`) counts the roles a window carried, which is the field
   * screen `43465626013` needed and did not have: its audit could only see the filter's configuration, and
   * separating "the filter stopped working" from "the audit read the wrong set" cost a manual reconstruction
   * of four records. The **filter** ({@link AssembleOptions.evidenceRoles}) then drops the roles it does not
   * name. Omitting the classifier omits both, and the census reports `null` rather than a window of
   * unreadable turns — the two are different statements and this package keeps them apart.
   *
   * ## Why this field is the precondition rather than a convenience
   *
   * `CortexMemory` refuses `evidenceRoles` without it, because a filter with no way to read a role keeps
   * every turn while the configuration says it kept some — the inert-configuration class §10.10 recorded for
   * the retrieval gate. That refusal is forwarded, not re-implemented: a call naming roles without a
   * classifier fails here for the reason it fails when the class is built by hand, and a composition root
   * that swallowed it would be a way around a guard.
   */
  readonly roleOf?: ((turn: string) => string | undefined) | undefined;
  /**
   * Which roles the evidence may be built from. Absent is the registered filter — `['user']` — **for a caller
   * who supplied {@link AssembleOptions.roleOf}**, and no filter for a caller who did not.
   *
   * ## The rows this closes, and why they lasted
   *
   * This and {@link AssembleOptions.evidenceRolesRoutes} were the last two rows of
   * `REGISTERED_ARM_UNSHIPPED`. §13.83 registered `evidenceRoles: user` at the identity and §13.84 adopted it
   * on two routes with no capability regressed, and every reading from `S16` onwards was taken with it — while
   * the published entry point had no field for it at all. A caller who assembled the product got the arm the
   * file's own header calls "the reference rendering at the reference instruction": every assistant turn in
   * the window, which is the cell four screening runs paid to exclude.
   *
   * ## Why the default is conditional, which is the one place this differs from the width
   *
   * The width defaults unconditionally because it needs nothing from the caller. The filter needs a reader for
   * the corpus's role format, and `undefined` there is not "unfiltered by preference" — it is "the product
   * cannot see a role". So the registration applies exactly where it can be executed:
   *
   * | what the caller wrote | what they get |
   * | --- | --- |
   * | `roleOf` only | the registered filter: `['user']` on `multi-session` and `temporal` |
   * | nothing | no filter, and `lastRoleCensus()` is `null` — the run's own record of why |
   * | `evidenceRoles` named | exactly what was named, and the constructor's guard if no classifier came with it |
   * | `evidenceRolesRoutes: []` | a filter that reaches nowhere: the census runs, no turn is dropped |
   *
   * The last row is the opt-out, and it is the same spelling the width uses for the same reason — a
   * mechanism an axis can be stepped away from through the field it is configured with, rather than a boolean
   * beside it. The second row is not an oversight: a corpus whose turns carry no role has nothing to filter,
   * and inventing a reader for it here would be this package guessing at a caller's format.
   *
   * ## What does not take it
   *
   * `minimal`, for the reason it withholds the room table and the width: its 39.55% was measured on the
   * unfiltered transcript in arrival order, and a filter would move bytes under a reading nobody re-took.
   *
   * ## What it costs, and what it cannot claim
   *
   * Dropping assistant turns on two routes is a change to the evidence, not to the rendering, so it is
   * invisible in a token count that only reads the prompt: the four screening runs that priced it report the
   * accuracy, and the token saving is a by-product of less evidence reaching the same room. `'all'` is not a
   * value: a caller who wants every role names every role, and a caller who wants no filter says so with an
   * empty reach instead of a sentinel that would be a second meaning for this field.
   */
  readonly evidenceRoles?: readonly string[] | undefined;
  /**
   * Which routes the role filter reaches. Absent is the registered reach, `multi-session` and `temporal`.
   *
   * `[]` is a filter that reaches nowhere — the opt-out the default above needs, and the reason this is a
   * list rather than a boolean. Naming it alone names nothing to filter with: the reach is inert without
   * {@link AssembleOptions.evidenceRoles} to spend it on, exactly as `maxTurnCharsRoutes` is inert without a
   * width, and `CortexMemory` reads it that way rather than as an implied filter.
   *
   * Why the two routes and not six: the four the filter does not reach are the ones whose gold evidence can
   * *be* an assistant turn (`single-session-assistant` is a whole `IE` type), so a filter there would delete
   * the answer while the question asks for it. §13.72's reading is the same split for the same reason, one
   * mechanism over.
   */
  readonly evidenceRolesRoutes?: readonly TurnCapRoute[] | undefined;
  /**
   * Whether a turn the width cut says so. `'ellipsis'` marks; absent is the historical silence.
   *
   * Inert without {@link AssembleOptions.maxTurnChars}, and `CortexMemory` refuses the pairing that would
   * make it a claim about a cut that never happened.
   */
  readonly turnCutMarker?: TurnCutMarker | undefined;
  /**
   * Which slice of a turn the width keeps. Absent is `'head'`, i.e. every archived prompt's bytes.
   *
   * `'match'` needs the question, which this composition root passes at the two builders that have one; it
   * needs the width too, and is refused without it.
   */
  readonly turnWindow?: TurnWindow | undefined;
  /**
   * Whether a cut turn prints whole or by form. Absent is `'raw'`. See `resolution.ts`.
   *
   * The only remaining path to `C1` (6,000 prompt tokens against the registered 7,448): both measured cost
   * routes pay in accuracy, and the instruction block is 0.76% of a prompt, so the saving has to come from
   * printing the same events in fewer characters.
   */
  readonly resolution?: ResolutionMode | undefined;
  /**
   * The vector channel, as a batch function over texts.
   *
   * Supplying it changes two things and both are visible in the census: `reader`/`full` gain a dense channel
   * beside the lexical one, and `full` gains a vector store the erasure can reach. Omitting it is not a
   * degradation — lexical retrieval is the registered configuration's ranking signal, and the vector channel
   * has its own readings.
   */
  readonly embed?: EmbedFn | undefined;
  /**
   * Where the vectors live between assemblies. Defaults to a process-lifetime map.
   *
   * ## Why this is an option rather than an internal detail
   *
   * Because the default loses work a deployment has already paid for, and it does so silently. A page load
   * re-embeds the corpus; the corpus suite measured it at five texts and two calls per assembly, which is
   * small enough to ignore and exactly the wrong shape for a product -- the number scales with the corpus
   * and nothing in the transcript records that it was paid twice.
   *
   * `SearchIndexOptions` has taken a `store` since the memo was introduced, so a caller who builds a
   * `CortexMemory` by hand could always have done this. The gap was here: `assembleMemory` created a memory
   * map unconditionally, so the composition root -- the only construction path the published package offers --
   * could not. `@agentix-e/cortex-core`'s `StorageEmbeddingCache` is the implementation for a store that has
   * to outlive the process: it hydrates from any `Storage` and is durable at `flush()`.
   *
   * ## Why the option is refused when nothing would use it
   *
   * A store supplied to `minimal` is a store no index reads, and a store supplied without an embedder is a
   * store nothing writes. Both are configuration lines that name something the run never did, which is the
   * defect class every other guard in this package exists for -- see, in `memory.ts`, the pair that refuses
   * `turnWindow: 'match'` without a cap and `replyRepair` beside a `reviewPass`.
   */
  readonly embeddingStore?: EmbeddingCacheStore | undefined;
  /**
   * The public side of the disclosure boundary. Required by `full` and refused by the other two.
   *
   * A second store rather than a second table in the first one, because the boundary *is* the separation: a
   * card that reached the shared store is what a colleague can read, and storing both sides in one file would
   * leave the rule to a table name.
   */
  readonly shared?: Storage | undefined;
  /** Attribution label for the memory. Defaults to the class's own. */
  readonly name?: string | undefined;
  /** Gate overrides. The defaults are the identity configuration: admit everything, decline nothing early. */
  readonly gate?: Partial<GateOptions> | undefined;
  /** Retrieval knobs other than the embedder and the store, which this function owns. */
  readonly index?: Omit<SearchIndexOptions, 'embed' | 'store'> | undefined;
  /** An existing corpus, when the caller already has one — a second assembly over a live transcript. */
  readonly corpus?: Corpus | undefined;
  /**
   * What the rendering does to a turn whose value the evidence later replaces. Absent is `off`.
   *
   * On the assembly rather than on each call because it is a product decision about how a transcript is
   * shown, and a caller who has one should not have to remember to pass it to six routes. `assemble.test.ts`
   * drives both arms through `askStored`, so "the option reached the prompt" is a claim about the composed
   * product rather than about the class.
   */
  readonly supersededRendering?: SupersededRendering | undefined;
  /**
   * Insert the related-statements block: two statements of one detail, in evidence order, before the question.
   *
   * ## Why this field exists even though the registered value is `false`
   *
   * The mechanism has a **measured reach** and **no live reading**. `docs/MEASURE-CONFLICT-SURFACING.md`
   * counted, on run `42355323615`'s own windows, that the block fires on four of the seven `KU` questions
   * that fail in all four repetitions — a ceiling of four questions on that capability — and the shipped arm
   * still carries `conflicts: false`, because an adoption needs a paired dispatch and none has been made.
   *
   * That is exactly the configuration in which a missing field is invisible: the dispatch that would produce
   * the reading builds `CortexMemory` directly, so the harness can name the option whether or not the
   * composition root can, and the first person to discover the gap would be a customer who read the
   * measurement and could not reproduce the arm. This is the fifth field to arrive under requirement ⑯'s
   * asymmetry — after `ask`, `promptContract`, `supersededRendering` and `evidenceRoles` — and the pattern is
   * the argument for forwarding every mechanism rather than the ones with an adopted default.
   *
   * ## Why the default stays off
   *
   * Because it has no reading. Forwarding a mechanism is not adopting one: `undefined` reaches
   * `CortexMemory` as the historical bytes, so a bare call still assembles the arm every archived artifact
   * records, and only a caller who names this field pays the block's characters.
   *
   * ## The reach, asserted through this function
   *
   * `assemble-conflict-reach.test.ts` drives `flat`, `knowledge-update`, `temporal` and `assistant` through
   * the assembled memory and requires the block; `abstention` and `multi-session` must stay byte-identical,
   * for the two reasons `memory.ts#withConflicts` states (a decline is `ABS`'s gold, and a flattened block
   * would undo the session boundaries that builder exists for).
   */
  readonly conflicts?: boolean | undefined;
  /**
   * Label every rendered session boundary with the date its turns state.
   *
   * Off unless named. The mechanism, its reading and its cost are documented on `Types.sessionClock`; the
   * only thing this field adds is reachability from the public entry, which is the half of requirement ⑯
   * that a component test cannot cover.
   */
  readonly sessionClock?: boolean | undefined;
  /**
   * The second consultation `answerSessions` runs, if any. Absent is the historical silence.
   *
   * ## Why this field was the last one and not the first
   *
   * The module comment says a caller who needs a fourth **profile** composes `CortexMemory` directly, and
   * that sentence was read as covering the options as well. It does not: it says a matrix of thirty options
   * is what the class already is, which is an argument against *profiles*, not against reachability. The
   * four fields above it were added under requirement ⑯'s asymmetry — "a capability that exists in
   * `CortexMemory` and not in the one function an installer calls is a capability the published package does
   * not have" — and the same sentence applies here unchanged, because `reviewPass` has five measured values,
   * one of which is the shipped arm's `recover`, and a customer who wanted `tally` had to rebuild the whole
   * composition and could drift from the registration while doing it.
   *
   * ## Why `undefined` and not `'none'`
   *
   * `CortexMemory` reads `undefined` and `'none'` the same way, so both work; `undefined` is what the
   * artifact prints for an absent field, and forwarding is what keeps a bare call's bytes equal to the bytes
   * every archived artifact recorded.
   *
   * The `replyRepair` / `reviewPass` pair stays refused. Both fields reach the constructor, so the guard in
   * `memory.ts` fires on a call that names both — forwarding must not be able to produce a configuration the
   * class refuses to build by hand.
   */
  readonly reviewPass?: ReviewPass | undefined;
  /**
   * What the memory does with a reply that broke the contract. Absent is the historical silence (`off`).
   *
   * Same argument as {@link AssembleOptions.reviewPass}, and the same guard: the two second-consultation
   * mechanisms are refused together by the constructor rather than ranked here.
   */
  readonly replyRepair?: ReplyRepair | undefined;
  /**
   * Whether a prompt may carry a fact the record later replaced, alongside the one that replaced it.
   *
   * Forwarded with {@link AssembleOptions.factTimeline}, not separately: the interval that field appends
   * describes a fact only this switch puts in the prompt, so `factTimeline` on its own renders nothing. A pair
   * where one half is reachable and the other is not is the asymmetry this file keeps recording, one field
   * deeper -- and it would have shipped as a configuration line naming a treatment the run never administered.
   */
  readonly semanticCarry?: boolean | undefined;
  /**
   * Whether a value the record later replaced is printed with both of the instants its supersession
   * authorised. Absent is off, and inert without {@link AssembleOptions.semanticCarry}.
   *
   * The mechanism dates each value from the record's own two instants rather than from the question's clock,
   * which is why it is a `boolean` and not a mode: there is nothing to choose between.
   */
  readonly factTimeline?: boolean | undefined;
  /**
   * The second look on the multi-session route: one query written after the first pass has ranked.
   *
   * Forwarded rather than defaulted, for the reason every field above is: `undefined` is the historical
   * silence -- the prompt every published number was produced under -- and a composition root that turns a
   * mechanism on is a second arm with no control. `Types.readerSearch` carries the mechanism, its bill and
   * the counters it writes; `docs/DESIGN-READER-SECOND-LOOK.md` §7 records where the shipped stage differs
   * from the design and why the call site is the product's rather than an arm's.
   *
   * It is here because of requirement ⑯'s asymmetry one field further out: a capability the arm can dispatch
   * and the published composition root cannot reach is a capability a customer does not have, and this
   * repository has shipped that shape twice (`readerByRoute`, and the three options above this one).
   */
  readonly readerSearch?: ReaderSearchOptions | undefined;
};

/** What a profile wires up, as the objects themselves rather than as a bag of booleans. */
export type Installation = {
  readonly profile: AssemblyProfile;
  /** The memory. `remember` and `askStored` are reachable here, and so is every route the contract declares. */
  readonly memory: CortexMemory;
  /** The transcript. Reachable because a caller may want to read or count it without asking a question. */
  readonly corpus: Corpus;
  /**
   * The disclosure boundary, on `full` only.
   *
   * Present rather than hidden behind a method because erasure is an act with its own preconditions — a
   * token, a reason, a warning that names what will be destroyed — and wrapping it would either hide those
   * or restate them. A caller that has it can `cards()`, `release()`, `forget()`; a caller that does not
   * asked for a profile without a boundary.
   */
  readonly disclosure: DisclosureSession | undefined;
};

/**
 * Wire up the product.
 *
 * The identity gate — `threshold: 0`, `retrievalThreshold: 0`, unbounded session budget — is what every
 * profile starts from, and it is the configuration most of this repository's readings were taken under:
 * admission keeps everything and declines nothing on its own, so a difference between two runs is a
 * difference in the mechanisms above it rather than in a gate nobody named.
 */
export function assembleMemory(options: AssembleOptions): Installation {
  const profile = options.profile ?? 'reader';
  const gate: GateOptions = {
    threshold: 0,
    retrievalThreshold: 0,
    sessionBudget: Number.POSITIVE_INFINITY,
    ...options.gate,
  };
  const corpus = options.corpus ?? new Corpus({ store: options.storage, now: options.now });

  // One store for the vectors, resolved here rather than inside the index, because two objects have to share
  // it: the index memoises every text it embeds, and the erasure has to reach the same entries. A store
  // created per question would make an erasure able to name a key nobody wrote.
  //
  // A store the caller supplied is kept, not replaced -- the same correction `memory.ts` records for
  // `index.store`, one level up: the caller's durable store used to be dropped at this exact line, and the
  // vectors it was meant to hold were written into a map that died with the process.
  const embed = options.embed;
  const supplied = options.embeddingStore;
  if (supplied !== undefined && embed === undefined) {
    throw new Error(
      'embeddingStore needs options.embed: a vector store is written by the index the embedder creates, so ' +
        'a store without an embedder is a cache nothing fills. Supply the embedder, or drop the store.',
    );
  }
  if (supplied !== undefined && profile === 'minimal') {
    throw new Error(
      "embeddingStore is not reachable on profile: 'minimal': that profile builds no index, so nothing " +
        'would read the vectors. Use reader (retrieval without the boundary) or full, or drop the store.',
    );
  }
  const vectors = embed === undefined ? undefined : (supplied ?? new MemoryEmbeddingCacheStore());

  const index =
    profile === 'minimal'
      ? undefined
      : {
          ...options.index,
          // The width, resolved here for the reason the two instruction levers are resolved below: a
          // composition root that declines to name an arm does not decline to have one. `SearchIndex`'s own
          // default is 64, which is a module default and not an arm -- the reading this file's header reports
          // for `reader` (91.25% at 7,448 prompt tokens) was taken at `REGISTERED_ARM.relevanceTopK`.
          //
          // The gap this closes is `registered-arm.ts`'s own defect class, one field over from the two that
          // file fixed: `relevanceTopK` was a constant with no reader, so a bare call built an index that
          // scored a quarter of the turns the published number was measured over. At 64 the turns past the
          // sixtieth position receive the unscored floor and the selection degrades to arrival order, which is
          // invisible in the prompt and was invisible in the artifact until `SearchCensus.k` existed.
          k: options.index?.k ?? REGISTERED_ARM.relevanceTopK,
          ...(embed === undefined || vectors === undefined ? {} : { embed, store: vectors }),
        };

  const disclosure = profile === 'full' ? boundary(options, corpus, embed, vectors) : undefined;

  // The room the six routes are assembled under. Three cases, and each one is a shape rather than a gap:
  //
  //   - nothing named            -> the registered table, i.e. the arm that was measured;
  //   - one number named         -> that number on every route (no table: the caller stated a shape);
  //   - a map named              -> the map over the table, so one route can move without five following.
  //
  // The `minimal` profile takes none of it. It builds no index and renders the transcript in arrival order,
  // so its prompt is a truncation of the same text -- but its number was measured at the wide table (39.55%
  // at 48,000), and handing it a table that changes its bytes would restate that reading under a
  // configuration nobody ran. `assemble.test.ts` holds the arithmetic; this comment holds the reason the
  // branch exists rather than a default that reaches all three profiles.
  const rooms =
    options.maxPromptCharsByRoute !== undefined
      ? {
          ...(options.maxPromptChars === undefined ? REGISTERED_ROOMS : {}),
          ...options.maxPromptCharsByRoute,
        }
      : options.maxPromptChars === undefined && profile !== 'minimal'
        ? REGISTERED_ROOMS
        : undefined;

  // The two instruction levers, resolved here on the room table's rule and for the room table's reason.
  //
  // The table's paragraph says a composition root that declines to name an arm does not decline to have
  // one — it takes the class's default. That default is `prompt.ts`'s `abstention`, which is the
  // pre-§12.5 rendering, reachable from no 500-question dispatch since `S9`. So a bare call assembled the
  // reference arm while the artifact it published named `evidence-blocks-unsourced` at
  // `verbatim-acts`, and nothing held both claims at once.
  //
  // Three cases, the room table's three: nothing named -> the registered arm; one named -> that one (the
  // more specific field is the caller's answer); `minimal` -> neither, because that profile renders the
  // transcript in arrival order and its 39.55% was measured at `abstention`. Handing it §12.5's rendering
  // would move bytes under a reading nobody re-took, which is the same reason it withholds the table.
  const instruction =
    profile === 'minimal'
      ? undefined
      : {
          promptContract: options.promptContract ?? REGISTERED_ARM.promptContract,
          ask: options.ask ?? REGISTERED_ARM.ask,
        };

  // The width and its reach, resolved on the room table's rule and with the room table's reason.
  //
  // The table's paragraph above applies unchanged: a composition root that declines to name an arm does not
  // decline to have one, and the one it was taking was `CortexMemory`'s -- no cap, which renders every turn
  // whole and is not a cell any 500-question dispatch priced. Measured: the registered rendering spends the
  // same room on fewer, longer turns and reads **7,242 prompt tokens per question against 7,448** for the
  // uncapped one, so the unmeasured cell was also the dearer one.
  //
  // Three cases, the room table's three: nothing named -> the registration (`400` on `multi-session` and
  // `temporal`); either field named -> exactly what was named, because a caller who writes a width is
  // choosing a shape rather than filling a gap and deriving a reach for them would be a second answer to
  // one question; `minimal` -> neither, for the reason it withholds the room table and the instruction.
  //
  // The opt-out is `maxTurnCharsRoutes: []`, which is the documented "a cap that reaches nowhere" -- the
  // reason the reach is a list rather than a boolean is that disabling an axis must not require deleting a
  // field from the type.
  const cap =
    profile === 'minimal'
      ? undefined
      : options.maxTurnChars === undefined && options.maxTurnCharsRoutes === undefined
        ? {
            maxTurnChars: REGISTERED_ARM.maxTurnChars,
            maxTurnCharsRoutes: REGISTERED_ARM.maxTurnCharsRoutes,
          }
        : {
            ...(options.maxTurnChars === undefined ? {} : { maxTurnChars: options.maxTurnChars }),
            ...(options.maxTurnCharsRoutes === undefined
              ? {}
              : { maxTurnCharsRoutes: options.maxTurnCharsRoutes }),
          };

  // The role filter and its reach, on the room table's rule with one difference that is the whole point: the
  // registration applies **where it can be executed**, and nowhere else.
  //
  // The width above can default unconditionally because it needs nothing from the caller. This needs a reader
  // for the corpus's role format, and that reader is the caller's -- so `undefined` is not a preference here,
  // it is the product's inability to see a role at all. Four cases, and the first is the one that closes the
  // last two rows of `REGISTERED_ARM_UNSHIPPED`:
  //
  //   - `roleOf` given, neither field named -> the registration: `['user']` on `multi-session` and `temporal`;
  //   - either field named                    -> exactly what was named (the constructor refuses roles
  //                                              without a classifier, and that refusal is forwarded);
  //   - no classifier, nothing named          -> no filter, and `lastRoleCensus()` reports `null` so the run
  //                                              records which of the two reasons applied;
  //   - `minimal`                             -> neither, for the reason it withholds the room table.
  //
  // The opt-out is `evidenceRolesRoutes: []`, the same spelling the width uses: a filter that reaches nowhere
  // runs the census and drops no evidence, which is what a caller who wants to *watch* roles needs and what
  // §10.10's audit was reconstructed by hand to obtain.
  const roles =
    profile === 'minimal'
      ? undefined
      : options.evidenceRoles === undefined && options.evidenceRolesRoutes === undefined
        ? options.roleOf === undefined
          ? undefined
          : {
              evidenceRoles: REGISTERED_ARM.evidenceRoles,
              evidenceRolesRoutes: REGISTERED_ARM.evidenceRolesRoutes,
            }
        : {
            ...(options.evidenceRoles === undefined
              ? {}
              : { evidenceRoles: options.evidenceRoles }),
            ...(options.evidenceRolesRoutes === undefined
              ? {}
              : { evidenceRolesRoutes: options.evidenceRolesRoutes }),
          };

  // The rendering, resolved on the room table's rule and **bound to the width above**.
  //
  // The three form ceilings are ratios of `maxTurnChars`, so a call that resolves no width has nothing to
  // take a ratio of: writing `layered` beside an absent cap would be a name for a treatment with no scale,
  // and the class refuses exactly that pairing (`CortexMemory`'s third guard). So the resolution is decided
  // by the width the call actually assembles with, not by the width the caller happened to type.
  //
  // Three cases, the room table's three, with one addition the table does not need: a caller who names a
  // rendering gets that rendering on every profile including `minimal`, because stating a value is not the
  // same act as accepting a default, and `minimal` withholds defaults rather than overruling callers. It
  // withholds this one for the reason it withholds the table: its 39.55% was measured at the reference
  // rendering, so a default that moved its bytes would move a reading nobody re-took.
  //
  // ## Why a named window withdraws the default, which is the fourth term
  //
  // `turnWindow: 'match'` and `resolution: 'layered'` are two answers to one question -- which characters
  // of a long turn survive a cap -- and the class refuses them together for the reason it refuses two
  // second consultations. A default that did not step aside would therefore turn a legal call
  // (`{maxTurnChars, turnWindow: 'match'}`, measured as `C6`) into a throw at construction. The default is
  // the arm nobody named; a caller who named a window named a rendering, and `registered-arm.test.ts` is
  // where "these two cannot collide by default" is a test rather than an argument.
  const resolution =
    options.resolution !== undefined
      ? options.resolution
      : profile === 'minimal' || cap?.maxTurnChars === undefined || options.turnWindow === 'match'
        ? undefined
        : REGISTERED_ARM.resolution;

  const memory = new CortexMemory({
    llm: options.llm,
    ...(options.readerByRoute === undefined ? {} : { readerByRoute: options.readerByRoute }),
    ...(options.relevanceUnits === undefined ? {} : { relevanceUnits: options.relevanceUnits }),
    ...(options.windowRadius === undefined ? {} : { windowRadius: options.windowRadius }),
    ...(options.widthPlan === undefined ? {} : { widthPlan: options.widthPlan }),
    ...(options.windowOrdering === undefined ? {} : { windowOrdering: options.windowOrdering }),
    ...(options.reviewBareDecline === undefined
      ? {}
      : { reviewBareDecline: options.reviewBareDecline }),
    ...(options.selfConsistency === undefined ? {} : { selfConsistency: options.selfConsistency }),
    now: options.now,
    gate,
    corpus,
    ...(index === undefined ? {} : { index }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(instruction === undefined ? {} : instruction),
    ...(options.maxPromptChars === undefined ? {} : { maxPromptChars: options.maxPromptChars }),
    ...(rooms === undefined ? {} : { maxPromptCharsByRoute: rooms }),
    ...(options.supersededRendering === undefined
      ? {}
      : { supersededRendering: options.supersededRendering }),
    // Forwarded, not defaulted, for the reason on the field: the registered value is `false` and the
    // mechanism has no live reading, so this line changes no shipped byte and makes the arm a dispatch
    // prices reproducible by a customer.
    ...(options.conflicts === undefined ? {} : { conflicts: options.conflicts }),
    // Forwarded rather than defaulted: `CortexMemory` reads `undefined` as off, and this file must not be
    // the place a mechanism turns itself on. The forwarding is what `turn-clock.test.ts` walks end to
    // end -- a flag that stops at this object is a documented feature a customer cannot reach.
    ...(options.sessionClock === undefined ? {} : { sessionClock: options.sessionClock }),
    // The five rendering fields, resolved above: the width and its reach from the registration, the other
    // three forwarded as named. `undefined` for a field the caller did not name is the historical rendering
    // for those three, and a mechanism this file must not turn on by itself.
    ...(cap === undefined ? {} : cap),
    // The classifier is forwarded even when the filter is not, because the two things it enables are separate:
    // a caller who passes only `roleOf` gets the census on every profile, including `minimal`, and gets the
    // registered filter wherever the profile can run one.
    ...(options.roleOf === undefined ? {} : { roleOf: options.roleOf }),
    ...(roles === undefined ? {} : roles),
    ...(options.turnCutMarker === undefined ? {} : { turnCutMarker: options.turnCutMarker }),
    ...(options.turnWindow === undefined ? {} : { turnWindow: options.turnWindow }),
    ...(resolution === undefined ? {} : { resolution }),
    // The three options requirement ⑯ had not reached. Forwarded, not defaulted, for the reason stated on
    // each field: `undefined` is the historical silence, and a composition root that defaults a mechanism on
    // is a second arm. `replyRepair` and `reviewPass` are forwarded separately rather than as a pair so the
    // constructor's mutual exclusion keeps firing -- a call naming both has to fail here exactly as it fails
    // when the class is built by hand, otherwise this file would be a way around a guard.
    ...(options.reviewPass === undefined ? {} : { reviewPass: options.reviewPass }),
    ...(options.replyRepair === undefined ? {} : { replyRepair: options.replyRepair }),
    // The pair, because either alone is a field that cannot act: `factTimeline` dates facts `semanticCarry`
    // serves, so `factTimeline` without it renders nothing -- which is what `memory.ts` states and what
    // `assemble-options.test.ts` asserts rather than assumes.
    ...(options.semanticCarry === undefined ? {} : { semanticCarry: options.semanticCarry }),
    ...(options.factTimeline === undefined ? {} : { factTimeline: options.factTimeline }),
    // Forwarded, not defaulted, for the reason recorded on the field: a composition root that turns the
    // second look on would be a second arm, and the registered configuration is the absence of this key.
    ...(options.readerSearch === undefined
      ? {}
      : { readerSearch: readerSearchOptions(options.readerSearch) }),
  });

  return { profile, memory, corpus, disclosure };
}

/**
 * The `full` profile's boundary.
 *
 * Split out because it is the only branch in this file with a precondition, and a precondition buried in a
 * ternary is one a reader discovers by running.
 */
function boundary(
  options: AssembleOptions,
  corpus: Corpus,
  embed: EmbedFn | undefined,
  vectors: EmbeddingCacheStore | undefined,
): DisclosureSession {
  const shared = options.shared;
  if (shared === undefined) {
    throw new Error(
      'profile: full needs options.shared: the disclosure boundary is the separation between what a person ' +
        'said privately and what a colleague may read, so it is constructed over two stores. Supplying one ' +
        'and using it for both sides would leave the rule to a table name. Pass a second Storage, or use ' +
        'profile: reader for retrieval without the boundary.',
    );
  }
  const store = vectors;
  return new DisclosureSession({
    private: options.storage,
    shared,
    now: () => options.now,
    // The same entries the index writes: one store, and a memo whose only job here is to compute the keys the
    // index already used. `embedding-cache.ts` records why an eraser must be the owner of the key function.
    ...(embed === undefined || store === undefined
      ? {}
      : { vectors: new EmbeddingMemo(embed, { store }) }),
    // The eighth surface. Without it `forget()` empties five tables and a cache and leaves the same sentence
    // in the transcript, which is the defect class this repository has already shipped once.
    turns: corpus,
  });
}
