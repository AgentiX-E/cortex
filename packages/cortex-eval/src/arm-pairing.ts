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
 * The pairings this arm knows how to build.
 *
 * - `reference`: the reference pipeline against the cognitive one. The registered pair, and the
 *   baseline of every artifact this campaign has published.
 * - `carry`: the same cognitive system twice, `semanticCarry` off against on. `S12`'s instrument --
 *   one system, one flag, so the delta is the carry's and not the systems'.
 * - `clock`: the same cognitive system twice, `sessionClock` off against on. `S10`'s counterpart on
 *   the rendering side, and the instrument the boundary clock was registered against (§131 §3).
 *
 * The last two are one instrument with two flags, and that is why they live here rather than in two
 * files: both ask "what is this one switch worth", both are built by calling the same constructor
 * twice, and both must keep the OTHER flag equal on the two sides. A second selector for the second
 * flag would be a second place that has to remember the same rule, and the rule is the whole
 * instrument -- a pair that differs by two flags publishes a delta neither flag can claim.
 *
 * Not exported: `readArmPairing` is the only way to obtain one, and the export census reports a
 * type nothing names. The union travels in the function's signature, which is where a caller reads it.
 */
type ArmPairing = 'reference' | 'carry' | 'clock';

/**
 * The pairing this environment asks for. Absent and blank mean `reference`.
 *
 * Case and surrounding space are folded, because the value is typed by hand into a dispatch and
 * `CARRY` is what a person writes. An **unknown** value still throws, because that is the case
 * where a run would publish a delta between two systems nobody asked it to compare -- and the
 * message names every pairing this file can build, since the usual mistake is a value it has never
 * heard of rather than a misspelling of one it has. A message that listed two of three would teach
 * its reader to invent the third.
 */
export function readArmPairing(raw: string | undefined): ArmPairing {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '' || trimmed === 'reference') return 'reference';
  if (trimmed === 'carry') return 'carry';
  if (trimmed === 'clock') return 'clock';
  throw new Error(
    `${PAIRING_VARIABLE} does not name a pairing: got ${JSON.stringify(raw)}. The three are ` +
      '`reference` (the reference pipeline against the cognitive one, which is the registered ' +
      'pair and what an unset variable means), `carry` (the cognitive system against itself ' +
      "with `semanticCarry` off, which is `S12`'s instrument) and `clock` (the cognitive system " +
      'against itself with `sessionClock` off, which is the boundary clock’s). A value that named ' +
      'none of them would publish a delta between two systems the dispatch never described.',
  );
}
