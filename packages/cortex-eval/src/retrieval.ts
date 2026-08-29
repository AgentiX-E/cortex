/**
 * Shared retrieval primitives for natural-language memory. Keeping a single
 * retrieval implementation (bounded-batch embedding + per-question index +
 * cosine search) removes code drift between the benchmark system and the
 * diagnostics harness, so any remaining score discrepancy can only come from the
 * embedding provider rather than from divergent retrieval logic.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { BruteForceVectorIndex } from '@agentix-e/cortex-core';

/** Zhipu embedding-3 accepts at most 64 inputs per request. */
const EMBED_BATCH = 64;

/** Shared cache of embedding vectors keyed by source text. */
const embeddingCache = new Map<string, Float64Array>();

/** Clear the shared embedding cache (used by tests and long-running processes). */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

/** Return a snapshot of the shared embedding cache for persistence. */
export function snapshotEmbeddingCache(): Map<string, Float64Array> {
  return new Map(embeddingCache);
}

/**
 * Merge persisted vectors into the shared cache. Entries already present are
 * kept (the in-memory copy is authoritative), so loading a stale cache cannot
 * override vectors computed in this run.
 */
export function mergeEmbeddingCache(entries: ReadonlyMap<string, Float64Array>): void {
  for (const [text, vector] of entries) {
    if (!embeddingCache.has(text)) {
      embeddingCache.set(text, vector);
    }
  }
}

/** Stable 32-bit string hash used only for internal vector-index ids. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Embed many texts in bounded batches, reusing cached vectors. */
export async function embedManyCached(
  embedding: EmbeddingModel,
  texts: string[],
): Promise<Float64Array[]> {
  const result = new Array<Float64Array>(texts.length);
  const missing: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = embeddingCache.get(texts[i]!);
    if (cached) {
      result[i] = cached;
    } else {
      missing.push(i);
    }
  }
  for (let start = 0; start < missing.length; start += EMBED_BATCH) {
    const chunk = missing.slice(start, start + EMBED_BATCH);
    const vectors = await embedding.embed(chunk.map((i) => texts[i]!));
    for (let j = 0; j < chunk.length; j++) {
      const idx = chunk[j]!;
      const vector = vectors[j] ?? new Float64Array(0);
      embeddingCache.set(texts[idx]!, vector);
      result[idx] = vector;
    }
  }
  return result;
}

/** Embed a single text via the shared cache. */
export async function embedOneCached(
  embedding: EmbeddingModel,
  text: string,
): Promise<Float64Array> {
  return (await embedManyCached(embedding, [text]))[0]!;
}

/** Binary magic for the persisted embedding cache ("EMBC" big-endian). */
const EMBEDDING_CACHE_MAGIC = 0x454d4243;
/** Format version; bump when the binary layout changes. */
const EMBEDDING_CACHE_VERSION = 1;

/**
 * Serialize a text→vector cache into a compact binary buffer. Vectors are
 * stored as float32 (the native precision of the embedding API) rather than the
 * float64 they are held in, halving the payload while keeping the error well
 * below what cosine similarity can notice. The cache is deterministic at
 * temperature 0, so persisting it lets a later benchmark run reuse the same
 * haystack-turn embeddings instead of re-calling the embedding provider.
 */
export function serializeEmbeddingCache(cache: ReadonlyMap<string, Float64Array>): Uint8Array {
  const entries: { text: Buffer; vector: Float32Array }[] = [];
  let dim = 0;
  let payloadBytes = 0;
  for (const [text, vector] of cache) {
    if (dim === 0) {
      dim = vector.length;
    }
    const textBuf = Buffer.from(text, 'utf8');
    entries.push({ text: textBuf, vector: Float32Array.from(vector) });
    payloadBytes += 4 + textBuf.length + vector.length * 4;
  }
  const buf = Buffer.alloc(13 + payloadBytes); // magic(4) + version(1) + count(4) + dim(4)
  let offset = 0;
  buf.writeUInt32BE(EMBEDDING_CACHE_MAGIC, offset);
  offset += 4;
  buf.writeUInt8(EMBEDDING_CACHE_VERSION, offset);
  offset += 1;
  buf.writeUInt32LE(entries.length, offset);
  offset += 4;
  buf.writeUInt32LE(dim, offset);
  offset += 4;
  for (const { text, vector } of entries) {
    buf.writeUInt32LE(text.length, offset);
    offset += 4;
    text.copy(buf, offset);
    offset += text.length;
    for (let i = 0; i < vector.length; i++) {
      buf.writeFloatLE(vector[i]!, offset);
      offset += 4;
    }
  }
  return new Uint8Array(buf);
}

/**
 * Deserialize a binary buffer produced by `serializeEmbeddingCache` back into a
 * text→vector Map (vectors are widened from float32 to float64 to match the
 * in-memory representation). Throws on a corrupt or incompatible buffer so a
 * stale cache is never silently trusted.
 */
