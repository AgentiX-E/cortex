import { readFileSync } from "node:fs";

/**
 * What a competitor's published "context tokens per question" counts, taken apart from their own
 * published per-question records.
 *
 * Maximem Synap publishes 95.6% on LongMemEval at "about 7,400 tokens of retrieved memory per
 * question", against this repository's 91.95% at 12,137 prompt tokens. Set side by side, that is a
 * 40% price advantage for a 3.65-point accuracy lead, and it is the reading that makes replicating
 * their engine look like the obvious next move.
 *
 * The engine is closed (the published repository is an SDK that calls a hosted service), so the
 * records are the only instrument available. They are enough to show that the two numbers do not
 * count the same thing:
 *
 * - `material` is what the reader actually reads: the `memory` summary plus every
 *   `source_evidence` excerpt. `serialised` is the whole record, field skeleton included.
 * - The vendor's 7,391 is reproducible as `material / 3.6`, the content-only reading. Against the
 *   serialised record the same headline implies 5.4 characters per token, which no English
 *   tokenizer produces.
 * - Neither number includes the answering prompt, which is a published 21.5 kB file.
 *
 * The census does not decide whether that is dishonest. It reports which reading the arithmetic
 * supports and names the other one, because a tool that silently picked the flattering
 * interpretation would produce the same table as a tool that was right.
 */

/**
 * Compare two integers with the exact ordering a median needs.
 *
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function ascending(a, b) {
  return a - b;
}

/**
 * The median of a non-empty numeric list. `null` when the list is empty, because a median over
 * nothing is not zero -- zero is the statement that every observation was zero.
 *
 * @param {readonly number[]} values
 * @returns {number | null}
 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort(ascending);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Every excerpt a single retrieved item carries, as strings.
 *
 * The key may be absent, `null`, an empty list, or a list holding a non-string. Absent and empty
 * both mean the reader gets a summary it cannot check, which is the fact this census is about, so
 * they are treated alike here and counted apart by {@link evidenceShape}.
 *
 * @param {Record<string, unknown>} item
 * @returns {string[]}
 */
function excerptsOf(item) {
  const raw = item.source_evidence;
  if (!Array.isArray(raw)) return [];
  return raw.filter((piece) => typeof piece === 'string');
}

/**
 * Per-question sizes: how much the reader reads, how much the transport carries.
 *
 * `fields` is the difference and it is not waste in the abstract -- the dates and the entity
 * markers are what the vendor's answering prompt reads. The point is that a headline can count the
 * first two and not the third, and then be compared against a number that counts everything.
 *
 * @param {readonly Record<string, any>[]} records
 * @returns {{questionId: string, items: number, withEvidence: number, material: number | null,
 *   serialised: number | null, fields: number | null}[]}
 */
export function contextCensus(records) {
  return records.map((record) => {
    const items = record?.retrieval?.retrieved_context;
    const context = Array.isArray(items) ? items : [];
    if (context.length === 0) {
      // Nothing was retrieved. Reporting 0 would read as "this question cost nothing to answer",
      // which is the opposite of what an empty retrieval means.
      return {
        questionId: String(record?.question_id ?? ''),
        items: 0,
        withEvidence: 0,
        material: null,
        serialised: null,
        fields: null,
      };
    }
    let material = 0;
    let serialised = 0;
    let withEvidence = 0;
    for (const item of context) {
      const memory = typeof item?.memory === 'string' ? item.memory : '';
      const excerpts = excerptsOf(item ?? {});
      if (excerpts.length > 0) withEvidence += 1;
      material += memory.length + excerpts.reduce((sum, piece) => sum + piece.length, 0);
      serialised += JSON.stringify(item, null, 2).length;
    }
    return {
      questionId: String(record?.question_id ?? ''),
      items: context.length,
      withEvidence,
      material,
      serialised,
      fields: serialised - material,
    };
  });
}

