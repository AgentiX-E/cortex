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
import type { GateOptions, ReplyRepair, ReviewPass, TurnCapRoute } from './types.js';
import type { EvidenceAsk, PromptContract, TurnCutMarker } from './prompt.js';
import type { TurnWindow } from './excerpt.js';
import type { ResolutionMode } from './resolution.js';

/** How much of the product one call wires up. See the table in the module comment. */
export type AssemblyProfile = 'minimal' | 'reader' | 'full';

export type AssembleOptions = {
  /** The text generator. Injected, because this package owns no provider and no credential. */
  readonly llm: LLM;
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
   * How one turn is printed: its width, whether a cut says so, which slice a cut keeps, and its form.
   *
   * ## Why these four reach the composition root at all
   *
   * Because every published accuracy number was produced with them and none of them was expressible here.
   * The registered arm is `maxTurnChars: 400` on two routes, and a caller of this function could not name
   * that width, the marker that makes a cut visible, the window that spends the width on the part of a turn
   * that answers the question, or the layering that is the only remaining path to the cost target. A
   * capability that exists in `CortexMemory` and not in the one function an installer calls is a capability
   * the published package does not have -- which is the asymmetry requirement ⑯ names, arriving through a
   * composition root instead of through a component.
   *
   * ## Why they are forwarded and not defaulted
   *
   * The same rule `sessionClock` states below: `undefined` is the historical rendering, and this file must
   * not be the place a mechanism turns itself on. Absent here means the key is not passed at all, so a bare
   * call reproduces the bytes it produced before these fields existed.
   *
   * ## Why the width is per-turn and not per-prompt
   *
   * `maxPromptChars` above is the room; this is one turn's share of it. They compose the way a page and a
   * column do, and the two are separately measurable -- which is why the campaign priced the room table
   * (-18.8% of the bill, -1.15 points) separately from the width plan (-27.1%, -4.00 points).
   */
  readonly maxTurnChars?: number | undefined;
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

  const memory = new CortexMemory({
    llm: options.llm,
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
    // Forwarded rather than defaulted: `CortexMemory` reads `undefined` as off, and this file must not be
    // the place a mechanism turns itself on. The forwarding is what `turn-clock.test.ts` walks end to
    // end -- a flag that stops at this object is a documented feature a customer cannot reach.
    ...(options.sessionClock === undefined ? {} : { sessionClock: options.sessionClock }),
    // The four rendering fields, forwarded for `sessionClock`'s reason and no other: `undefined` is the
    // historical rendering, so forwarding (rather than defaulting) is what keeps a bare call's bytes fixed
    // while making every measured rendering reachable from the published entry.
    ...(options.maxTurnChars === undefined ? {} : { maxTurnChars: options.maxTurnChars }),
    ...(options.turnCutMarker === undefined ? {} : { turnCutMarker: options.turnCutMarker }),
    ...(options.turnWindow === undefined ? {} : { turnWindow: options.turnWindow }),
    ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
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
