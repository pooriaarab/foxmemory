import { FoxmemoryError } from "./errors.js";
import {
  KINDS,
  type Change,
  type Embedder,
  type ForgetFilter,
  type Hit,
  type Kind,
  type ListOptions,
  type Memory,
  type MemoryPatch,
  type RecallOptions,
  type RememberMeta,
  type RememberResult,
  type Store,
  type StoredMemory,
} from "./types.js";
import { type ExportFile, parseExport, toExport } from "./exchange.js";
import { checkVectors, dot } from "./vector.js";

const DAY = 86_400_000;

export interface MemoryOptions {
  store: Store;
  /** Turns text into vectors. Pass a foxmind `Mind`, or any object with the same `embed`. */
  embedder: Embedder;
  /** Runs before a text is embedded or stored. Return the text to keep, or null to refuse it. */
  redact?: (text: string, meta: RememberMeta) => string | null | Promise<string | null>;
  /** The most memories to keep. Over it, the oldest unpinned ones go. Default 10000. */
  maxItems?: number;
  /** The most texts in one embed call. Default 32. */
  batchSize?: number;
  /** How much a brand-new memory gains over an old one in recall. Default 0.05. */
  recencyWeight?: number;
  /** The age at which the recency boost is half. Default 30 days. */
  halfLifeMs?: number;
  /** The clock. Default Date.now. */
  now?: () => number;
}

export interface FoxMemory {
  remember(text: string, meta?: RememberMeta): Promise<RememberResult>;
  /** All or nothing: when one embed call fails, none is stored. Each result lists every id the call evicted. */
  rememberMany(items: (RememberMeta & { text: string })[]): Promise<RememberResult[]>;
  recall(query: string, options?: RecallOptions): Promise<Hit[]>;
  update(id: string, patch: MemoryPatch): Promise<Memory>;
  /** Returns false when there was no such memory. */
  forget(id: string): Promise<boolean>;
  /** Returns how many memories it removed. */
  forgetWhere(filter: ForgetFilter): Promise<number>;
  clear(): Promise<void>;
  /** Pinned first, then the newest first. */
  list(options?: ListOptions): Promise<Memory[]>;
  get(id: string): Promise<Memory | undefined>;
  stats(): Promise<Stats>;
  /** Vectors are left out unless you ask for them. */
  exportAll(options?: { vectors?: boolean }): Promise<ExportFile>;
  /** All or nothing: a malformed file fails with bad_import and writes nothing. */
  importAll(data: unknown, options?: { mode?: "merge" | "replace" }): Promise<ImportResult>;
}

export interface Stats {
  count: number;
  pinned: number;
  /** How many memories have a vector from each model ("none" for no vector). */
  models: Record<string, number>;
}

