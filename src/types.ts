export const KINDS = ["fact", "preference", "task-note"] as const;
export type Kind = (typeof KINDS)[number];

/** One memory as the user sees it. Times are milliseconds since 1970. */
export interface Memory {
  id: string;
  text: string;
  kind: Kind;
  /** Where it came from: a URL, a conversation id, or "user". */
  source: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  pinned: boolean;
  /** The embedding model of the vector, or null when it has no vector yet. */
  model: string | null;
}

/** One memory as the store keeps it: with its unit-length vector. */
export interface StoredMemory extends Memory {
  vector: Float32Array | null;
}

/** Anything with this shape can embed text. A foxmind `Mind` has it. */
export interface Embedder {
  embed(texts: string[]): Promise<{ vectors: number[][]; model: string }>;
}

/** A change to write in one step. */
export interface Change {
  put: StoredMemory[];
  remove: string[];
  /** Delete every record before the put. */
  clear?: boolean;
}

/**
 * Where the records live. `lock` gives one writer at a time, across pages or
 * processes. `version` changes on every write by any writer, so a reader
 * knows when its copy is stale.
 */
export interface Store {
  lock<T>(fn: () => Promise<T>): Promise<T>;
  version(): Promise<number | string>;
  load(): Promise<StoredMemory[]>;
  /** Write the change in one step and return the new version. */
  write(change: Change): Promise<number | string>;
}

export interface RememberMeta {
  kind?: Kind;
  source?: string;
  pinned?: boolean;
  /** Expire after this many milliseconds. */
  ttlMs?: number;
  /** Expire at this time. */
  expiresAt?: number;
}

export interface RememberResult {
  memory: Memory;
  /** True when the same text was stored already; that record was refreshed. */
  deduped: boolean;
  /** Ids removed to keep the store under `maxItems`. */
  evicted: string[];
}

export interface RecallOptions {
  /** How many hits at most. Default 5. */
  k?: number;
  kinds?: Kind[];
  /** The lowest cosine similarity to return. Default 0. */
  minScore?: number;
}

export interface Hit {
  memory: Memory;
  /** Cosine similarity of the query and the memory, from -1 to 1. */
  similarity: number;
  /** similarity plus the recency boost. Hits are sorted by it. */
  score: number;
}

export interface MemoryPatch {
  text?: string;
  kind?: Kind;
  source?: string;
  pinned?: boolean;
  /** A time, or null to remove the expiry. */
  expiresAt?: number | null;
}

/** Every field you set must match. Set at least one. */
export interface ForgetFilter {
  kinds?: Kind[];
  source?: string;
  /** Text contains this, any case. */
  contains?: string;
  /** Last updated before this time. */
  before?: number;
  pinned?: boolean;
}

export interface ListOptions {
  kinds?: Kind[];
  contains?: string;
}
