/**
 * Which two systems a `cortex-memory` dispatch puts on its two sides.
 *
 * ## Why this is a selector and not a second workflow
 *
 * The arm's registered pair is *the reference pipeline against the cognitive one*: `run-ablation.ts`
 * builds `NaturalLanguageMemorySystem` as the baseline and `CortexMemory` as the feature, and the
 * delta is what the whole campaign's headline is made of. `S12` asks a different question -- what
 * the semantic layer's carry is worth -- and the two systems it compares differ by exactly one flag
 * of the same class. Running that comparison as two dispatches would pair two runs; running it here
 * pairs two sides of **one** pass, which is the invariant `PREREGISTRATION` §2.2 fixes for the whole
 * arm: time-of-day drift on this corpus is 1.7-2.1pp, larger than most effects an arm could find,
 * and a staggered pair buys that drift for nothing.
 *
 * ## Why the flag is not simply carried on the arm
 *
 * `CORTEX_MEMORY_SEMANTIC_CARRY` is the treatment's own switch and it stays one: it says what the
 * **feature** side does. This variable says what the **baseline** is, and the two are different
 * questions -- a run that set only the switch would compare carrying against the reference
 * pipeline, which is a comparison of two systems rather than of one flag.
 *
 * ## Why `reference` is the default rather than a required value
 *
 * Every archived artifact was produced by the reference pair, and a run that names nothing must
 * keep producing it. A missing variable is therefore not "unconfigured": it is the registered
 * pairing, and the alternative would make the default a decision nobody wrote down.
 */

/**
 * The variable a dispatch sets. Module-local for the reason `capability-filter.ts` gives: the
 * harness spells the name at its one call site, and a second exported spelling is a second
 * statement of one name with nothing checking that they agree.
 */
const PAIRING_VARIABLE = 'CORTEX_MEMORY_AB';

/**
 * The unit the `units` pairing holds on its control side.
 *
 * A literal rather than a read of `tools/arm-config-baseline.json`, and the reason is the same one
 * `ask`'s `'route'` states: **the control is the configuration the register's numbers were produced
 * under, and it must not move when the product adopts a new value.** `turn` is what `45760081761`
 * scored 93.40% at and what every artifact before it selected by; if `turn-fill` is adopted, that
 * artifact stays the reading a future `units` pair is placed against, so the control has to keep
 * naming it. Reading the registered value here would make two readings taken on either side of an
 * adoption incomparable -- deltas against two different controls -- and the register would have no
 * way to say so.
 */
const UNIT_PAIRING_CONTROL = 'turn';

/**
 * The pairings this arm knows how to build.
 *
 * - `reference`: the reference pipeline against the cognitive one. The registered pair, and the
 *   baseline of every artifact this campaign has published.
 * - `carry`: the same cognitive system twice, `semanticCarry` off against on. `S12`'s instrument --
 *   one system, one flag, so the delta is the carry's and not the systems'.
 * - `clock`: the same cognitive system twice, `sessionClock` off against on. `S10`'s counterpart on
 *   the rendering side, and the instrument the boundary clock was registered against (§131 §3).
 * - `resolution`: the same cognitive system twice, `resolution` at the registered `raw` against
 *   `layered`. `C7`'s instrument (`PREREGISTRATION-RESOLUTION-LAYERING.md` §2), pre-registered nine
 *   rounds before this value existed -- its `F1`-`F5` all read "one job, one corpus, both sides", which
 *   is exactly what a one-flag pair produces and what two dispatches cannot.
 * - `ask`: the same cognitive system twice, each route's **reference instruction block** against the
 *   block the dispatch names in `CORTEX_MEMORY_ASK`. The instrument `§13.291`'s adoption should have
 *   been priced with and was not: every ask reading in the register compares two artifacts, and the one
 *   attempt to read a second ask (`45636994046`) compared against an arm whose *rendering* had moved as
 *   well, so the delta it published belonged to `resolution`. A pairing removes the question -- one pass,
 *   one corpus, one block between the sides -- and it is the shape `PREREG-CLOCK-AXIS.md` §7 asked for
 *   after that reading was withdrawn.
 * - `units`: the same cognitive system twice, the registered `turn` unit against the unit the dispatch
 *   names in `CORTEX_MEMORY_RELEVANCE_UNITS`. `PREREG-TURN-FILL.md` was written against a sentence that
 *   claimed "both sides in one job" and no such pairing existed, so the document described an instrument
 *   the harness could not build -- the same defect `resolution` carried for nine rounds. This value is
 *   what makes that pre-registration dispatchable rather than merely readable, and it is the reason the
 *   paragraph below counts five keys rather than four.
 *
 * The last five are one instrument with five keys, and that is why they live here rather than in five
 * files: each asks "what is this one switch worth", each is built by calling the same constructor twice,
 * and each must keep the OTHER keys equal on the two sides. A second selector for the second flag would
 * be a second place that has to remember the same rule, and the rule is the whole instrument -- a pair
 * that differs by two keys publishes a delta neither key can claim.
 *
 * `ask` is the one key whose "off" state is not a `false`: the control is the reference block, which the
 * arm spells `'route'` because it is the *absence* of the option. That is the same shape `resolution`
 * has with `raw`, and it is the reason the pairing is a key table rather than a set of booleans.
 *
 * Not exported: `readArmPairing` is the only way to obtain one, and the export census reports a
 * type nothing names. The union travels in the function's signature, which is where a caller reads it.
 */