export function deserializeEmbeddingCache(data: Uint8Array): Map<string, Float64Array> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const magic = buf.readUInt32BE(offset);
  offset += 4;
  if (magic !== EMBEDDING_CACHE_MAGIC) {
    throw new Error(`invalid embedding cache magic: 0x${magic.toString(16)}`);
  }
  const version = buf.readUInt8(offset);
  offset += 1;
  if (version !== EMBEDDING_CACHE_VERSION) {
    throw new Error(`unsupported embedding cache version: ${version}`);
  }
  const count = buf.readUInt32LE(offset);
  offset += 4;
  const dim = buf.readUInt32LE(offset);
  offset += 4;
  const cache = new Map<string, Float64Array>();
  for (let i = 0; i < count; i++) {
    const textLen = buf.readUInt32LE(offset);
    offset += 4;
    const text = buf.toString('utf8', offset, offset + textLen);
    offset += textLen;
    const vector = new Float64Array(dim);
    for (let j = 0; j < dim; j++) {
      vector[j] = buf.readFloatLE(offset);
      offset += 4;
    }
    cache.set(text, vector);
  }
  return cache;
}

export type RetrievalHit = {
  id: string;
  text: string;
  score: number;
  /** Position of this turn in the original `context` array. */
  index: number;
};

/** A per-call vector index over a question's turns plus the lookup tables. */
type TurnIndex = {
  index: BruteForceVectorIndex;
  texts: Map<string, string>;
  idToIndex: Map<string, number>;
};

/**
 * Build a per-question index over `context`. The index is rebuilt on every call
 * so state never leaks across LongMemEval questions (which have independent
 * haystacks); uncached turns are embedded once in bounded batches.
 */
async function buildTurnIndex(embedding: EmbeddingModel, context: string[]): Promise<TurnIndex> {
  const index = new BruteForceVectorIndex();
  const texts = new Map<string, string>();
  const idToIndex = new Map<string, number>();

  const pending: string[] = [];
  for (let i = 0; i < context.length; i++) {
    const turn = context[i]!;
    const id = `t-${hashText(turn)}`;
    if (!texts.has(id)) {
      pending.push(turn);
      idToIndex.set(id, i);
    }
  }
  if (pending.length > 0) {
    const vectors = await embedManyCached(embedding, pending);
    for (let i = 0; i < pending.length; i++) {
      const turn = pending[i]!;
      const id = `t-${hashText(turn)}`;
      await index.add(id, vectors[i]!);
      texts.set(id, turn);
    }
  }
  return { index, texts, idToIndex };
}

/** Search a prebuilt turn index with a precomputed query vector (no API calls). */
async function searchTurnIndex(
  data: TurnIndex,
  queryVec: Float64Array,
  topK: number,
): Promise<RetrievalHit[]> {
  const hits = await data.index.search(queryVec, topK);
  // Every hit id was inserted via `texts.set`, so the lookups are always defined.
  return hits.map((h) => ({
    id: h.id,
    text: data.texts.get(h.id)!,
    score: h.score,
    index: data.idToIndex.get(h.id) ?? -1,
  }));
}

/**
 * Build a per-question index over `context` and return the top-k turns for
 * `question`. The index is rebuilt on every call so state never leaks across
 * LongMemEval questions (which have independent haystacks).
 */
export async function retrieveTopK(
  embedding: EmbeddingModel,
  question: string,
  context: string[],
  topK: number,
): Promise<RetrievalHit[]> {
  const data = await buildTurnIndex(embedding, context);
  const queryVec = await embedOneCached(embedding, question);
  return searchTurnIndex(data, queryVec, topK);
}

/**
 * Expand a set of retrieved turn indices into a coherent context window: return
 * the turns at `indices` plus up to `radius` neighbours on each side, preserving
 * order and de-duplicating overlaps.
 */
export function expandContextWindow(context: string[], indices: number[], radius: number): string {
  const selected = new Set<number>();
  for (const idx of indices) {
    if (idx < 0 || idx >= context.length) {
      continue;
    }
    const start = Math.max(0, idx - radius);
    const end = Math.min(context.length - 1, idx + radius);
    for (let j = start; j <= end; j++) {
      selected.add(j);
    }
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => context[i]!)
    .join('\n');
}

/** Mean-pool a list of equal-length vectors into a single centroid vector. */
export function meanPool(vectors: readonly Float64Array[]): Float64Array {
  if (vectors.length === 0) {
    return new Float64Array(0);
  }
  const dim = vectors[0]!.length;
  const sum = new Float64Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] = sum[i]! + v[i]!;
    }
  }
  for (let i = 0; i < dim; i++) {
    sum[i] = sum[i]! / vectors.length;
  }
  return sum;
}

export type SessionHit = {
  id: string;
  /** Index of this session in the input `sessions` array. */
  sessionIndex: number;
  /** The full session text (all turns joined). */
  text: string;
  score: number;
};

/** A per-call vector index over session centroids plus the lookup tables. */
type SessionIndex = {
  index: BruteForceVectorIndex;
  texts: Map<string, string>;
  idToSession: Map<string, number>;
};

