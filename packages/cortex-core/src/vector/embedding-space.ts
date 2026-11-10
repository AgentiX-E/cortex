/**
 * A vector index with the model that wrote it bound to it.
 *
 * ## The defect this closes
 *
 * `VectorIndex` and `EmbeddingModel` are separate abstractions, and neither of them records who
 * produced a vector. `cosineSimilarity` refuses two widths (`dot` throws on a length mismatch), so
 * the *width* half of a substitution is already loud — but the width is the one field two unrelated
 * models are most likely to share. A 1024-dimension Zhipu `embedding-3` vector and a 1024-dimension
 * vector from a local model of the same size are numerically comparable and semantically unrelated:
 * every add succeeds, every search returns `k` hits, every score is a number in `[-1, 1]`, and the
 * ranking is noise. The offline fallback this repository ships — a 256-dimension hash embedding —
 * is the case that fails loudly, and a same-width fallback is the case that fails silently.
 *
 * The measurement harness already refuses this at its own boundary (`EmbeddingCacheProvenanceError`,
 * `cortex-eval/src/retrieval.ts`), which is the right check in the wrong layer: it protects the
 * benchmark's cache file, not a deployment's index. This class moves the check to the abstraction
 * the product publishes.
 *
 * ## Where the stored space comes from, and why it is a required statement
 *
 * An index does not carry its own provenance — its entries are `Float64Array`s and per-entry
 * metadata the caller chose. So the space the existing contents were written with has to be
 * *stated* by the caller that knows it, as `stored`. Three rules follow, and each of them is a
 * refusal rather than a default:
 *
 * 1. **A non-empty index with no stated space is refused**, even when the model names itself.
 *    "I am X" is not evidence that the index was written by X, and assuming it is the silent
 *    substitution itself. Refusing costs a caller nothing at open time on a fresh index, which is
 *    the only case where the space is genuinely unknown to nobody.
 * 2. **A stated space with a model that cannot say who it is, is refused.** The alternative is
 *    checking the statement against nothing.
 * 3. **A stated space that differs from the model is refused**, naming every field that differs.
 *
 * The space to persist is `space.identity`, which is `null` only for an empty index opened by a
 * model that does not name itself — the one state in which there is nothing to compare.
 */

import type { EmbeddingIdentity, EmbeddingModel } from '../interfaces/embedding.js';
import type { VectorFilter, VectorHit, VectorIndex } from '../interfaces/vector.js';

/** Why a space refused an operation. One discriminant per condition, so a caller can branch. */
export type EmbeddingSpaceRefusal =
  /** The index is non-empty and the caller did not state which model wrote it. */
  | 'unstated'
  /** The caller stated a space, and the model does not name itself. */
  | 'unidentifiable'
  /** The stated space and the model's own identity differ. */
  | 'mismatch'
  /** A vector's width is not the space's width, or the model contradicts its own `dimension()`. */
  | 'width'
  /** The model returned a number of vectors other than the number of texts it was given. */
  | 'count';

export class EmbeddingSpaceError extends Error {
  readonly reason: EmbeddingSpaceRefusal;

  constructor(reason: EmbeddingSpaceRefusal, message: string) {
    super(message);
    this.name = 'EmbeddingSpaceError';
    this.reason = reason;
  }
}

export type EmbeddingSpaceOptions = {
  model: EmbeddingModel;
  index: VectorIndex;
  /**
   * The space the vectors already in `index` were written with.
   *
   * Required whenever `index.size() > 0`. Omit it on a fresh index; read it from `space.identity`
   * afterwards and persist it next to whatever persists the index.
   */
  stored?: EmbeddingIdentity;
};

/** One line naming a space, used in every refusal so a log is enough to diagnose it. */
function describe(identity: EmbeddingIdentity): string {
  const model = identity.model ?? '(none)';
  const endpoint = identity.endpoint ?? '(none)';
  return `${identity.provider}/${model} at ${endpoint}, ${String(identity.dimensions)} dimensions`;
}

/** The fields that differ, in the order the type declares them. */
function differingFields(a: EmbeddingIdentity, b: EmbeddingIdentity): string[] {
  const fields = ['provider', 'model', 'endpoint', 'dimensions'] as const;
  return fields.filter((field) => a[field] !== b[field]);
}

export class EmbeddingSpace {
  private readonly model: EmbeddingModel;
  private readonly index: VectorIndex;
  private readonly dimensions: number;
  private readonly space: EmbeddingIdentity | null;

  private constructor(model: EmbeddingModel, index: VectorIndex, space: EmbeddingIdentity | null) {
    this.model = model;
    this.index = index;
    this.space = space;
    this.dimensions = space?.dimensions ?? model.dimension();
  }

