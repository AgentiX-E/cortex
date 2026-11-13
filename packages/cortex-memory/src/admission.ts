/**
 * Admission: the first production caller `decideWrite` has ever had.
 *
 * The reference pipeline admits a turn because a retrieval score cleared a
 * lexical or embedding threshold. This admits a turn because `cortex-core`'s
 * own value function says the turn is worth retaining. The distinction is the
 * whole reason the package exists — see `docs/AUDIT-CODE-VS-DOCS.md` §6.1.
 *
 * Everything here is pure. `now` is a parameter, not a call to `Date.now()`.
 */
import {
  createMemory,
  decideWrite,
  type MemoryValue,
  type ValueFunction,
} from '@agentix-e/cortex-core';
import type { GateOptions } from './types.js';

/** A turn that cleared the write gate, with the decision's own evidence attached. */
export type AdmittedTurn = MemoryValue & {
  /**
   * Zero-based position of this turn in the list it was admitted from.
   *
   * Carried because adjacency is what a session boundary is made of, and
   * position cannot be re-derived from content once duplicates exist.
   */
  ordinal: number;
};

/**
 * What the write gate computed for every turn it was shown, and what it did with each.
 *
 * ## The defect this exists to close, stated precisely
 *
 * The gate's two variables were made reachable (§49: `sourceTrust` raises the ceiling,
 * `confidenceFor` supplies the variation), and an artifact could then say *what it was
 * configured with*. It could not say **whether the configuration did anything**. Run
 * `37110579101` is the recorded case: `retrievalThreshold: 0` could not close a gate whose
 * maximum observable value was `0.5`, so the repaired program scored what the unrepaired
 * one did and the artifact described a mechanism that had not been reached. The census is
 * the difference between "the configuration says 0.25" and "0.25 cut 41% of the turns".
 *
 * ## Why the counts are over CANDIDATES and not over admitted turns
 *
 * The first draft of this instrument counted the admitted turns only, and it was
 * arithmetically incapable of answering its own question: every admitted turn is above
 * the threshold **by construction**, so `rejected` would be 0 in every run and the
 * acceptance criterion "some turns below, some above" could never be satisfied by any
 * measurement of any configuration. Counting candidates makes `rejected > 0` the exact
 * statement "the gate cut something", which is the statement worth being able to make.
 *
 * ## Why `distinct` is bounded, and why the bound is visible
 *
 * A run of five hundred questions admits a few hundred thousand turns, and a confidence
 * signal computed from length takes a distinct value on almost all of them. Keeping every
 * value would put a set of that size into an artifact that is diffed in review. The
 * builder therefore stops collecting at {@link ADMISSION_DISTINCT_CAP} and reports
 * `distinctSaturated`, so a reader sees `distinct: 64, distinctSaturated: true` and knows
 * the count is a floor. Saturated-at-64 and exactly-64 are different facts, and only one
 * of them is a rounding.
 */
export type AdmissionCensus = {
  /** The gate's threshold, recorded beside the counts so the cut is interpretable. */
  threshold: number;
  /** Turns offered to the gate. */
  candidates: number;
  /** Turns the gate kept, in total across every admission this census covers. */
  admitted: number;
  /** Turns the gate refused. Equal to the count below `threshold`, since the test is `>=`. */
  rejected: number;
  /** Smallest value computed. `0` when nothing was offered -- see `candidates`. */
  min: number;
  /** Largest value computed. `0` when nothing was offered. */
  max: number;
  /** Arithmetic mean over candidates. `0` when nothing was offered. */
  mean: number;
  /** Distinct values seen, saturated at {@link ADMISSION_DISTINCT_CAP}. */
  distinct: number;
  /** True when `distinct` is a floor rather than a count. */
  distinctSaturated: boolean;
};

/**
 * How many distinct values the census remembers.
 *
 * Sixty-four, because the criterion this instrument serves is `distinct >= 2` and every
 * value above that is reporting rather than evidence.
 *
 * Not exported, and the reason is the export census rather than tidiness: an exported
 * constant nothing outside this file calls is public surface with no consumer, which is the
 * shape the census gate rejects. What a caller needs is `distinctSaturated` -- the fact that
 * the count is a floor -- and that is on the record. `admission-census.test.ts` asserts the
 * cap at its documented value, so moving one without the other fails a test rather than
 * silently changing what `distinct` means.
 */
const ADMISSION_DISTINCT_CAP = 64;

