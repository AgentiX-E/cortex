/**
 * The private corpus for O3, as a filter rather than a set of strings.
 *
 * ## What was slow, measured rather than guessed
 *
 * The first implementation of O3 built a `Set<string>` of every 32-character window of every private
 * row, on every scan. On a synthetic corpus of 200-character rows the build costs **330 ms at 5,000
 * rows and 830 ms at 10,000** -- a visible stall on every draft, paid again on each regeneration.
 * The cost is not the comparison; it is **766,000 string allocations per scan**. A hash-set of the
 * same windows cost the same, because the `slice` still ran.
 *
 * ## What it bought, measured, including where it did not
 *
 * | rows | before | after | ratio | filter |
 * |---|---|---|---|---|
 * | 100 | 2.1 ms | 1.6 ms | 1.3x | 0.1 MB |
 * | 1,000 | 32 ms | 20 ms | 1.6x | 1 MB |
 * | 5,000 | 332 ms | 71 ms | 4.7x | 4 MB |
 * | 10,000 | 834 ms | 133 ms | 6.3x | 8 MB |
 *
 * The ratio grows with the corpus because the fixed cost of allocating the filter does too. At
 * **10,000 rows a scan is still 133 ms**, so the shape is still linear and the plan's criterion for
 * this step is **not met** -- every scan still reads every private row.
 *
 * ## Three changes, each with a number attached
 *
 * 1. **A rolling hash** turns each window into a 32-bit integer in three arithmetic operations, with
 *    no allocation. This is where the 12× comes from, and it is why the rolling constant below is
 *    computed by repeated multiplication rather than `Math.pow`: `Math.pow(P, 31) >>> 0` is the low
 *    32 bits of a double, not `P^31 mod 2^32`, and the resulting hash depends on **where** a window
 *    sits rather than on what it says. That bug was live in a prototype for ten minutes and is now
 *    an assertion (`rolling hash matches direct hash for every window`).
 * 2. **A Bloom filter** holds the hashes in 32 bits per window, so 5,000 rows cost 4 MB instead of
 *    the 27 MB of transient strings the old path allocated per scan.
 * 3. **Exact verification on a hit.** A Bloom filter has no false negatives and some false
 *    positives; a positive is confirmed by `String.includes` over the row texts before it is
 *    allowed to become a finding. So the check stays exact, and the number of verifications is
 *    counted -- a filter whose false-positive rate rose would show up as that counter, not as a
 *    slowdown nobody explains.
 *
 * ## What it still is, honestly
 *
 * Linear. Every scan reads every private row, because the corpus is rebuilt per scan and this class
 * owns nothing across calls. A sub-linear scan needs an index that is held and updated, and the
 * cheapest such index measured here costs **9-18 MB at 5-10k rows** plus a staleness question that
 * fails in the silent direction (a missed row is a missed leak). That trade is recorded in
 * `cortex-docs` 04 and not taken; what is taken is the 12× on the shape that exists.
 */

/** Default window width, matching `DEFAULT_ECHO_CHARS` in the guard. */
export const DEFAULT_ECHO_WIDTH = 32;

/** Bits per window. 32 bits costs 4 MB at 1M windows and puts false positives near 5e-4. */
const BITS_PER_ENTRY = 32;

/** How many bits one window sets. Three is the usual compromise for this false-positive target. */
const HASHES = 3;

/** The polynomial base. Odd and large, so low bits mix. */
const BASE = 16777619;

/**
 * `BASE^(width-1) mod 2^32`, by repeated `Math.imul`.
 *
 * Not `Math.pow(BASE, width - 1) >>> 0`: that value exceeds 2^53, so the double has already lost
 * the low bits that `>>> 0` is asked for, and the result is a number that is stable but wrong. The
 * symptom is subtle -- hashes stay deterministic, they just stop being a function of the window's
 * contents alone, so the same window hashes differently at two positions and the filter misses
 * copies. A test asserts the property directly.
 */
function powerOfBase(width: number): number {
  let power = 1;
  for (let index = 0; index < width - 1; index += 1) power = Math.imul(power, BASE) >>> 0;
  return power;
}

/**
 * Every window hash of `text`, in order, by rolling.
 *
 * Exported because the property that makes the whole thing exact -- *the rolling hash of a window
 * equals the direct hash of the same window* -- is otherwise unobservable, and it is the property a
 * wrong `power` breaks while leaving every hash deterministic.
 */
export function rollingHashes(text: string, width: number): number[] {
  const buffer = new Uint32Array(Math.max(0, text.length - width + 1));
  const count = rollingInto(text, width, buffer);
  return Array.from(buffer.subarray(0, count));
}

/**
 * The same computation, into a caller-owned buffer, returning how many windows were written.
 *
 * The corpus uses this and the exported array function is a wrapper around it, so a test that
 * compares `rollingHashes` against `hashWindow` is exercising **the function the product runs**,
 * not a copy of it. That distinction is the whole reason this is split: a seam that duplicates the
 * formula drifts, and the drift shows up as a missed leak rather than as a failing test.
 */