export interface ImportResult {
  added: number;
  updated: number;
  /** Expired items, and items the redact hook refused. */
  skipped: number;
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

function matches(record: StoredMemory, filter: ForgetFilter & ListOptions): boolean {
  if (filter.kinds && !filter.kinds.includes(record.kind)) return false;
  if (filter.source !== undefined && record.source !== filter.source) return false;
  if (filter.contains !== undefined && !record.text.toLowerCase().includes(filter.contains.toLowerCase())) return false;
  if (filter.before !== undefined && !(record.updatedAt < filter.before)) return false;
  if (filter.pinned !== undefined && record.pinned !== filter.pinned) return false;
  return true;
}

export function createMemory(options: MemoryOptions): FoxMemory {
  const { store, embedder } = options;
  const now = options.now ?? Date.now;
  const recencyWeight = options.recencyWeight ?? 0.05;
  const halfLifeMs = options.halfLifeMs ?? 30 * DAY;
  const maxItems = options.maxItems ?? 10_000;
  const batchSize = options.batchSize ?? 32;
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

  /** Embed texts in batches. Every batch must come from one model. */
  async function embedAll(texts: string[]) {
    const vectors: Float32Array[] = [];
    let model = "";
    for (let i = 0; i < texts.length; i += batchSize) {
      const reply = await embed(texts.slice(i, i + batchSize));
      if (model && reply.model !== model) throw new FoxmemoryError("embed_failed", `The embedder changed from ${model} to ${reply.model} in one call. Try again.`);
      model = reply.model;
      vectors.push(...reply.vectors);
    }
    return { vectors, model };
  }

  /** Which unpinned records to evict so `all` fits, never one in `keep`. */
  function evictions(all: Map<string, StoredMemory>, keep: Set<string>): string[] {
    const over = all.size - maxItems;
    if (over <= 0) return [];
    const candidates = [...all.values()].filter((record) => !record.pinned && !keep.has(record.id)).toSorted((a, b) => a.updatedAt - b.updatedAt);
    if (candidates.length < over) throw new FoxmemoryError("full", `The store keeps ${maxItems} memories at most, and the others are pinned or new. Unpin or forget some first.`);
    return candidates.slice(0, over).map((record) => record.id);
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
    const evicted = evictions(all, new Set(put.keys()));
    await write({ put: [...put.values()], remove: evicted });
    return results.map((result) => ({ ...result, evicted }));
  }

  return {
    async remember(text, meta) {
      const item = await prepare(text, meta);
      const { vectors, model } = await embed([item.text]);
      const [result] = await store.lock(() => saveAll([item], vectors, model));
      return result!;
    },

    async rememberMany(items) {
      if (!Array.isArray(items)) throw bad("rememberMany takes a list of { text, ...meta }.");
      const prepared: Prepared[] = [];
      for (const item of items) prepared.push(await prepare(item?.text, item));
      if (prepared.length === 0) return [];
      const { vectors, model } = await embedAll(prepared.map((item) => item.text));
      return store.lock(() => saveAll(prepared, vectors, model));
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
        // Embed records from another model again, so two spaces never mix.
        const stale = [...all.values()].filter((record) => record.model !== model || record.vector?.length !== q.length);
        for (let i = 0; i < stale.length; i += batchSize) {
          const batch = stale.slice(i, i + batchSize);
          const fresh = await embed(batch.map((record) => record.text));
          if (fresh.model !== model || fresh.vectors[0]!.length !== q.length) {
            throw new FoxmemoryError("embed_failed", `The embedder changed from ${model} to ${fresh.model} while it embedded old memories again. Try again.`);
          }
          // Read the store again: write back only memories that are still there.
          const present = await current();
          const put = batch.flatMap((record, j) => (present.get(record.id)?.text === record.text ? [{ ...present.get(record.id)!, model, vector: fresh.vectors[j]! }] : []));
          if (put.length > 0) await write({ put, remove: [] });
        }
        const time = now();
        const ranked = await current();
        const hits: { record: StoredMemory; similarity: number; score: number }[] = [];
        for (const record of ranked.values()) {
          if (!record.vector) continue;
          if (recallOptions.kinds && !recallOptions.kinds.includes(record.kind)) continue;
          const similarity = dot(q, record.vector);
          if (similarity < minScore) continue;
          hits.push({ record, similarity, score: similarity + recencyWeight * 0.5 ** (Math.max(0, time - record.updatedAt) / halfLifeMs) });
        }
        hits.sort((a, b) => b.score - a.score);
        return hits.slice(0, k).map(({ record, similarity, score }) => ({ memory: view(record), similarity, score }));
      });
    },