/**
 * Accumulates the value the gate computed per candidate turn.
 *
 * ## Why an accumulator rather than a function over a returned list
 *
 * The census has to survive `admitSessions`, which admits each session independently and
 * keeps only the admitted turns — so a function of the *return value* cannot see the turns
 * the gate refused, in exactly the path the abstention route takes. Threading one sink
 * through the calls that already exist is also the only shape that keeps a single loop:
 * a second pass to collect values would be a second place for "what counts as a candidate"
 * to be decided, and the two would drift.
 */
export class AdmissionCensusBuilder {
  readonly #values = new Set<number>();
  #candidates = 0;
  #admitted = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = Number.NEGATIVE_INFINITY;

  /**
   * Record one candidate.
   *
   * `value` is what `decideWrite` computed, which is already clamped to `[0, 1]` by
   * `cortex-core`; clamping again here would hide the one class of defect this instrument
   * is best placed to see (a value function that escapes its documented range).
   */
  record(value: number, admitted: boolean): void {
    this.#candidates += 1;
    if (admitted) this.#admitted += 1;
    this.#sum += value;
    if (value < this.#min) this.#min = value;
    if (value > this.#max) this.#max = value;
    if (this.#values.size < ADMISSION_DISTINCT_CAP) this.#values.add(value);
  }

  /**
   * The census so far, read against `threshold`. Safe to call at any point; it does not reset.
   *
   * The threshold is an argument rather than a constructor field because the counts are
   * the accumulated fact and the threshold is only how they are read. A builder that
   * captured it could be constructed before the gate it describes is resolved, and the
   * value it captured would be `NaN` — which `JSON.stringify` turns into `null`, i.e. an
   * artifact naming a configuration nobody chose.
   */
  census(threshold: number): AdmissionCensus {
    const saturated = this.#values.size >= ADMISSION_DISTINCT_CAP;
    return {
      threshold,
      candidates: this.#candidates,
      admitted: this.#admitted,
      rejected: this.#candidates - this.#admitted,
      // Zeros rather than infinities when nothing was offered: an artifact cannot carry
      // `Infinity` (it serialises to `null`), and `candidates: 0` is the field that says
      // "this is empty" rather than "this is a minimum of zero".
      min: this.#candidates === 0 ? 0 : this.#min,
      max: this.#candidates === 0 ? 0 : this.#max,
      mean: this.#candidates === 0 ? 0 : this.#sum / this.#candidates,
      distinct: this.#values.size,
      distinctSaturated: saturated,
    };
  }
}

/**
 * A turn's identity, derived from the turn instead of drawn at random.
 *
 * ## The defect this replaces, and how it was found
 *
 * `createMemory` defaults `id` to `crypto.randomUUID()`, so every turn admitted got a fresh identifier
 * each time it was admitted. Nothing downstream reads an id by lookup, so this looked harmless -- and
 * it was, until a prompt started citing its sources. `formatEvidenceWithSources` renders
 * `${index}. [${turn.id}] ${content}`, so the ids are **in the prompt**, and the same turns admitted
 * twice produced two different prompts that were otherwise identical.
 *
 * The measurement that named it: run `41144910162` carried the `§13.176` witness, and the witness
 * reported four passes agreeing on the **first 14 bytes** of a 94,674-byte prompt. Stripping the UUID
 * tokens from those four texts made them **byte-identical** -- 90,628 of 94,674 characters matched,
 * and every mismatch was a turn id. Two consequences followed, both already visible in the artifacts:
 *
 *   - `promptVariants == 4` on all 500 questions, so `§13.174`'s repeat premise never held and every
 *     cache figure the campaign quoted was a reading of this defect;
 *   - a prefix cache can reuse nothing after byte 14, which is the whole explanation for a 10.4% cache
 *     share against a 60-80% prediction. Four passes with the same request would have shared 75% of
 *     their prompt tokens; four passes with a different first turn share none of it.
 *
 * ## Why content-addressing is the right fix rather than a bench-only override
 *
 * A random id makes admission **non-idempotent**: re-admitting the same turn twice creates two
 * identities for one fact. That is wrong on its own terms -- consolidation keys memories by id, and a
 * store that cannot tell "the same turn again" from "a second turn like it" is the bug this project
 * spends its time finding in other people's systems. Deriving the id from the turn makes admission a
 * function of its input, which is also what makes a prompt reproducible: same turns, same bytes,
 * same cache entry.
 *
 * ## Why it is four 32-bit hashes and not `node:crypto`
 *
 * `cortex-memory` runs in a browser, and its entry graph is guarded against host APIs
 * (`tools/entry-guard.mjs`). A 128-bit digest from four FNV-1a streams with distinct offset bases is
 * not cryptographic -- it does not need to be. The requirement is a label that is stable, well
 * distributed and collision-free for realistic inputs; guessing one buys nothing, because an id is
 * not a secret and never was.
 *
 * The ordinal is mixed in, so two identical turns at different positions stay distinct -- the one
 * thing a content-only hash would merge.
 *
 * Deliberately **not exported**: its only caller is the line below, and an export with one internal
 * caller and one test caller is the orphan that `tools/export-census.mjs --check` exists to refuse.
 * The properties worth pinning are reachable through `admitTurns`, which is what the suite drives.
 */
function turnIdFor(content: string, ordinal: number): string {
  const text = `${ordinal}\u0000${content}`;
  const parts = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((basis) => {
    let hash = basis >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // A final avalanche, because FNV alone leaves the low bits of short inputs weakly mixed and the
    // last group of the formatted id is entirely low bits.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    // `>>> 0` after the last shift, because `^` returns a signed 32-bit value and `toString(16)` then
    // emits a leading minus sign -- which turned a fixed-width id into a 30-character one for one input
    // in eight. Found by the shape assertion in `turn-identity.test.ts`, which is why that assertion
    // checks the length and not just the pattern.
    hash = (hash ^ (hash >>> 13)) >>> 0;
    return hash.toString(16).padStart(8, '0');
  });
  const hex = parts.join('');
  // Version nibble `8` (a caller-defined id, which is what this is) and variant `8`, so the shape is a
  // UUID to every consumer that only validates the shape, and never mistaken for a v4 random id.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The subset of {@link GateOptions} admission reads. */
export type AdmissionOptions = {
  /** Epoch milliseconds, injected so value is a function of a pinned clock. */
  now: number;
  /** Admitted when the value is at or above this. */
  threshold: number;
  /** Replaces {@link clockAwareValueFunction} when supplied. */
  valueFunction?: ValueFunction;
  /**
   * Source trust stamped on each constructed memory. In `[0, 1]`; defaults to
   * `0.5`. See {@link GateOptions.sourceTrust} for why this is a field.
   */
  sourceTrust?: number;
  /**
   * Per-turn confidence, evaluated once per turn. In `[0, 1]`; defaults to `1`,
   * which is `createMemory`'s value and therefore the pre-existing behaviour.
   *
   * This is what makes the retrieval gate **discriminating** rather than merely
   * reachable. §49 of `docs/09-progress-and-delivery-report.md` measured that
   * raising `sourceTrust` moves the reachable range without turning it into a
   * distribution: with all three value-function factors pinned per turn, every
   * admitted turn carries the same value, so no interior threshold can separate a
   * strong candidate from a weak one. `confidence` is the only factor with room,
   * and this field is the room.
   *
   * A callback rather than a `number[]` aligned with `turns`, for two reasons. It
   * is evaluated lazily on the turn being decided, so a caller cannot supply a
   * list that silently disagrees with the input order; and it is the same shape
   * as {@link valueFunction}, which keeps the two injections symmetric. The
   * callback sees the turn's **content**, never its ordinal -- a confidence that
   * depended on position would make the gate a statement about ordering rather
   * than about evidence.
   *
   * The default is `1` and does not move, exactly as `sourceTrust`'s default does
   * not move: every measurement taken before this field existed was taken with
   * the constant behaviour, so the constant has to remain the unconfigured one for
   * those numbers to keep their meaning.
   */
  confidenceFor?: (turn: string) => number;
  /**
   * Where the census goes.
   *
   * On the options rather than as a parameter of {@link admitInto}, and the difference is
   * a measured defect rather than a taste. `CortexMemory` admits on two paths — `#admit`
   * for the flat and temporal routes, `answerSessions` for the session route — and when the
   * sink was a parameter only one of them was wired; the other reported `candidates: 0`
   * while admitting four turns. Putting the sink here means the only way to omit it is to
   * omit it at `admissionOptionsFrom`, which is the one place a gate becomes admission's
   * options, and a call site that does not use that function is visible in a diff.
   */
  tally?: AdmissionCensusBuilder;
};

/**
 * The trust stamped on a memory when the caller supplies none.
 *
 * Not exported through the barrel. It earns its name inside this file -- the ceiling
 * theorem is `confidence * DEFAULT_SOURCE_TRUST * (0.5 + 0.5 * recency)`, so a
 * reader can evaluate it without leaving the module -- but making it public API
 * would publish a number that no caller needs and that `createMemory` already
 * owns. The census gate is what caught that: the constant was exported with no
 * consumer, which is the shape of a symbol that will drift from its one real use.
 */
const DEFAULT_SOURCE_TRUST = 0.5;

/**
 * Validate a per-turn confidence, naming the turn it was computed for.
 *
 * The same guard the thresholds and `sourceTrust` apply, for the same three
 * failure modes, plus one this field has and they do not: `confidenceFor` is
 * caller-supplied **code**, so nothing bounds what it returns. `NaN` is the
 * dangerous one -- every `>=` against it is false, so the gate admits nothing and
 * completes a run whose result describes the callback -- and it would also be
 * stamped onto a memory that reaches contradiction resolution, where
 * `confidence * sourceTrust` is read directly.
 *
 * The message carries the turn because the callback is evaluated per turn:
 * "somewhere in this context" is not a location, and a long context is exactly
 * where the offending call is hard to find.
 */
function validateConfidence(turn: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `confidenceFor must return a number in [0, 1], got ${String(value)} for turn ` +
        `${JSON.stringify(turn)}. It is the confidence factor of ` +
        'confidence * sourceTrust * (0.5 + 0.5 * recency), so a value above 1 makes the ' +
        'ceiling exceed the model and a value below 0 or NaN admits nothing -- each ' +
        'completing a run whose result describes the callback.',
    );
  }
  return value;
}

/**
 * Validate a `[0, 1]` trust score, naming the offending value.
 *
 * The same guard the arm applies to its thresholds, for the same reason: all three
 * failure modes complete a full run whose result describes the typo rather than the
 * system. `> 1` makes the ceiling a lie about the model, `< 0` makes every value
 * negative so the gate admits nothing, and `NaN` makes every `>=` false so the gate
 * admits nothing -- and neither of the last two produces an error anywhere.
 *
 * Thrown rather than clamped. A clamp would silently reinterpret `1.5` as `1`, and
 * a caller who typed a percentage instead of a fraction would get a plausible
 * configuration and an uninterpretable result -- the shape the threshold guards
 * already reject.
 *
 * The message renders the value with `String` rather than `JSON.stringify`, and the
 * difference is not cosmetic: `JSON.stringify(NaN)` is `` null ``, so the offending
 * argument would be reported as `` null `` -- a value the caller did not pass and
 * cannot search for. A diagnostic that names something other than the input is the
 * same defect as an artifact that describes a typo instead of a system.
 */
function validateSourceTrust(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `sourceTrust must be a number in [0, 1], got ${String(value)}. ` +
        'It scales the value function confidence * sourceTrust * (0.5 + 0.5 * recency), ' +
        'so a value above 1 makes the ceiling exceed the model, and a value below 0 or ' +
        'NaN admits nothing -- each completing a run whose result describes the argument.',
    );
  }
  return value;
}