/**
 * Build a session-centroid index over `sessions`. Turns are flattened once so a
 * single batched embedding pass covers every session; each session is then
 * represented by the mean of its turn vectors.
 */
async function buildSessionIndex(
  embedding: EmbeddingModel,
  sessions: string[][],
): Promise<SessionIndex> {
  const flat: string[] = [];
  const bounds: number[] = [0];
  for (const session of sessions) {
    flat.push(...session);
    bounds.push(flat.length);
  }

  const vectors = flat.length > 0 ? await embedManyCached(embedding, flat) : [];
  const index = new BruteForceVectorIndex();
  const texts = new Map<string, string>();
  const idToSession = new Map<string, number>();

  for (let s = 0; s < sessions.length; s++) {
    const session = sessions[s]!;
    if (session.length === 0) {
      continue;
    }
    const sessionVec = meanPool(vectors.slice(bounds[s], bounds[s + 1]));
    if (sessionVec.length === 0) {
      continue;
    }
    const id = `s-${hashText(session.join('\n'))}`;
    await index.add(id, sessionVec);
    texts.set(id, session.join('\n'));
    idToSession.set(id, s);
  }
  return { index, texts, idToSession };
}

/** Search a prebuilt session index with a precomputed query vector (no API calls). */
async function searchSessionIndex(
  data: SessionIndex,
  queryVec: Float64Array,
  topK: number,
): Promise<SessionHit[]> {
  if (data.texts.size === 0) {
    return [];
  }
  const hits = await data.index.search(queryVec, topK);
  // Every hit id was inserted via `texts.set`, so the lookups are always defined.
  return hits.map((h) => ({
    id: h.id,
    sessionIndex: data.idToSession.get(h.id) ?? -1,
    text: data.texts.get(h.id)!,
    score: h.score,
  }));
}

/**
 * Session-level retrieval: represent each session by the mean of its turn
 * embeddings, index those session centroids, and return the top-k sessions for
 * `question`. Retrieving whole sessions (rather than isolated turns) lets a
 * multi-session question aggregate evidence that is spread across sessions.
 */
export async function retrieveTopKSessions(
  embedding: EmbeddingModel,
  question: string,
  sessions: string[][],
  topK: number,
): Promise<SessionHit[]> {
  const data = await buildSessionIndex(embedding, sessions);
  const queryVec = await embedOneCached(embedding, question);
  return searchSessionIndex(data, queryVec, topK);
}

/**
 * Multi-query targeted recall: retrieve sessions for each query independently
 * and merge the results by session id, keeping the highest score. Query expansion
 * turns an abstract question (e.g. "items of clothing") into concrete phrases
 * (e.g. "blazer", "dress") so dispersed evidence sessions are recalled even when
 * the abstract question alone ranks them too low. All queries are embedded in one
 * batched pass instead of one request per query, so expanding to N phrases costs
 * a single (bounded-batch) embedding request rather than N.
 */
export async function retrieveByQueries(
  embedding: EmbeddingModel,
  queries: string[],
  sessions: string[][],
  topKPerQuery: number,
): Promise<SessionHit[]> {
  const data = await buildSessionIndex(embedding, sessions);
  const queryVecs = await embedManyCached(embedding, queries);
  const bestById = new Map<string, SessionHit>();
  for (let i = 0; i < queries.length; i++) {
    const hits = await searchSessionIndex(data, queryVecs[i]!, topKPerQuery);
    for (const hit of hits) {
      const existing = bestById.get(hit.id);
      if (!existing || hit.score > existing.score) {
        bestById.set(hit.id, hit);
      }
    }
  }
  return [...bestById.values()].sort((a, b) => b.score - a.score);
}

/**
 * Turn-level analogue of `retrieveByQueries`: retrieve the top-k turns for each
 * query independently, merge them by turn id keeping the highest score, then cap
 * the merged result to `topK` total. The single-session path suffers the same
 * dispersed-evidence problem as MR — a temporal question ("How many weeks ago
 * did I receive the crystal chandelier?") ranks the specific chandelier turn
 * below unrelated but semantically similar distractors — so expanding into
 * concrete phrases and searching each phrase recovers the answer turn that the
 * abstract question alone misses. The total cap keeps the injected context at
 * the same size as a single-query `retrieveTopK` instead of letting N queries
 * multiply the context and dilute the answer signal. Queries are embedded in one
 * batched pass for the same reason as `retrieveByQueries`.
 */
export async function retrieveTopKByQueries(
  embedding: EmbeddingModel,
  queries: string[],
  context: string[],
  topK: number,
): Promise<RetrievalHit[]> {
  const data = await buildTurnIndex(embedding, context);
  const queryVecs = await embedManyCached(embedding, queries);
  const bestById = new Map<string, RetrievalHit>();
  for (let i = 0; i < queries.length; i++) {
    const hits = await searchTurnIndex(data, queryVecs[i]!, topK);
    for (const hit of hits) {
      const existing = bestById.get(hit.id);
      if (!existing || hit.score > existing.score) {
        bestById.set(hit.id, hit);
      }
    }
  }
  return [...bestById.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}