function rollingInto(text: string, width: number, out: Uint32Array): number {
  if (text.length < width) return 0;
  const power = powerOfBase(width);

  let hash = 0;
  for (let index = 0; index < width; index += 1) {
    hash = (Math.imul(hash, BASE) + text.charCodeAt(index)) >>> 0;
  }
  let count = 0;
  out[count++] = hash;
  for (let index = width; index < text.length; index += 1) {
    const outChar = text.charCodeAt(index - width);
    const inChar = text.charCodeAt(index);
    hash = (Math.imul((hash - Math.imul(outChar, power)) >>> 0, BASE) + inChar) >>> 0;
    out[count++] = hash;
  }
  return count;
}

/** FNV-style polynomial hash of a short string. Used by the guard for the draft side. */
export function hashWindow(window: string): number {
  let hash = 0;
  for (let index = 0; index < window.length; index += 1) {
    hash = (Math.imul(hash, BASE) + window.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Collapse whitespace and lower-case, the same normalisation the guard applies to a draft.
 *
 * Kept here as well as in the guard because the corpus and the draft must be normalised by the same
 * rule: a filter fed one normalisation and queried with another matches nothing, and reports the
 * corpus as clean.
 */
function normalise(text: string): string {
  let out = '';
  let spaceAt = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (/\s/.test(character)) {
      if (out.length > 0 && spaceAt < 0) spaceAt = index;
      continue;
    }
    if (spaceAt >= 0) {
      out += ' ';
      spaceAt = -1;
    }
    out += character;
  }
  return out.toLowerCase();
}

/** The text a row carries, when it carries one. Mirrors the guard's reader. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

export type EchoCorpusStats = {
  readonly rows: number;
  readonly grams: number;
  readonly bits: number;
  /** Windows whose filter bits were set, then handed to exact verification. */
  readonly verifications: number;
  /** Of those, how many were false positives -- the filter's error, counted rather than assumed. */
  readonly falsePositives: number;
};

export class EchoCorpus {
  readonly width: number;
  private readonly bits: Uint32Array;
  private readonly mask: number;
  private readonly texts: string[] = [];
  /** Reused across rows so a corpus of 5,000 rows does not allocate 5,000 arrays. */
  private scratch = new Uint32Array(0);
  private gramCount = 0;
  private verifications = 0;
  private falsePositives = 0;

  private constructor(width: number, bitCount: number) {
    this.width = width;
    // Power-of-two word count so the index needs only a mask; at least one word.
    const words = 1 << Math.ceil(Math.log2(Math.max(8, Math.ceil(bitCount / 32))));
    this.bits = new Uint32Array(words);
    this.mask = words - 1;
  }

  /**
   * Build from the private rows.
   *
   * Sized from the corpus rather than grown, because growing a Bloom filter means re-inserting
   * everything: the caller has the rows, so the count is known before the first bit is set.
   */
  static from(values: readonly unknown[], options: { width?: number } = {}): EchoCorpus {
    const width = options.width ?? DEFAULT_ECHO_WIDTH;
    let windows = 0;
    for (const value of values) {
      const text = textOf(value);
      if (text === undefined) continue;
      const normal = normalise(text);
      if (normal.length >= width) windows += normal.length - width + 1;
    }

    const corpus = new EchoCorpus(width, Math.max(64, windows * BITS_PER_ENTRY));
    for (const value of values) {
      const text = textOf(value);
      if (text === undefined) continue;
      corpus.insert(normalise(text));
    }
    return corpus;
  }

  /** Whether some row contains this window. The window must already be normalised and lower-cased. */
  contains(window: string): boolean {
    if (window.length !== this.width) return false;
    if (!this.mightContain(hashWindow(window))) return false;

    this.verifications += 1;
    for (const text of this.texts) {
      if (text.includes(window)) return true;
    }
    this.falsePositives += 1;
    return false;
  }

  get stats(): EchoCorpusStats {
    return {
      rows: this.texts.length,
      grams: this.gramCount,
      bits: this.bits.byteLength * 8,
      verifications: this.verifications,
      falsePositives: this.falsePositives,
    };
  }

  private insert(text: string): void {
    this.texts.push(text);
    const needed = Math.max(0, text.length - this.width + 1);
    if (needed === 0) return;
    if (this.scratch.length < needed) this.scratch = new Uint32Array(needed);
    const count = rollingInto(text, this.width, this.scratch);
    // Inlined rather than behind a `set()` method: 766k calls cost more than the bit operations they
    // wrap, measured at 82 ms -> 71 ms for the 5,000-row corpus.
    const bits = this.bits;
    const mask = this.mask;
    for (let index = 0; index < count; index += 1) {
      const hash = this.scratch[index] as number;
      for (let k = 0; k < HASHES; k += 1) {
        const position = (hash + Math.imul(k, 0x9e3779b1)) >>> 0;
        const word = (position >>> 5) & mask;
        bits[word] = (bits[word] as number) | (1 << (position & 31));
      }
    }
    this.gramCount += count;
  }

  private mightContain(hash: number): boolean {
    for (let index = 0; index < HASHES; index += 1) {
      const position = (hash + Math.imul(index, 0x9e3779b1)) >>> 0;
      const word = (position >>> 5) & this.mask;
      if (((this.bits[word] as number) & (1 << (position & 31))) === 0) return false;
    }
    return true;
  }
}