/**
 * `cortex-core`'s `defaultValueFunction` reads the wall clock from inside — it
 * computes recency as `Math.exp(-(Date.now() - lastAccessedAt) / 30 days)` and
 * takes no clock parameter. That is correct for a library that cannot know its
 * caller's clock, and wrong for a composition layer that was handed one: a
 * caller pinning `now` would still get real-time decay, so admission would be
 * unreproducible and a replayed benchmark would admit a different set of turns
 * on every run.
 *
 * This restates the same formula against the injected clock. It is a deliberate
 * duplicate of four arithmetic operations, and the tests pin the two together
 * so they cannot drift apart silently.
 */
export function clockAwareValueFunction(now: number): ValueFunction {
  const THIRTY_DAYS_MS = 1000 * 60 * 60 * 24 * 30;
  return (memory: MemoryValue): number => {
    const recencyWeight = Math.exp(-(now - memory.lastAccessedAt) / THIRTY_DAYS_MS);
    return memory.confidence * memory.sourceTrust * (0.5 + 0.5 * recencyWeight);
  };
}

/**
 * Filter `turns` to those the write gate values at or above the threshold.
 *
 * Order is preserved and the input is not mutated. Content is passed through
 * untruncated: prompt budget is a property of prompt assembly, where the budget
 * is actually known, and truncating here would make the value decision depend
 * on a budget admission does not have.
 *
 * ## The two factors this function can vary, and why they are separate
 *
 * `sourceTrust` raises the **ceiling**: it decides whether a threshold above `0.5`
 * can ever admit anything. `confidenceFor` introduces **variation**: it decides
 * whether a threshold inside the reachable range can separate one turn from
 * another. They are different repairs and §49 measured the first one working while
 * the second was still absent -- at `sourceTrust: 1` every admitted turn carried
 * exactly `1`, so the reachable range was the set `[0, 1]` and every cut in it was
 * still all-or-nothing.
 *
 * `recency` is the third factor and it is deliberately fixed: admission sets
 * `lastAccessedAt === createdAt === now`, so it is exactly `exp(0) = 1` for every
 * turn of one admission. That is not an oversight to be repaired later -- a turn's
 * age is a property of when it was recorded, and all turns of one context were
 * recorded at the same instant by construction. A caller wanting age to matter
 * supplies a `valueFunction`, which is what that field is for.
 */
