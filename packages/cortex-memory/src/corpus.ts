/**
 * The corpus: what the product already knows before anybody asks a question.
 *
 * ## The gap this closes
 *
 * `CortexMemory.answer(question, context)` takes its evidence as an **argument**. Every caller therefore
 * owns the transcript, and the product owns none of it — which is a fine contract for a benchmark harness
 * and a strange one for a memory library, because it means the library forgets everything between calls.
 * The same shape made two other capabilities unreachable: `DisclosureSession` was constructed over a
 * `Storage` and had no reader to give it turns, `CortexMemory` had a reader and no store, and the two had
 * zero composition. `docs/PRODUCT-CAPABILITY-LEDGER.md` rows 10, 13 and 15 are that hole.
 *
 * ## What this file does, and the one thing it does not
 *
 * It turns stored rows into the two arguments the memory already accepts — `context: string[]` and
 * `sessions: string[][]` — and nothing else. It does **not** enter prompt assembly. That is a deliberate
 * constraint rather than an accident of scope: if the stored path also assembled the prompt, "a stored
 * corpus answers the same question the same way" would degrade to "the two paths are logically similar",
 * which is not a property a test can assert. Because the corpus only produces arguments, equality is
 * `args equal => prompt equal`, and that is checkable byte for byte on `promptDigest`
 * (`corpus-equivalence.test.ts`).
 *
 * ## Identity is the triple `(sessionId, ordinal, text)`
 *
 * A row is addressed by `${sessionId}/${padded ordinal}`, so writing the same ordinal twice is a decision
 * about the identity of a turn rather than about its content. Two cases, refused differently:
 *
 * - same ordinal, same text — a **replay**. Appending a corpus twice is what a restart does, and a restart
 *   must not double the transcript. The report counts it as a duplicate and writes nothing.
 * - same ordinal, different text — **rewriting history**. Refused with an error, because every number this
 *   project has published was produced from a corpus, and a corpus that can be edited in place makes those
 *   numbers unreproducible in a way no artifact records.
 *
 * ## Why there is no `hash` field, against the design sketch
 *
 * `docs/02-technical-design.md` §22.38.2 sketched `hash: string // md5(text)` beside the text. It is not
 * here, and the reason is that it would be a **second representation of a fact the row already holds**: a
 * replay compares text to text, which is exact, and a stored digest is one more field that can disagree
 * with its own source and would then need re-verification on every read. The corpus is the one place in
 * this repository where keeping the wording is the job — a memory that cannot read its own transcript is
 * not a memory — so nothing is gained by storing a fingerprint of it as well.
 *
 * ## Why the row carries no sequence number
 *
 * Order is `(session arrival, ordinal)` and both halves live where they belong: the ordinal on the row,
 * the arrival order in the session index. A per-row `seq` would be a third statement of the same order, and
 * `Storage.query` returns rows in **no guaranteed order** (`sql.ts`: no `ORDER BY`), so an implementation
 * that trusted either the engine's order or a redundant counter would be relying on something the port
 * never promised.
 */
import type { Storage } from '@agentix-e/cortex-core';

/** Schema version. Read on every row and refused when unknown — never guessed at. */
export const CORPUS_SCHEMA = 1;

/** One turn as it is stored. */
export type StoredTurn = {
  /** Schema version; see {@link CORPUS_SCHEMA}. */
  readonly v: typeof CORPUS_SCHEMA;
  /** `${sessionId}/${padded ordinal}` — the primary key, and the whole of a turn's identity. */
  readonly id: string;
  readonly sessionId: string;
  /** Position inside its session, from 0. */
  readonly ordinal: number;
  readonly text: string;
  /** When the turn happened, on the corpus clock. Never read from `Date.now()` inside a method. */
  readonly at: number;
};

/** One turn as a caller offers it. */
export type CorpusTurn = {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly text: string;
  /** Absent means the corpus clock at the moment of the append. */
  readonly at?: number;
};

