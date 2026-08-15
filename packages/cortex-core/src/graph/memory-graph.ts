/**
 * Associative memory graph, self-implemented as an undirected adjacency list with
 * Float64 edge weights. This is a core cognitive algorithm (not a generic graph
 * utility), so we own it end-to-end for full precision and deterministic control.
 *
 * Edges carry Hebbian weights that strengthen on co-activation and decay over
 * time; a logistic significance function suppresses spurious co-occurrences.
 * Supports spreading activation for multi-hop retrieval and BFS shortest paths.
 */
export type EdgeKind = 'cooccurrence' | 'temporal' | 'causal' | 'semantic';

export type EdgeAttributes = {
  weight: number;
  kind: EdgeKind;
  /** Number of observed co-activations (for significance testing). */
  coactivations: number;
  /** Last update epoch ms. */
  updatedAt: number;
};

export type MemoryGraphOptions = {
  /** Global decay factor applied per decay() call, in (0, 1]. */
  decayFactor?: number;
  /** Learning rate for Hebbian strengthening, in (0, 1]. */
  learningRate?: number;
};

const DEFAULT_OPTIONS: Required<MemoryGraphOptions> = {
  decayFactor: 0.9,
  learningRate: 0.1,
};

type Adjacency = Map<string, EdgeAttributes>;

export class MemoryGraph {
  private readonly adjacency = new Map<string, Adjacency>();
  private readonly options: Required<MemoryGraphOptions>;

  constructor(options: MemoryGraphOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  ensureNode(id: string): void {
    if (!this.adjacency.has(id)) {
      this.adjacency.set(id, new Map());
    }
  }

  /** Record a co-activation between two memory ids, strengthening their edge. */
  strengthen(a: string, b: string, kind: EdgeKind = 'cooccurrence', now = Date.now()): void {
    this.ensureNode(a);
    this.ensureNode(b);
    if (a === b) {
      return;
    }
    const existing = this.adjacency.get(a)!.get(b);
    const coactivations = (existing ? existing.coactivations : 0) + 1;
    const significance = significanceOf(coactivations);
    const weight = existing ? existing.weight : 0;
    const next = Math.min(1, weight + this.options.learningRate * significance * (1 - weight));
    const attrs: EdgeAttributes = { weight: next, kind, coactivations, updatedAt: now };
    this.adjacency.get(a)!.set(b, attrs);
    this.adjacency.get(b)!.set(a, attrs);
  }

  /** Apply global synaptic decay to all edges; drops near-zero edges. */
  decay(now = Date.now()): number {
    let removed = 0;
    const processed = new Set<string>();
    const toDrop: string[] = [];
    for (const [from, neighbors] of this.adjacency) {
      for (const [to, attrs] of neighbors) {
        const key = canonicalEdgeKey(from, to);
        if (processed.has(key)) {
          continue;
        }
        processed.add(key);
        const next = attrs.weight * this.options.decayFactor;
        if (next < 1e-6) {
          toDrop.push(key);
        } else {
          attrs.weight = next;
          attrs.updatedAt = now;
        }
      }
    }
    for (const key of toDrop) {
      const [a, b] = splitEdgeKey(key);
      this.adjacency.get(a)?.delete(b);
      this.adjacency.get(b)?.delete(a);
      removed++;
    }
    return removed;
  }

  /** Spreading activation from seed ids; returns activation score per reachable node. */
  spreadingActivation(seeds: string[], maxDepth = 3, threshold = 0.01): Map<string, number> {
    let activation = new Map<string, number>();
    for (const seed of seeds) {
      if (this.adjacency.has(seed)) {
        activation.set(seed, 1);
      }
    }
    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Map<string, number>(activation);
      for (const [id, act] of activation) {
        if (act < threshold) {
          continue;
        }
        /* c8 ignore next -- defensive guard, unreachable via valid inputs */
        for (const [neighbor, attrs] of this.adjacency.get(id) ?? []) {
          next.set(neighbor, (next.get(neighbor) ?? 0) + act * attrs.weight);
        }
      }
      for (const [id, act] of next) {
        next.set(id, act * 0.5);
      }
      activation = next;
    }
    return activation;
  }

  /** Breadth-first shortest path between two nodes. */
  shortestPath(a: string, b: string): string[] | null {
    if (!this.adjacency.has(a) || !this.adjacency.has(b)) {
      return null;
    }
    if (a === b) {
      return [a];
    }
    const prev = new Map<string, string>();
    const visited = new Set<string>([a]);
    const queue: string[] = [a];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === b) {
        break;
      }
      /* c8 ignore next -- defensive guard, unreachable via valid inputs */
      for (const neighbor of this.adjacency.get(current)?.keys() ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          prev.set(neighbor, current);
          queue.push(neighbor);
        }
      }
    }
    if (!prev.has(b)) {
      return null;
    }
    const path: string[] = [b];
    let cursor = b;
    while (cursor !== a) {
      cursor = prev.get(cursor)!;
      path.unshift(cursor);
    }
    return path;
  }

  edgeWeight(a: string, b: string): number {
    return this.adjacency.get(a)?.get(b)?.weight ?? 0;
  }

  nodeCount(): number {
    return this.adjacency.size;
  }

  edgeCount(): number {
    let count = 0;
    for (const neighbors of this.adjacency.values()) {
      count += neighbors.size;
    }
    return count / 2;
  }
}

/** Logistic significance: approaches 1 as coactivations grow. */
export function significanceOf(coactivations: number): number {
  const x = coactivations - 1;
  return 1 / (1 + Math.exp(-x));
}

/** Canonical key for an undirected edge (order-independent). */
function canonicalEdgeKey(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function splitEdgeKey(key: string): [string, string] {
  const idx = key.indexOf('\u0000');
  return [key.slice(0, idx), key.slice(idx + 1)];
}