/**
 * The per-question medians, which is the unit the published headline is stated in.
 *
 * Taking the median over items instead would let one question with forty retrievals outweigh one
 * with two, and the two numbers would then be about different populations while looking
 * interchangeable.
 *
 * @param {readonly {items: number, material: number | null, serialised: number | null,
 *   withEvidence: number}[]} census
 */
export function summarise(census) {
  const measured = census.filter((row) => typeof row.material === 'number');
  const itemsTotal = census.reduce((sum, row) => sum + row.items, 0);
  const withEvidenceTotal = census.reduce((sum, row) => sum + row.withEvidence, 0);
  return {
    questions: census.length,
    measurable: measured.length,
    medianItems: median(census.map((row) => row.items)),
    medianMaterial: median(measured.map((row) => row.material)),
    medianSerialised: median(
      census.filter((row) => typeof row.serialised === 'number').map((row) => row.serialised),
    ),
    itemsTotal,
    withEvidenceTotal,
    evidenceShare: itemsTotal === 0 ? null : withEvidenceTotal / itemsTotal,
  };
}

/**
 * The shape of the verbatim excerpts: how long they are, and how often there is none.
 *
 * A near-uniform length distribution is the signature of a fixed truncation window rather than of
 * natural turn lengths, and an item with no excerpt is a summary the reader has to trust.
 *
 * @param {readonly Record<string, any>[]} records
 */
export function evidenceShape(records) {
  const lengths = [];
  let items = 0;
  let itemsWithoutEvidence = 0;
  for (const record of records) {
    const context = record?.retrieval?.retrieved_context;
    if (!Array.isArray(context)) continue;
    for (const item of context) {
      items += 1;
      const excerpts = excerptsOf(item ?? {});
      if (excerpts.length === 0) itemsWithoutEvidence += 1;
      for (const piece of excerpts) lengths.push(piece.length);
    }
  }
  return {
    items,
    pieces: lengths.length,
    median: median(lengths),
    itemsWithoutEvidence,
  };
}

/**
 * The band an English tokenizer keeps characters-per-token inside.
 *
 * One band for both readings, deliberately. Giving the whole-record reading a wider band would be
 * the tool deciding in advance that the vendor's number is the larger one -- and the two readings
 * differ by a factor of 1.5 here, so at most one of them can be a tokenizer measurement and the
 * other has to be named as not one.
 */
const TOKENIZER_BAND = [3.0, 4.5];

/**
 * Which reading of a published headline the arithmetic supports.
 *
 * Two readings are possible and they imply different prices: content-only (`material`), which is
 * what a reader consumes, and whole-record (`serialised`), which is what the transport carries.
 * The function computes both against one tokenizer band, names the one inside it, and says
 * `implausible` about the other -- rather than leaving a reader to divide two numbers by hand and
 * conclude whatever they expected.
 *
 * @param {{material: number | null, serialised: number | null, items: number}} census
 * @param {number} headlineTokens
 */
export function explainHeadline(census, headlineTokens) {
  const measurable =
    typeof census?.material === 'number' &&
    typeof census?.serialised === 'number' &&
    Number.isFinite(headlineTokens) &&
    headlineTokens > 0;
  if (!measurable) {
    return {
      headlineTokens,
      charsPerTokenIfContent: null,
      charsPerTokenIfSerialised: null,
      reading: null,
      serialisedReading: null,
    };
  }
  const content = census.material / headlineTokens;
  const serialised = census.serialised / headlineTokens;
  const inside = (value) => value >= TOKENIZER_BAND[0] && value <= TOKENIZER_BAND[1];
  const contentInside = inside(content);
  const serialisedInside = inside(serialised);
  return {
    headlineTokens,
    charsPerTokenIfContent: Math.round(content * 100) / 100,
    charsPerTokenIfSerialised: Math.round(serialised * 100) / 100,
    // Both inside is not a tie to break by preference: it would mean two populations of the same
    // size, and the caller has to be told the census cannot separate them.
    reading: contentInside && !serialisedInside
      ? 'content-only'
      : serialisedInside && !contentInside
        ? 'record'
        : contentInside && serialisedInside
          ? 'ambiguous'
          : null,
    serialisedReading: serialisedInside ? 'plausible' : 'implausible',
  };
}