/** What an append did. `appended + duplicates` equals the number of turns offered. */
export type AppendReport = {
  readonly appended: number;
  readonly duplicates: number;
};

/**
 * The `(sessionId, ordinal)` index, one row per session.
 *
 * ## Why an index and not a key prefix scan
 *
 * `Storage.query`'s `keyPrefix` is applied after the rows are materialised (`selectPage`), so it bounds
 * the result and not the work. Reading one session through a prefix would therefore cost a full scan of
 * the corpus, which is the read amplification this table exists to avoid: `session(id)` reads one index
 * row and then exactly as many turn rows as that session holds.
 *
 * `ordinals` is the second key of the secondary index and it is also the reason the row is a list rather
 * than a `(sessionId, ordinal) -> id` map: a per-ordinal row would need one more full-table read per
 * session, and the list is what makes `session(id)` a bounded number of point lookups.
 *
 * `seq` is the session's arrival order, assigned once when its first turn is appended and kept until the
 * session is empty. It is what makes `sessions()` reproducible across backends: nothing else in the store
 * records which session came first.
 */
export type CorpusSessionRow = {
  readonly sessionId: string;
  readonly seq: number;
  readonly ordinals: readonly number[];
};

/** The one counter the corpus keeps: how many sessions have ever existed. */
type CorpusHead = { readonly sessions: number };

export type CorpusOptions = {
  /** Where the rows go. Any `Storage`: SQLite and PostgreSQL in Node, OPFS and IndexedDB in a browser. */
  readonly store: Storage;
  /**
   * The clock `at` falls back to. A number for a pinned run, a function for a long-lived process.
   *
   * Defaults to `Date.now`, and this is the **only** place in the corpus where the wall clock is read: a
   * row's `at` is data that decides nothing, but a method that called `Date.now()` directly would make the
   * corpus untestable in the way admission values already are (`types.ts` records the same reasoning for
   * `CortexMemoryOptions.now`).
   */
  readonly now?: number | (() => number) | undefined;
  /** Table prefix. Defaults to `corpus`; two corpora can share a store by naming different prefixes. */
  readonly table?: string | undefined;
};

/** What went wrong, by kind, so a caller can tell an input mistake from a corrupted store. */
export type CorpusErrorCode = 'input' | 'rewrite' | 'schema';

export class CorpusError extends Error {
  readonly code: CorpusErrorCode;

  constructor(code: CorpusErrorCode, message: string) {
    super(message);
    this.name = 'CorpusError';
    this.code = code;
  }
}

/** The key of one turn. Padded so a lexicographic read of the key space is also the ordinal order. */
export function turnId(sessionId: string, ordinal: number): string {
  return `${sessionId}/${String(ordinal).padStart(6, '0')}`;
}

/**
 * The corpus.
 *
 * Append-only except for erasure. There is no `update`: a turn is a record of something a person said, and
 * the only edit that is true to that is to make it read differently than it did, which is the one thing the
 * identity check refuses.
 */
export class Corpus {
  readonly #store: Storage;
  readonly #clock: () => number;
  readonly #turns: string;
  readonly #sessions: string;
  readonly #meta: string;

  constructor(options: CorpusOptions) {
    this.#store = options.store;
    const table = options.table ?? 'corpus';
    this.#turns = `${table}.turn`;
    this.#sessions = `${table}.session`;
    this.#meta = `${table}.meta`;
    const now = options.now;
    this.#clock = typeof now === 'function' ? now : () => now ?? Date.now();
  }

