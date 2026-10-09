import { FoxmemoryError } from "./errors.js";
import {
  KINDS,
  type Change,
  type Embedder,
  type Hit,
  type Kind,
  type ListOptions,
  type Memory,
  type RecallOptions,
  type RememberMeta,
  type RememberResult,
  type Store,
  type StoredMemory,
} from "./types.js";
import { checkVectors, dot } from "./vector.js";

const DAY = 86_400_000;

export interface MemoryOptions {
  store: Store;
  /** Turns text into vectors. Pass a foxmind `Mind`, or any object with the same `embed`. */
  embedder: Embedder;
  /** Runs before a text is embedded or stored. Return the text to keep, or null to refuse it. */
  redact?: (text: string, meta: RememberMeta) => string | null | Promise<string | null>;
  /** How much a brand-new memory gains over an old one in recall. Default 0.05. */
  recencyWeight?: number;
  /** The age at which the recency boost is half. Default 30 days. */
  halfLifeMs?: number;
  /** The clock. Default Date.now. */
  now?: () => number;
}

export interface FoxMemory {
  remember(text: string, meta?: RememberMeta): Promise<RememberResult>;
  recall(query: string, options?: RecallOptions): Promise<Hit[]>;
  /** Pinned first, then the newest first. */
  list(options?: ListOptions): Promise<Memory[]>;
  get(id: string): Promise<Memory | undefined>;
}


interface Prepared {
  text: string;
  kind?: Kind;
  source?: string;
  pinned?: boolean;
  expiresAt?: number;
}

const bad = (why: string) => new FoxmemoryError("bad_input", why);
/** The key for exact-text dedupe: any case, any run of spaces. */
export const textKey = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The memory without its vector. */
export function view(record: StoredMemory): Memory {
  const { vector: _vector, ...memory } = record;
  return memory;
}

function checkKind(kind: unknown): void {
  if (kind !== undefined && !KINDS.includes(kind as Kind)) throw bad(`kind must be one of ${KINDS.join(", ")}.`);
}

function matches(record: StoredMemory, filter: ListOptions): boolean {
  if (filter.kinds && !filter.kinds.includes(record.kind)) return false;
  if (filter.contains !== undefined && !record.text.toLowerCase().includes(filter.contains.toLowerCase())) return false;
  return true;
}

