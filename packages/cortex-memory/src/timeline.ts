/**
 * The timeline a prompt can carry: how long each authorised value held, as an interval.
 *
 * ## What this adds that the fact block does not
 *
 * `semantic-facts.ts` already prints the two values it authorised, one per line:
 *
 * ```text
 * fact:     30 dozen  [state]
 * ```
 *
 * What it does not print is **when**. A reader that is told "30 dozen replaced 20 dozen" still has to guess
 * whether the replacement was last week or in 2021, and the failure mode that guess produces is already
 * recorded: `ed4ddc30` answered `30 dozen` from the January turn while the answer's own `20 dozen` was the
 * March one, which is why `supersede.ts` grew its `not-later` check. The dates are not missing from the
 * evidence — they are on every record — but they are on **other** lines than the reading that uses them, and
 * the reader has to join them. Test of Time's own report puts the value of handing a reader the ordering
 * rather than letting it reconstruct the ordering in double digits, at zero inference cost.
 *
 * So the interval is the claim: `from` is the instant of the record the older value was quoted from, `until`
 * is the instant of the record that replaced it, and the newer span is open (`until: Infinity`).
 *
 * ## Why this is a product module and not the instrument's `fact-store.ts`
 *
 * Row 19 of `docs/PRODUCT-CAPABILITY-LEDGER.md` was declared `instrument` with its own reason: *"A prototype:
 * `Fact` has no constructor outside its own file, and the product's knowledge-update path is prompt-only. The
 * audit's §7.2 route is to move it into the product as a third rendering channel, which is an iteration, not a
 * rename."* This is that iteration. The instrument's `timelineFor` orders **LLM-extracted** triples by a
 * `YYYY/MM/DD` string; the product has no extractor and does not need one, because it already holds a stronger
 * object: the two records `adjudicateSupersession` **authorised** (quote in the evidence character for
 * character, date on the same record, record later than the one the previous answer rests on). Ordering
 * authorised pairs is arithmetic over evidence; ordering extracted triples is trust in a model.
 *
 * ## Why `temporal/bitemporal.ts` is not the vehicle
 *
 * `cortex-core` already has a bitemporal `Fact` and three queries over it (`currentFacts`, `currentValue`,
 * `findContradictions`), and reusing them is the obvious move. It is refused for one reason: `Fact` requires
 * `confidence` and `sourceTrust`, and `currentValue` **multiplies** them to pick a winner. The product has
 * neither number — its authorisation is a three-check verdict, not a score — so both fields would have to be
 * invented here, and an invented pair does not merely fill a hole: it decides the answer whenever two facts
 * share a subject. A mechanism whose output is a comparison of two numbers nobody measured is the shape
 * `docs/AUDIT-PARAMETER-SELF-EVOLUTION.md` exists to refuse.
 *
 * ## Why the render takes the served ids
 *
 * `assemble` withholds the older fact on a default question: the ledger refutes its `persistence` and the exit
 * serves only the current value. A timeline that printed both intervals from the **store** would therefore
 * re-publish, as an interval, exactly the value the exit refused to print as a fact — the defect
 * `semantic-facts.ts` paid for when it rendered both ends and handed the reader `20 dozen` on its own line one
 * frame after marking it stale. The filter is the repair: a span is rendered only when the fact it belongs to
 * is in `assemble`'s own `served` list, which makes "the timeline cannot publish what the ledger withheld" a
 * property of the call graph instead of a property of the wording.
 *
 * ## Why one line per span, each prefixed
 *
 * The prompt budget truncates **evidence**, and the block lines are appended after the evidence has been
 * fitted, so a reader can meet the second line without the first. A header line plus indented rows would then
 * be a header that describes rows the reader cannot see. `timeline:` on every line keeps each row a complete
 * statement, and costs eleven bytes per row on a row that already carries a date.
 *
 * ## Why `YYYY/MM/DD` and not the ISO form
 *
 * The evidence in the same prompt is stamped `[2023/05/21 (Sun) 06:30]`, and the instant this module holds is
 * `stampEpoch`'s reading of those same digits as UTC. Formatting them back with `toISOString().slice(0, 10)`
 * round-trips the record's own digits exactly; formatting in local time would shift a record to the previous
 * day for every corpus stamped before 08:00 in a UTC+8 process, which is most of them.
 */
