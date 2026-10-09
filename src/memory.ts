import { FoxmemoryError } from "./errors.js";
import {
  KINDS,
  type Change,
  type Embedder,
  type Kind,
  type Memory,
  type RememberMeta,
  type RememberResult,
  type Store,
  type StoredMemory,
} from "./types.js";
import { checkVectors } from "./vector.js";

export interface MemoryOptions {
  store: Store;
  /** Turns text into vectors. Pass a foxmind `Mind`, or any object with the same `embed`. */
  embedder: Embedder;
  /** The clock. Default Date.now. */
  now?: () => number;
}

export interface FoxMemory {
  remember(text: string, meta?: RememberMeta): Promise<RememberResult>;
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

export function createMemory(options: MemoryOptions): FoxMemory {
  const { store, embedder } = options;
  const now = options.now ?? Date.now;
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


  async function embed(texts: string[]) {
    let reply: unknown;
    try {
      reply = await embedder.embed(texts);
    } catch (error) {
      throw new FoxmemoryError("embed_failed", `The embedder failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return checkVectors(reply, texts.length);
  }

  async function prepare(text: unknown, meta: RememberMeta = {}): Promise<Prepared> {
    checkKind(meta.kind);
    if (meta.source !== undefined && typeof meta.source !== "string") throw bad("source must be a string.");
    if (meta.ttlMs !== undefined && !(isTime(meta.ttlMs) && meta.ttlMs > 0)) throw bad("ttlMs must be a number above 0.");
    if (meta.expiresAt !== undefined && !isTime(meta.expiresAt)) throw bad("expiresAt must be a time in milliseconds.");
    if (typeof text !== "string" || !text.trim()) throw bad("text must be a string with at least one letter or digit.");
    const kept = text.trim();
    const expiresAt = meta.expiresAt ?? (meta.ttlMs === undefined ? undefined : now() + meta.ttlMs);
    return { text: kept, kind: meta.kind, source: meta.source, pinned: meta.pinned, expiresAt };
  }

  /** Under the lock: store prepared memories with their vectors in one write. */
  async function saveAll(items: Prepared[], vectors: Float32Array[], model: string): Promise<RememberResult[]> {
    const all = new Map(await records());
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
  };
}
