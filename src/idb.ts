// The browser store: IndexedDB. Each page that opens the same name shares the
// records. Web Locks let one page write at a time, and a version number in
// the database tells each page when its copy is stale.
import { FoxmemoryError } from "./errors.js";
import type { Change, Store, StoredMemory } from "./types.js";

export interface IndexedDbStoreOptions {
  /** The IndexedDB factory. Default: the page's `indexedDB`. */
  indexedDB?: IDBFactory;
  /** The Web Locks manager. Default: `navigator.locks`. */
  locks?: LockManager;
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => resolve());
    tx.addEventListener("error", () => reject(tx.error));
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("The IndexedDB write was aborted.")));
  });

export function indexedDbStore(name: string, options: IndexedDbStoreOptions = {}): Store {
  const factory = "indexedDB" in options ? options.indexedDB : globalThis.indexedDB;
  const locks = "locks" in options ? options.locks : globalThis.navigator?.locks;
  let db: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new FoxmemoryError("unavailable", "This page has no IndexedDB, so foxmemory cannot store memories here."));
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(`foxmemory:${name}`, 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore("memories", { keyPath: "id" });
        request.result.createObjectStore("meta");
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(new FoxmemoryError("unavailable", `IndexedDB did not open: ${request.error?.message ?? "no reason given"}`, { cause: request.error })));
    }).catch((error: unknown) => {
      db = undefined;
      throw error;
    });
    return db;
  }

  async function version(): Promise<number> {
    const tx = (await open()).transaction("meta", "readonly");
    return ((await done(tx.objectStore("meta").get("version"))) as number | undefined) ?? 0;
  }

  return {
    lock(fn) {
      if (!locks) return Promise.reject(new FoxmemoryError("unavailable", "This page has no Web Locks API (navigator.locks), so foxmemory cannot keep two writers apart."));
      return locks.request(`foxmemory:${name}`, { mode: "exclusive" }, fn);
    },
    version,
    async load() {
      const tx = (await open()).transaction("memories", "readonly");
      return (await done(tx.objectStore("memories").getAll())) as StoredMemory[];
    },
    async write(change: Change) {
      const tx = (await open()).transaction(["memories", "meta"], "readwrite");
      const memories = tx.objectStore("memories");
      const meta = tx.objectStore("meta");
      if (change.clear) memories.clear();
      for (const id of change.remove) memories.delete(id);
      for (const record of change.put) memories.put(record);
      const next = (((await done(meta.get("version"))) as number | undefined) ?? 0) + 1;
      meta.put(next, "version");
      await finished(tx);
      return next;
    },
  };
}
