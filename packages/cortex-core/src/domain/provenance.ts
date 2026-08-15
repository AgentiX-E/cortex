/** Provenance node: records where a memory came from and how it was derived. */
export type ProvenanceNode = {
  id: string;
  memoryId: string;
  /** Source description (e.g. "user-message", "llm-extraction", "consolidation"). */
  kind: string;
  /** Epoch ms when this provenance event occurred. */
  timestamp: number;
  /** Optional parent provenance node ids (forming a DAG). */
  parents: string[];
  /** Arbitrary audit metadata. */
  metadata?: Record<string, unknown>;
};