export function admitTurns(turns: readonly string[], options: AdmissionOptions): AdmittedTurn[] {
  return admitInto(turns, options);
}

/**
 * The loop.
 *
 * The census sink is read from the options rather than taken as a parameter, and that is a
 * repair rather than a preference. It was a parameter first, and `CortexMemory` has **two**
 * paths that admit — `#admit`, which serves the flat and temporal routes, and
 * `answerSessions`, which admits by the session — so exactly one of them was instrumented
 * and the other reported `candidates: 0`. The census is only a fact about a run if every
 * path that admits writes to the same sink, and the way to make that structural rather than
 * remembered is to put the sink where the options are: `admissionOptionsFrom` is the one
 * place a gate becomes admission's options, and every path goes through it.
 */
function admitInto(turns: readonly string[], options: AdmissionOptions): AdmittedTurn[] {
  const tally = options.tally;
  const valueFn = options.valueFunction ?? clockAwareValueFunction(options.now);
  const sourceTrust = validateSourceTrust(options.sourceTrust ?? DEFAULT_SOURCE_TRUST);
  const confidenceFor = options.confidenceFor;
  const admitted: AdmittedTurn[] = [];

  for (let ordinal = 0; ordinal < turns.length; ordinal += 1) {
    const content = turns[ordinal];
    if (content === undefined) continue;

    // Built through `createMemory` so FSRS defaults stay owned in one place.
    // The consolidation-clock defect was two literals that had to agree; the
    // composition layer must not become a third.
    //
    // `confidence` is passed only when a callback was supplied. Spreading it in
    // as `undefined` would be the same value by a different route today, but it
    // would also put the key in the object literal and make the default reachable
    // from two places -- and the default is the compatibility guarantee, so it has
    // exactly one owner: `createMemory`.
    const memory = createMemory({
      // Derived, not drawn: see {@link turnIdFor}. A random id put a different 36-character token in
      // every pass's prompt, which is what made four "repeats" four different requests.
      id: turnIdFor(content, ordinal),
      content,
      createdAt: options.now,
      lastAccessedAt: options.now,
      source: 'unknown',
      sourceTrust,
      type: 'episodic',
      ...(confidenceFor === undefined
        ? {}
        : { confidence: validateConfidence(content, confidenceFor(content)) }),
    });

    const decision = decideWrite(memory, valueFn, options.threshold);
    // Recorded for admitted and refused turns alike, and this is the whole instrument:
    // a census of the admitted set can only ever report values above the threshold.
    tally?.record(decision.value, decision.write);
    if (decision.write) {
      admitted.push({ ...memory, value: decision.value, ordinal });
    }
  }

  return admitted;
}

