/**
 * Embedding stub backed by an explicit text→vector table, so a test can place a
 * query and a set of turns at exact angles.
 *
 * Hash embedding is fine for smoke tests but useless for retrieval geometry:
 * mean-pool dilution is a trigonometric fact, not a statistical tendency, so a
 * test that claims "the centroid lost this session" has to compute the cosine
 * exactly. With `n` turns orthogonal to the query, a session centroid's cosine
 * collapses by roughly sqrt(n) — this stub reproduces that deterministically.
 *
 * Texts absent from the table embed to the zero vector (cosine 0 against
 * everything), which keeps unknown inputs inert instead of noisy.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';

export function tableEmbedding(
  table: Readonly<Record<string, readonly number[]>>,
  dim: number,
): EmbeddingModel {
  return {
    dimension: () => dim,
    embed: async (texts) =>
      texts.map((t) => new Float64Array(table[t] ?? new Array<number>(dim).fill(0))),
  };
}