type ArmPairing = 'reference' | 'carry' | 'clock' | 'resolution' | 'ask' | 'units';

/**
 * The pairing this environment asks for. Absent and blank mean `reference`.
 *
 * Case and surrounding space are folded, because the value is typed by hand into a dispatch and
 * `CARRY` is what a person writes. An **unknown** value still throws, because that is the case
 * where a run would publish a delta between two systems nobody asked it to compare -- and the
 * message names every pairing this file can build, since the usual mistake is a value it has never
 * heard of rather than a misspelling of one it has. A message that listed three of four would teach
 * its reader to invent the fourth -- and the count in prose is a second statement of the list, so the
 * arithmetic is stated too: a message that says "the three are" and then lists four is read as a list
 * that lost nothing to a reader scanning, and as a lie to a reader counting.
 */
export function readArmPairing(raw: string | undefined): ArmPairing {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'reference') return 'reference';
  if (trimmed === 'carry') return 'carry';
  if (trimmed === 'clock') return 'clock';
  if (trimmed === 'resolution') return 'resolution';
  if (trimmed === 'ask') return 'ask';
  if (trimmed === 'units') return 'units';
  throw new Error(
    `${PAIRING_VARIABLE} does not name a pairing: got ${JSON.stringify(raw)}. The six are ` +
      '`reference` (the reference pipeline against the cognitive one, which is the registered ' +
      'pair and what an unset variable means), `carry` (the cognitive system against itself ' +
      "with `semanticCarry` off, which is `S12`'s instrument), `clock` (the cognitive system " +
      'against itself with `sessionClock` off, which is the boundary clock’s), `resolution` ' +
      '(the cognitive system against itself with `resolution` at the registered `raw`, which is ' +
      "`C7`'s -- the one pair whose delta is a rendering form's), `ask` (the cognitive system " +
      'against itself with each route’s reference instruction block on the control side, which is the ' +
      'pair `§13.291`’s adoption should have been priced with) and `units` (the cognitive system ' +
      'against itself with the registered `turn` evidence unit on the control side, which is the pair ' +
      '`PREREG-TURN-FILL.md` was written against and could not be dispatched to). A value that named ' +
      'none of them would publish a delta between two systems the dispatch never described.',
  );
}

/**
 * The four treatment fields a pairing can split, as a pairing reads them.
 *
 * Structural rather than imported: the arm's own `ArmTreatment` is this type with two fields narrowed
 * (`resolution` to its union and `ask` to its own), so it is assignable here and the two cannot disagree
 * about the four names. Declaring them in the harness instead would put the question "which keys can a
 * pairing move" in the file that builds instances rather than in the file that names pairings.
 */
export type PairingTreatment = {
  readonly carry: boolean;
  readonly clock: boolean;
  readonly resolution: string;
  readonly ask: string;
  /**
   * The evidence unit the **feature** side is asked for, in the arm's own spelling.
   *
   * A `string` rather than the product's union for the reason `resolution` and `ask` are: the dependency
   * runs the other way, and the arm's parser (`readRelevanceUnits`) is the thing that validates it against
   * the product's list. What this field exists for is the refusal below -- a `units` pair whose feature side
   * names the control is two controls, and the artifact would publish a null for a comparison that never
   * administered a unit.
   */
  readonly units: string;
};

/**
 * Why this treatment cannot be this pairing, or `null` when it can.
 *
 * ## Why this is a return value and not four throws in the harness
 *
 * All four checks lived in `run-ablation.ts`'s `main`, which is a 500-line function that opens a dataset and
 * a pool before it can be called -- so **not one of them was tested**, and the three-rung ladder of
 * identical refusals had been carried by prose alone. That is the shape this campaign keeps paying for: a
 * rule stated in a comment and enforced at a call site nothing exercises. Returning the message makes each
 * rung a value a test can assert, and it costs the harness one line.
 *
 * ## Why each pairing refuses rather than defaulting
 *
 * A pair that never administered its treatment publishes a **null**, and a null is read as "this lever is
 * worth nothing" -- the branch every criterion in this campaign treats as a finding. The four cases are
 * not equally dangerous:
 *
 * - `carry`, `clock` and `resolution` split a switch whose **default is the control**, so a dispatcher who
 *   names the pairing and forgets the switch gets two controls, and the artifact at least records the flag
 *   as off.
 * - `ask` is worse. The control side renders each route's reference block and the feature side renders
 *   `CORTEX_MEMORY_ASK`, which defaults to `route` — the same block. So a bare `pairing=ask` dispatch
 *   produces a zero delta **with an ask named on both sides of the record**, and `§13.291`'s adoption
 *   (93.50% against 91.70%) would be re-read as evidence that the instruction block does not matter.
 *
 * ## Why the messages name the variable and the value
 *
 * Each one is read by a person looking at a failed dispatch, at the moment they can still fix the inputs.
 * A message that said "incoherent pairing" would be a message that costs a second dispatch to interpret.
 */
