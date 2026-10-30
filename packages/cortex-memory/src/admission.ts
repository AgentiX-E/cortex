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
export function admissionOptionsFrom(now: number, gate: GateOptions): AdmissionOptions {
  const options: AdmissionOptions = { now, threshold: gate.threshold };
  if (gate.valueFunction !== undefined) options.valueFunction = gate.valueFunction;
  if (gate.sourceTrust !== undefined) options.sourceTrust = gate.sourceTrust;
  if (gate.confidenceFor !== undefined) options.confidenceFor = gate.confidenceFor;
  return options;
}