    async update(id, patch) {
      checkKind(patch.kind);
      if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") throw bad("pinned must be true or false.");
      if (patch.source !== undefined && typeof patch.source !== "string") throw bad("source must be a string.");
      if (patch.expiresAt !== undefined && patch.expiresAt !== null && !isTime(patch.expiresAt)) throw bad("expiresAt must be a time in milliseconds, or null.");
      const text = patch.text === undefined ? undefined : await redact(patch.text, { kind: patch.kind, source: patch.source });
      const embedded = text === undefined ? undefined : await embed([text]);
      return store.lock(async () => {
        const all = await current();
        const old = all.get(id);
        if (!old) throw new FoxmemoryError("not_found", `There is no memory with id ${id}.`);
        if (text !== undefined && [...all.values()].some((record) => record.id !== id && textKey(record.text) === textKey(text))) {
          throw bad("Another memory has this text already.");
        }
        const record: StoredMemory = { ...old, updatedAt: now() };
        if (patch.kind !== undefined) record.kind = patch.kind;
        if (patch.source !== undefined) record.source = patch.source;
        if (patch.pinned !== undefined) record.pinned = patch.pinned;
        if (patch.expiresAt === null) delete record.expiresAt;
        else if (patch.expiresAt !== undefined) record.expiresAt = patch.expiresAt;
        if (text !== undefined && embedded) Object.assign(record, { text, vector: embedded.vectors[0]!, model: embedded.model });
        await write({ put: [record], remove: [] });
        return view(record);
      });
    },

    forget: (id) =>
      store.lock(async () => {
        if (!(await current()).has(id)) return false;
        await write({ put: [], remove: [id] });
        return true;
      }),

    async forgetWhere(filter) {
      const keys = (["kinds", "source", "contains", "before", "pinned"] as const).filter((key) => filter?.[key] !== undefined);
      if (keys.length === 0) throw bad("forgetWhere needs at least one filter field. Use clear() to delete every memory.");
      checkKind(filter.kinds?.find((kind) => !KINDS.includes(kind)));
      return store.lock(async () => {
        const gone = [...(await current()).values()].filter((record) => matches(record, filter)).map((record) => record.id);
        if (gone.length > 0) await write({ put: [], remove: gone });
        return gone.length;
      });
    },

    clear: () => store.lock(() => write({ put: [], remove: [], clear: true })),

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

    async stats() {
      const all = [...(await records()).values()].filter(live);
      const models: Record<string, number> = {};
      for (const record of all) models[record.model ?? "none"] = (models[record.model ?? "none"] ?? 0) + 1;
      return { count: all.length, pinned: all.filter((record) => record.pinned).length, models };
    },

    async exportAll(exportOptions = {}) {
      const all = [...(await records()).values()].filter(live);
      return toExport(all, exportOptions.vectors === true, now());
    },

    async importAll(data, importOptions = {}) {
      const incoming = parseExport(data);
      const kept: StoredMemory[] = [];
      let skipped = 0;
      for (const record of incoming) {
        const text = record.expiresAt !== undefined && record.expiresAt <= now() ? null : options.redact ? await options.redact(record.text, { kind: record.kind, source: record.source }) : record.text;
        if (typeof text !== "string" || !text.trim()) skipped++;
        else kept.push(text.trim() === record.text ? record : { ...record, text: text.trim(), model: null, vector: null });
      }
      return store.lock(async () => {
        const replace = importOptions.mode === "replace";
        const all = new Map(replace ? [] : await current());
        const byKey = new Map([...all.values()].map((record) => [textKey(record.text), record.id]));
        const put = new Map<string, StoredMemory>();
        let added = 0;
        for (const record of kept) {
          const sameText = all.get(byKey.get(textKey(record.text)) ?? "");
          const sameId = all.get(record.id);
          // Same text: keep the stored id and text. Same id: take the new fields, and the old vector when the text did not change.
          const old = sameText ?? sameId;
          let next = record;
          if (sameText) next = { ...record, id: sameText.id, text: sameText.text, pinned: sameText.pinned || record.pinned };
          if (old && !next.vector && old.text === next.text) next = { ...next, model: old.model, vector: old.vector };
          if (!old) added++;
          all.set(next.id, next);
          byKey.set(textKey(next.text), next.id);
          put.set(next.id, next);
        }
        if (all.size > maxItems) throw new FoxmemoryError("full", `The import would make ${all.size} memories, over the cap of ${maxItems}. Nothing was imported.`);
        await write({ put: [...put.values()], remove: [], clear: replace });
        return { added, updated: kept.length - added, skipped };
      });
    },
  };
}