/**
 * The records in a published file, tolerating one that stopped early.
 *
 * A 23 MB download over a slow link arrives truncated more often than not, and a `JSON.parse` that
 * throws on the last byte discards every record before it. The array is therefore split at each
 * top-level record boundary and each record is parsed on its own; the incomplete tail is dropped
 * rather than repaired, and the count of what was dropped is returned so a caller can say how much
 * of the corpus a reading rests on.
 *
 * @param {string} raw
 * @returns {{records: Record<string, any>[], parsed: number, truncated: boolean}}
 */
export function parseRecords(raw) {
  try {
    const whole = JSON.parse(raw);
    return Array.isArray(whole)
      ? { records: whole, parsed: whole.length, truncated: false }
      : { records: [], parsed: 0, truncated: false };
  } catch {
    // Fall through to the per-record split.
  }
  const starts = [...raw.matchAll(/\n \{\n {2}"question_id"/g)].map((match) => match.index);
  const records = [];
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : raw.length;
    try {
      records.push(JSON.parse(raw.slice(starts[index], end).trim().replace(/,$/, "")));
    } catch {
      // The final record is the one that can be cut in half; a middle one cannot be, so a parse
      // failure there is a shape this parser does not know and it is skipped rather than guessed.
    }
  }
  return { records, parsed: records.length, truncated: true };
}

/**
 * Print the census for one published records file.
 *
 * The reading is a table rather than a paragraph because the whole point is that two numbers which
 * look comparable are not: the content size and the transport size sit in adjacent rows, and so do
 * the two implied characters-per-token ratios.
 *
 * @param {readonly string[]} argv
 * @returns {number} exit code
 */
function main(argv) {
  const [file, ...rest] = argv;
  if (file === undefined) {
    process.stderr.write(
      "usage: synap-context-census.mjs <records.json> [--headline <tokens>]\n" +
        "  <records.json>  a published per-question records file (array of records)\n" +
        "  --headline      the vendor's published tokens-per-question, default 7391\n",
    );
    return 2;
  }
  const headlineIndex = rest.indexOf("--headline");
  const headline = headlineIndex === -1 ? 7391 : Number(rest[headlineIndex + 1]);
  const parsed = parseRecords(readFileSync(file, "utf8"));
  const census = summarise(contextCensus(parsed.records));
  const shape = evidenceShape(parsed.records);
  const explained = explainHeadline(
    { material: census.medianMaterial, serialised: census.medianSerialised, items: census.medianItems },
    headline,
  );
  const lines = [
    `records parsed          ${parsed.parsed}${parsed.truncated ? " (file was truncated; tail dropped)" : ""}`,
    `median items/question   ${census.medianItems}`,
    `median content chars    ${census.medianMaterial}`,
    `median serialised chars ${census.medianSerialised}`,
    `items with an excerpt   ${pct(census.evidenceShare)}`,
    `excerpt length median   ${shape.median} chars`,
    "",
    `headline                ${headline} tokens/question`,
    `  as content            ${explained.charsPerTokenIfContent} chars/token -> ${explained.reading ?? "no reading"}`,
    `  as whole record       ${explained.charsPerTokenIfSerialised} chars/token -> ${explained.serialisedReading}`,
    "",
    `reading: the published figure reproduces against the content only. The field skeleton is ` +
      `${census.medianSerialised === null ? "unmeasured" : `${census.medianSerialised - census.medianMaterial} chars/question`} ` +
      `and the answering prompt is a separate file, so neither number is comparable with a ` +
      `prompt-token count that includes both.`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** A percentage, or an em dash when nothing was measured. */
function pct(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