  /**
   * Bind a model to an index, or refuse.
   *
   * Asynchronous because the decision depends on how many vectors the index already holds, and
   * asking is the only way to tell a fresh store from a full one.
   */
  static async open(options: EmbeddingSpaceOptions): Promise<EmbeddingSpace> {
    const { model, index, stored } = options;
    const own = model.identity?.();
    const size = await index.size();

    if (own !== undefined) {
      // A model that reports a width other than the one it embeds at is a defect in the model, not
      // a mismatch with a store: caught here because every later width check trusts `dimensions`.
      if (own.dimensions !== model.dimension()) {
        throw new EmbeddingSpaceError(
          'width',
          `embedding model says ${String(own.dimensions)} dimensions in its identity but ` +
            `${String(model.dimension())} in dimension(); one of the two is wrong and the space ` +
            `cannot be built on an answer that disagrees with itself`,
        );
      }
    }

    // Checked before the model's own identity, because a model that names itself does not answer the
    // question being asked. An index holding vectors and a model that says "I am X" is not evidence
    // that the index was written by X, and treating it as such is the substitution itself.
    if (size > 0 && stored === undefined) {
      throw new EmbeddingSpaceError(
        'unstated',
        `the index holds ${String(size)} vector(s) and the caller did not state which model wrote ` +
          `them; a store whose space is unknown cannot be queried, because every score would be a ` +
          `comparison nobody can name. Pass \`stored\` with the space the index was built in, or ` +
          `open an empty index`,
      );
    }

    if (stored !== undefined) {
      if (own === undefined) {
        throw new EmbeddingSpaceError(
          'unidentifiable',
          `the store was stated as written by ${describe(stored)} but the model does not report ` +
            `its own identity; a statement that nothing can check is not a guard`,
        );
      }
      const differing = differingFields(own, stored);
      if (differing.length > 0) {
        throw new EmbeddingSpaceError(
          'mismatch',
          `the index was written by ${describe(stored)} but this run embeds with ${describe(own)}; ` +
            `differing: ${differing.join(', ')}. Querying it would return k hits scored between two ` +
            `spaces, which is noise with no error to see`,
        );
      }
    }

    return new EmbeddingSpace(model, index, own ?? null);
  }

  /**
   * The space this index is in, to persist beside it; `null` for an empty index whose model does not
   * name itself.
   */
  get identity(): EmbeddingIdentity | null {
    return this.space;
  }

  /** How many vectors the index holds. */
  async size(): Promise<number> {
    return this.index.size();
  }

  /**
   * Embed texts, checking that the model returned what it was asked for, at the width it declared.
   *
   * Both checks are about the model rather than about the store, and they are here because every
   * later decision — including the index's own search — assumes them. A short array would silently
   * shift the correspondence between vectors and texts in any caller that indexes by position.
   */
  async embed(texts: readonly string[]): Promise<Float64Array[]> {
    const vectors = await this.model.embed([...texts]);
    if (vectors.length !== texts.length) {
      throw new EmbeddingSpaceError(
        'count',
        `embedding model returned ${String(vectors.length)} vector(s) for ${String(texts.length)} ` +
          `text(s); position is the only link between them, so a short list is a silent shift`,
      );
    }
    this.checkWidth(vectors);
    return vectors;
  }

  /** Reject a vector whose width is not this space's, naming the space that says so. */
  private checkWidth(vectors: readonly Float64Array[]): void {
    for (const [position, vector] of vectors.entries()) {
      if (vector.length !== this.dimensions) {
        throw new EmbeddingSpaceError(
          'width',
          `vector ${String(position)} has ${String(vector.length)} dimensions where this space is ` +
            `${String(this.dimensions)}; ${this.space === null ? 'the model' : describe(this.space)}`,
        );
      }
    }
  }

  /** Embed one text and add it to the index under `id`. */
  async add(id: string, text: string, meta?: unknown): Promise<void> {
    const [vector] = await this.embed([text]);
    await this.index.add(id, vector as Float64Array, meta);
  }

  /**
   * Add a vector the caller already embedded through this space's model.
   *
   * The batched callers — anything that embeds a hundred turns per request to respect a provider's
   * cap — cannot use `add`, and would otherwise reach the index directly and lose the width check on
   * the one path that produces most of the vectors. The width is the only property a vector can be
   * checked against after the fact; the space it belongs to is fixed at `open` and cannot be
   * re-stated here.
   */
  async addVector(id: string, vector: Float64Array, meta?: unknown): Promise<void> {
    this.checkWidth([vector]);
    await this.index.add(id, vector, meta);
  }

  /** Embed a query and search the index in that same space. */
  async search(text: string, k: number, filter?: VectorFilter): Promise<VectorHit[]> {
    const [query] = await this.embed([text]);
    return this.index.search(query as Float64Array, k, filter);
  }

  /** Search with a query vector the caller already embedded through this space's model. */
  async searchVector(vector: Float64Array, k: number, filter?: VectorFilter): Promise<VectorHit[]> {
    this.checkWidth([vector]);
    return this.index.search(vector, k, filter);
  }
}