  /**
   * Append turns, reporting what was new.
   *
   * The whole batch is one transaction: a crash between the turn row and the index row would leave a turn
   * that `sessions()` cannot place, and `sessions()` is what the answer path reads. The reads that decide
   * duplicates happen **inside** it for the same reason — a duplicate decided outside the transaction is a
   * race with whatever else is appending, and the product's own restart path is exactly two appends.
   */
  async append(turns: readonly CorpusTurn[]): Promise<AppendReport> {
    if (turns.length === 0) return { appended: 0, duplicates: 0 };

    const at = this.#clock();
    const prepared = turns.map((turn) => this.#prepare(turn, at));
    // Within a batch, too: two turns with one identity and two texts is the same rewrite as across two
    // batches, and a batch is the unit a caller can construct by accident.
    const seen = new Map<string, string>();
    for (const turn of prepared) {
      const text = seen.get(turn.id);
      if (text !== undefined && text !== turn.text) throw this.#rewrite(turn, text);
      seen.set(turn.id, turn.text);
    }

    return this.#store.transaction(async (tx) => {
      const head = (await tx.get<CorpusHead>(this.#meta, 'head')) ?? { sessions: 0 };
      let sessions = head.sessions;
      let appended = 0;
      let duplicates = 0;
      // One session row per distinct session in the batch, written once at the end: a batch of two hundred
      // turns of one session would otherwise rewrite the same list two hundred times.
      const touched = new Map<string, { seq: number; ordinals: number[] }>();

      for (const turn of prepared) {
        const existing = await tx.get<StoredTurn>(this.#turns, turn.id);
        if (existing !== undefined) {
          this.#assertRow(existing, turn.id);
          if (existing.text !== turn.text) throw this.#rewrite(turn, existing.text);
          duplicates += 1;
          continue;
        }
        await tx.put(this.#turns, turn.id, turn);
        let row = touched.get(turn.sessionId);
        if (row === undefined) {
          const stored = await tx.get<CorpusSessionRow>(this.#sessions, turn.sessionId);
          row =
            stored === undefined
              ? // Post-increment on a fresh session only: a session that already arrived keeps its place in
                // the sequence even if its turns are appended one at a time over hours.
                { seq: sessions++, ordinals: [] }
              : { seq: stored.seq, ordinals: [...stored.ordinals] };
          touched.set(turn.sessionId, row);
        }
        row.ordinals.push(turn.ordinal);
        appended += 1;
      }

      for (const [sessionId, row] of touched) {
        await tx.put(this.#sessions, sessionId, {
          sessionId,
          seq: row.seq,
          ordinals: row.ordinals,
        });
      }
      await tx.put(this.#meta, 'head', { sessions });
      return { appended, duplicates };
    });
  }

  /** Every turn, ordered by session arrival and then by ordinal. */
  async turns(): Promise<StoredTurn[]> {
    return (await this.#placed()).turns;
  }

  /** The flat view: what `answer(question, context)` receives. */
  async context(): Promise<string[]> {
    const sessions = await this.sessions();
    const flat: string[] = [];
    for (const session of sessions) flat.push(...session);
    return flat;
  }

  /**
   * The grouped view: what `answerSessions(question, sessions)` receives.
   *
   * Grouping by first appearance in the ordered list, rather than by sorting the array of session ids, is
   * what keeps a session's turns contiguous when two sessions' appends interleave: the order that matters is
   * the order the person had the conversations in, and that is `seq`.
   */
  async sessions(): Promise<string[][]> {
    const ordered = await this.turns();
    const grouped = new Map<string, string[]>();
    for (const turn of ordered) {
      const existing = grouped.get(turn.sessionId);
      if (existing === undefined) grouped.set(turn.sessionId, [turn.text]);
      else existing.push(turn.text);
    }
    return [...grouped.values()];
  }

  /** One session's turns in ordinal order, or `undefined` when the corpus holds no such session. */
  async session(sessionId: string): Promise<string[] | undefined> {
    const row = await this.#store.get<CorpusSessionRow>(this.#sessions, sessionId);
    if (row === undefined) return undefined;
    const ordinals = [...row.ordinals].sort((left, right) => left - right);
    const texts: string[] = [];
    for (const ordinal of ordinals) {
      const id = turnId(sessionId, ordinal);
      const turn = await this.#store.get<StoredTurn>(this.#turns, id);
      // A missing turn under a present index row is a corrupted store, not an empty session. Returning a
      // short list here would move every later ordinal by one and answer a question from the wrong turn.
      if (turn === undefined) {
        throw new CorpusError(
          'schema',
          `session ${JSON.stringify(sessionId)} indexes ordinal ${String(ordinal)} but ${id} is absent`,
        );
      }
      this.#assertRow(turn, id);
      texts.push(turn.text);
    }
    return texts;
  }

  /** One turn by id. */
  async turn(id: string): Promise<StoredTurn | undefined> {
    const turn = await this.#store.get<StoredTurn>(this.#turns, id);
    if (turn !== undefined) this.#assertRow(turn, id);
    return turn;
  }

  /** How many turns the corpus holds. */
  async size(): Promise<number> {
    return (await this.#store.query<StoredTurn>(this.#turns)).length;
  }

  /**
   * Erase every turn whose text is one of these.
   *
   * ## Why the match is on text and not on identity
   *
   * Because erasure is a statement about a **sentence**, not about a row. The disclosure boundary erases the
   * wording it holds — a card's text and the turn it was cut from — and the corpus is a second copy of that
   * wording under an identity the boundary never saw. Deleting by `(sessionId, ordinal)` would require the
   * eraser to know which corpus turns a card came from, which nothing records; matching the text is exactly
   * the statement the product promises and exactly what the census can check afterwards.
   *
   * ## Why a scan is acceptable here
   *
   * A scan is O(corpus) and this is the only method that pays one. The alternative — a hash index per text —
   * would be a second structure to keep in step for an operation that runs when somebody withdraws a
   * sentence, which is rare by construction and must be thorough rather than fast. The cost is bounded by
   * the same wall the read path already sits against, and it is measured in
   * `tools/corpus-read-census.mjs`.
   *
   * ## What it leaves behind
   *
   * Nothing readable. A session whose last turn is erased loses its index row too, rather than keeping a row
   * with an empty ordinal list: an auditor counting sessions would otherwise count a conversation nobody can
   * read. The `head` counter is deliberately not rewound — sequence numbers are never reused, so a session
   * appended after an erasure sorts after the ones that survive, which is the truth about when it happened.
   */
  async forget(texts: readonly string[]): Promise<number> {
    // `#placed` is what makes "every doomed turn's session has an index row" true *before* the transaction
    // starts: it refuses a corpus it cannot place, so the write below never has to decide what to do with a
    // half-known session -- a decision that would have been one line of a guard nothing could reach.
    const { doomed, index } = await this.#matching(texts);
    if (doomed.length === 0) return 0;

    const perSession = new Map<string, Set<number>>();
    for (const turn of doomed) {
      const erased = perSession.get(turn.sessionId);
      if (erased === undefined) perSession.set(turn.sessionId, new Set([turn.ordinal]));
      else erased.add(turn.ordinal);
    }

    await this.#store.transaction(async (tx) => {
      for (const turn of doomed) await tx.del(this.#turns, turn.id);
      for (const [sessionId, row] of index) {
        const erased = perSession.get(sessionId);
        if (erased === undefined) continue;
        const ordinals = row.ordinals.filter((ordinal) => !erased.has(ordinal));
        if (ordinals.length === 0) await tx.del(this.#sessions, sessionId);
        else await tx.put(this.#sessions, sessionId, { sessionId, seq: row.seq, ordinals });
      }
    });
    return doomed.length;
  }

  /**
   * How many turns hold one of these texts.
   *
   * Read for the consent prompt, never to decide anything: `forget` re-derives the set it acts on rather than
   * trusting a count taken earlier, because a number that decides an erasure is a number an interruption can
   * make wrong.
   */
  async held(texts: readonly string[]): Promise<number> {
    return (await this.#matching(texts)).doomed.length;
  }

  /** The turns holding one of these texts, with the index that places them. */
  async #matching(texts: readonly string[]): Promise<{
    doomed: StoredTurn[];
    index: Map<string, CorpusSessionRow>;
  }> {
    if (texts.length === 0) return { doomed: [], index: new Map() };
    const wanted = new Set(texts);
    const { turns, index } = await this.#placed();
    return { doomed: turns.filter((turn) => wanted.has(turn.text)), index };
  }

  /**
   * Read the whole corpus and place every turn in order.
   *
   * Two reads in parallel rather than a read per turn: `query` is the only bulk operation the port has, and
   * the alternative -- an index lookup per id -- is a round trip per row.
   *
   * The placement happens **before** the sort rather than inside the comparator. A comparator that looked the
   * session up mid-sort would leave the "no index row" refusal unreached on a corpus of one row, because
   * `Array.prototype.sort` does not compare a single element -- so the guard would fire on large corpora and
   * pass on small ones, which is the worst possible distribution for a guard.
   */
  async #placed(): Promise<{ turns: StoredTurn[]; index: Map<string, CorpusSessionRow> }> {
    const [rows, sessions] = await Promise.all([
      this.#store.query<StoredTurn>(this.#turns),
      this.#store.query<CorpusSessionRow>(this.#sessions),
    ]);
    const index = new Map<string, CorpusSessionRow>();
    for (const session of sessions) index.set(session.sessionId, session);
    const placed = rows.map((row) => {
      this.#assertRow(row, row.id);
      return { row, seq: this.#seqIn(index, row) };
    });
    placed.sort((left, right) =>
      left.seq === right.seq ? left.row.ordinal - right.row.ordinal : left.seq - right.seq,
    );
    return { turns: placed.map((entry) => entry.row), index };
  }

  /** Validate and key one offered turn. */
  #prepare(turn: CorpusTurn, at: number): StoredTurn {
    if (turn.sessionId === '') {
      throw new CorpusError(
        'input',
        'a turn needs a sessionId: an unnamed session cannot be ordered against the others, and its turns ' +
          'would sort by ordinal against every other unnamed session in the corpus',
      );
    }
    if (!Number.isInteger(turn.ordinal) || turn.ordinal < 0) {
      throw new CorpusError(
        'input',
        `ordinal must be a non-negative integer, got ${String(turn.ordinal)}: the identity of a turn is its ` +
          'position in its session, and a fractional or negative position names no turn',
      );
    }
    return {
      v: CORPUS_SCHEMA,
      id: turnId(turn.sessionId, turn.ordinal),
      sessionId: turn.sessionId,
      ordinal: turn.ordinal,
      text: turn.text,
      at: turn.at ?? at,
    };
  }

  /** The session's arrival order; refuse to guess when a session has no index row. */
  #seqIn(index: ReadonlyMap<string, CorpusSessionRow>, turn: StoredTurn): number {
    const row = index.get(turn.sessionId);
    if (row === undefined) {
      throw new CorpusError(
        'schema',
        `turn ${turn.id} names session ${JSON.stringify(turn.sessionId)}, which has no index row: the corpus ` +
          'cannot place it, and guessing an order would silently reorder the transcript',
      );
    }
    return row.seq;
  }

  /** Refuse a row this build cannot read, by version, before anything reads its fields. */
  #assertRow(row: StoredTurn, id: string): void {
    if (row.v !== CORPUS_SCHEMA) {
      throw new CorpusError(
        'schema',
        `turn ${id} is schema version ${String(row.v)} and this build reads version ${String(CORPUS_SCHEMA)}: ` +
          'a newer corpus may place meaning on a field this build would ignore, so it is refused rather ' +
          'than read as if it were older',
      );
    }
  }

  #rewrite(turn: StoredTurn, held: string): CorpusError {
    return new CorpusError(
      'rewrite',
      `turn ${turn.id} already holds different text (${String(held.length)} chars, offered ` +
        `${String(turn.text.length)}): the identity of a turn is its position, so replacing its content ` +
        'rewrites the transcript every published reading was taken from. Append the correction as a new ' +
        'turn, or choose an ordinal that is not taken',
    );
  }
}