export function pairingViolation(pairing: ArmPairing, treatment: PairingTreatment): string | null {
  switch (pairing) {
    case 'carry':
      if (treatment.carry) return null;
      return (
        'CORTEX_MEMORY_AB=carry pairs the cognitive system against itself with `semanticCarry` off, so the ' +
        'feature side must be the side that carries: set CORTEX_MEMORY_SEMANTIC_CARRY=1. Without it both ' +
        'sides are the control, and the artifact would publish a null result for a comparison that never ' +
        'administered the treatment.'
      );
    case 'clock':
      if (treatment.clock) return null;
      // Not symmetry for its own sake: the boundary clock's criterion (`PREREGISTRATION` §3, `C1`) reads a
      // **paired** movement on `MR`, and a pair with the clock off on both sides produces the null that
      // criterion was written to prevent -- whose branch says "the effect is below the floor or points the
      // other way". A run that never administered the treatment must not be able to land there.
      return (
        'CORTEX_MEMORY_AB=clock pairs the cognitive system against itself with `sessionClock` off, so the ' +
        'feature side must be the side with the clock: set CORTEX_MEMORY_SESSION_CLOCK=on. Without it both ' +
        'sides are the control, and the paired criterion would read zero for a comparison that never ' +
        'administered the treatment.'
      );
    case 'resolution':
      if (treatment.resolution === 'layered') return null;
      // The one `C7` needs: `F1` asks the run to show the mechanism executing (≥90/500 digests changed)
      // before any accuracy number is read, and a pair with `raw` on both sides reads `F1` as zero -- after
      // which the consequence table's first row blames the implementation for what was a dispatch error.
      return (
        'CORTEX_MEMORY_AB=resolution pairs the cognitive system against itself with `resolution` at its ' +
        'registered `raw`, so the feature side must be the side that layers: set ' +
        'CORTEX_MEMORY_RESOLUTION=layered. Without it both sides render whole turns, F1 reads zero, and ' +
        "C7's consequence table would blame the implementation for a dispatch error."
      );
    case 'ask':
      if (treatment.ask !== 'route') return null;
      return (
        'CORTEX_MEMORY_AB=ask pairs the cognitive system against itself with each route’s reference block on ' +
        'the control side, so the feature side must name a block: set CORTEX_MEMORY_ASK to one of the ' +
        'instruction blocks the arm knows (`verbatim`, `verbatim-acts`, `verbatim-clock`, `verbatim-scope`). ' +
        'Without it both sides render the reference block, the delta is zero by construction, and the ' +
        'artifact would publish a null for a comparison that never administered an instruction.'
      );
    case 'units':
      if (treatment.units !== UNIT_PAIRING_CONTROL) return null;
      // The `ask` rung's shape, one layer down: the control is a **named** unit rather than an absent key,
      // so a dispatcher who says `pairing=units` and leaves the variable at its registered `turn` gets the
      // same unit on both sides. The delta would then be exactly zero, the artifact would record a unit on
      // both lines, and `PREREG-TURN-FILL.md` §3's `P1` ("the mechanism fires", read as `promptChars` rising
      // on the 215 named questions) would fail for a reason that has nothing to do with the mechanism.
      return (
        'CORTEX_MEMORY_AB=units pairs the cognitive system against itself with the registered `turn` evidence ' +
        'unit on the control side, so the feature side must name a different one: set ' +
        'CORTEX_MEMORY_RELEVANCE_UNITS to `turn-fill`, `session`, `session-fill`, `anchor-window` or ' +
        '`session-text`. Without it both sides select by `turn`, every prompt is byte-identical, and the ' +
        'artifact would publish a null -- and a zero with a unit named on both sides is the sentence ' +
        '`PREREG-TURN-FILL.md` §5.1 exists to prevent.'
      );
    case 'reference':
      // The registered pair compares two systems, so there is no one key to require: `buildBaseline` and
      // `buildCortex` are different constructions rather than one construction with a flag between them.
      return null;
  }
}