import type { SemanticUpdate } from './semantic-facts.js';

/**
 * One value and the interval it held, as far as the product can evidence it.
 *
 * Not exported, and the reason is the census rather than taste: a type export with no importing caller is an
 * orphan (`tools/export-census.mjs` reported it as one on the first build of this file), and a caller that
 * genuinely wants to name the shape has `ReturnType<typeof timelineOf>[number]`. `renderTimeline` accepts it
 * structurally, so an array built by a caller type-checks without the name.
 *
 * `from` is the record's own instant and **not** the instant the value became true in the world — a corpus
 * states "as of March I was in Shanghai" and says nothing about February. Naming the field `from` rather than
 * `validFrom` is that distinction: the interval's left end is a witness, and a caller that needs the world's
 * answer has to bring a source this module does not have.
 */
type TimelineSpan = {
  /** The fact this span belongs to, so the render can respect what the ledger served. */
  readonly factId: string;
  /** The value in force over the interval, as the authorisation recorded it. */
  readonly value: string;
  /** The instant of the record that stated this value, epoch ms, in the record's own digits. */
  readonly from: number;
  /** The instant of the record that replaced it, or `Infinity` while it is the newest one known. */
  readonly until: number;
};

/**
 * The two intervals one authorised substitution supports, older first.
 *
 * Returns `[]` rather than a one-ended interval when either fact is missing or the two instants do not order:
 * a timeline with one end would render a claim about when a value *stopped* being true without ever saying it
 * started, which reads exactly like a complete statement. `semanticUpdateFrom` refuses both cases before this
 * is reached — its `at === null` guard and `deriveSupersedes`' same-instant refusal — so the guards here are
 * the boundary of a module that a caller can import on its own, not a second policy.
 */
export function timelineOf(update: SemanticUpdate): readonly TimelineSpan[] {
  const olderId = update.factIds[1];
  const newerId = update.factIds[0];
  if (olderId === undefined || newerId === undefined) return [];
  const facts = new Map(update.unit.facts.map((fact) => [fact.id, fact]));
  const older = facts.get(olderId);
  const newer = facts.get(newerId);
  if (older === undefined || newer === undefined) return [];
  if (older.at === undefined || newer.at === undefined) return [];
  if (!(older.at < newer.at)) return [];
  return [
    { factId: olderId, value: older.text, from: older.at, until: newer.at },
    { factId: newerId, value: newer.text, from: newer.at, until: Number.POSITIVE_INFINITY },
  ];
}

/**
 * The lines a prompt may carry, for the spans whose facts the exit actually served.
 *
 * `served` is `assembleSemanticUpdate`'s `servedIds`, in its own order; the input spans are a set matched
 * against it rather than a second ordering. An empty `served` therefore renders nothing at all, which is the
 * state a block whose only surviving fact was refused reaches — and the state that must not become a timeline
 * of the value it refused.
 */
export function renderTimeline(
  spans: readonly TimelineSpan[],
  served: readonly string[],
): readonly string[] {
  const keep = new Set(served);
  const lines: string[] = [];
  for (const span of spans) {
    if (!keep.has(span.factId)) continue;
    const end = span.until === Number.POSITIVE_INFINITY ? 'now' : stamp(span.until);
    // Collapsed to one line: `assemble` prints a fact's text as it was stated, and an answer the reader
    // composed can carry a newline. A newline here would make the interval's own line look like two, and the
    // second one would begin without the `timeline:` prefix that makes a truncated row readable.
    lines.push(`timeline: ${oneLine(span.value)} [${stamp(span.from)} -> ${end}]`);
  }
  return lines;
}

/** The record's own digits, `YYYY/MM/DD`, read and written as UTC so a round trip cannot move the day. */
function stamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10).replace(/-/g, '/');
}

/** One line, whatever the value was stated across. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