export function createMemory(options: MemoryOptions): FoxMemory {
  const { store, embedder } = options;
  const now = options.now ?? Date.now;
  const recencyWeight = options.recencyWeight ?? 0.05;
  const halfLifeMs = options.halfLifeMs ?? 30 * DAY;
  let cache: { version: number | string; records: Map<string, StoredMemory> } = { version: Number.NaN, records: new Map() };

  /** The records, loaded again when another writer changed the store. */
  async function records(): Promise<Map<string, StoredMemory>> {
    const version = await store.version();
    if (version !== cache.version) cache = { version, records: new Map((await store.load()).map((record) => [record.id, record])) };
    return cache.records;
  }

  /** Write a change, then apply it to the cache. Call it only under the lock. */
  async function write(change: Change): Promise<void> {
    const version = await store.write(change);
    if (change.clear) cache.records.clear();
    for (const id of change.remove) cache.records.delete(id);
    for (const record of change.put) cache.records.set(record.id, record);
    cache.version = version;
  }

  const live = (record: StoredMemory) => record.expiresAt === undefined || record.expiresAt > now();

  /** Under the lock: the records, after expired ones are deleted. */
  async function current(): Promise<Map<string, StoredMemory>> {
    const all = await records();
    const expired = [...all.values()].filter((record) => !live(record)).map((record) => record.id);
    if (expired.length > 0) await write({ put: [], remove: expired });
    return all;
  }

  async function embed(texts: string[]) {
    let reply: unknown;
    try {
      reply = await embedder.embed(texts);
    } catch (error) {
      throw new FoxmemoryError("embed_failed", `The embedder failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return checkVectors(reply, texts.length);
  }

  async function redact(text: unknown, meta: RememberMeta): Promise<string> {
    if (typeof text !== "string" || !text.trim()) throw bad("text must be a string with at least one letter or digit.");
    const kept = options.redact ? await options.redact(text, meta) : text;
    if (kept === null || typeof kept !== "string" || !kept.trim()) throw new FoxmemoryError("redacted", "The redact hook refused this text, so foxmemory did not store it.");
    return kept.trim();
  }

  async function prepare(text: unknown, meta: RememberMeta = {}): Promise<Prepared> {
    checkKind(meta.kind);
    if (meta.source !== undefined && typeof meta.source !== "string") throw bad("source must be a string.");
    if (meta.ttlMs !== undefined && !(isTime(meta.ttlMs) && meta.ttlMs > 0)) throw bad("ttlMs must be a number above 0.");
    if (meta.expiresAt !== undefined && !isTime(meta.expiresAt)) throw bad("expiresAt must be a time in milliseconds.");
    const kept = await redact(text, meta);
    const expiresAt = meta.expiresAt ?? (meta.ttlMs === undefined ? undefined : now() + meta.ttlMs);
    return { text: kept, kind: meta.kind, source: meta.source, pinned: meta.pinned, expiresAt };
  }

  /** Under the lock: store prepared memories with their vectors in one write. */
  async function saveAll(items: Prepared[], vectors: Float32Array[], model: string): Promise<RememberResult[]> {
    const all = new Map(await current());
    const byKey = new Map([...all.values()].map((record) => [textKey(record.text), record.id]));
    const put = new Map<string, StoredMemory>();
    const time = now();
    const results = items.map((item, index): Omit<RememberResult, "evicted"> => {
      const vector = vectors[index]!;
      const same = all.get(byKey.get(textKey(item.text)) ?? "");
      let record: StoredMemory;
      if (same) {
        const expiresAt = same.expiresAt === undefined || item.expiresAt === undefined ? undefined : Math.max(same.expiresAt, item.expiresAt);
        record = { ...same, kind: item.kind ?? same.kind, source: item.source ?? same.source, pinned: same.pinned || item.pinned === true, updatedAt: time, model, vector };
        if (expiresAt === undefined) delete record.expiresAt;
        else record.expiresAt = expiresAt;
      } else {
        record = {
          id: crypto.randomUUID(),
          text: item.text,
          kind: item.kind ?? "fact",
          source: item.source ?? "user",
          createdAt: time,
          updatedAt: time,
          ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
          pinned: item.pinned === true,
          model,
          vector,
        };
      }
      all.set(record.id, record);
      byKey.set(textKey(record.text), record.id);
      put.set(record.id, record);
      return { memory: view(record), deduped: same !== undefined };
    });
    await write({ put: [...put.values()], remove: [] });
    return results.map((result) => ({ ...result, evicted: [] }));
  }

  return {
    async remember(text, meta) {
      const item = await prepare(text, meta);
      const { vectors, model } = await embed([item.text]);
      const [result] = await store.lock(() => saveAll([item], vectors, model));
      return result!;
    },

    async recall(query, recallOptions = {}) {
      if (typeof query !== "string" || !query.trim()) throw bad("query must be a string with at least one letter or digit.");
      const k = recallOptions.k ?? 5;
      const minScore = recallOptions.minScore ?? 0;
      if (k <= 0 || (await records()).size === 0) return [];
      const { vectors, model } = await embed([query]);
      const q = vectors[0]!;
      return store.lock(async () => {
        const all = await current();
        const time = now();
        const hits: { record: StoredMemory; similarity: number; score: number }[] = [];
        for (const record of all.values()) {
          // Never compare vectors from two models.
          if (record.model !== model || record.vector?.length !== q.length) continue;
          if (recallOptions.kinds && !recallOptions.kinds.includes(record.kind)) continue;
          const similarity = dot(q, record.vector);
          if (similarity < minScore) continue;
          hits.push({ record, similarity, score: similarity + recencyWeight * 0.5 ** (Math.max(0, time - record.updatedAt) / halfLifeMs) });
        }
        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, k).map(({ record, similarity, score }) => ({ memory: view(record), similarity, score }));
      });
    },

    async list(listOptions = {}) {
      return [...(await records()).values()]
        .filter((record) => live(record) && matches(record, listOptions))
        .toSorted((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        .map(view);
    },

    async get(id) {
      const record = (await records()).get(id);
      return record && live(record) ? view(record) : undefined;
    },
  };
}