/**
 * The gate configuration admission needs, narrowed from {@link GateOptions}.
 *
 * The optional fields are copied only when present, so an unset `valueFunction`
 * stays absent rather than becoming `undefined`. The distinction is small and it is
 * kept for the reason the original single-field version kept it: `admissionOptionsFrom`
 * is the one place a caller's gate becomes admission's options, and a reader
 * comparing the two objects should see the same shape.
 *
 * Written as statements rather than a chain of conditional spreads. The spread form
 * is shorter and produced two more branch sites than there are decisions, which the
 * coverage gate reported as an uncovered line -- the code was harder to read and
 * the measurement said so.
 */
export function admissionOptionsFrom(
  now: number,
  gate: GateOptions,
  /**
   * Where the census goes. Optional so a caller that only wants turns is not forced to
   * construct one — but never *defaulted*, because a default would be a sink nobody reads
   * and the omission would look like a measurement of zero.
   */
  tally?: AdmissionCensusBuilder,
): AdmissionOptions {
  const options: AdmissionOptions = { now, threshold: gate.threshold };
  if (gate.valueFunction !== undefined) options.valueFunction = gate.valueFunction;
  if (gate.sourceTrust !== undefined) options.sourceTrust = gate.sourceTrust;
  if (gate.confidenceFor !== undefined) options.confidenceFor = gate.confidenceFor;
  if (tally !== undefined) options.tally = tally;
  return options;
}
