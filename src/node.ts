// The Node store: one JSON file. Writes go to a temp file and then rename, so
// a reader never sees half a file. A lock file next to it lets one writer in
// at a time, across processes.
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { FoxmemoryError } from "./errors.js";
import { mutex } from "./memory-store.js";
import type { Change, Store, StoredMemory } from "./types.js";
import { fromBase64, toBase64 } from "./vector.js";

export interface FileStoreOptions {
  /** A lock file older than this is from a crashed writer and is taken over. Default 10000. */
  staleMs?: number;
  /** How long to wait for a live lock. Default 5000. */
  waitMs?: number;
}

type Row = Omit<StoredMemory, "vector"> & { vector: string | null };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function fileStore(path: string, options: FileStoreOptions = {}): Store {
  const staleMs = options.staleMs ?? 10_000;
  const waitMs = options.waitMs ?? 5_000;
  const lockPath = `${path}.lock`;
  const local = mutex();
  let cache: { version: string; records: StoredMemory[] } | undefined;

  /** A string that changes on every rename onto the path. */
  async function version(): Promise<string> {
    try {
      const info = await stat(path, { bigint: true });
      return `${info.ino}:${info.mtimeNs}:${info.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
      throw new FoxmemoryError("unavailable", `Cannot read ${path}: ${(error as Error).message}`, { cause: error });
    }
  }

  async function load(): Promise<StoredMemory[]> {
    const now = await version();
    if (cache?.version === now) return cache.records;
    if (now === "none") return [];
    let rows: Row[];
    try {
      const file = JSON.parse(await readFile(path, "utf8"));
      if (file?.format !== "foxmemory-store" || !Array.isArray(file.memories)) throw new Error('no "format": "foxmemory-store" field');
      rows = file.memories;
    } catch (error) {
      throw new FoxmemoryError("corrupt", `The store file ${path} is broken (${(error as Error).message}). foxmemory does not change it. Restore it from a backup, or move it away to start empty.`, { cause: error });
    }
    const records = rows.map(({ vector, ...rest }) => ({ ...rest, vector: vector === null ? null : (fromBase64(vector) ?? null) }));
    cache = { version: now, records };
    return records;
  }

  async function takeLock(): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new FoxmemoryError("unavailable", `Cannot make the lock file ${lockPath}: ${(error as Error).message}`, { cause: error });
      }
      const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > staleMs) await rm(lockPath, { force: true });
      else if (Date.now() - started > waitMs) throw new FoxmemoryError("locked", `Another writer holds ${lockPath}. Try again, or delete the file when no foxmemory process runs.`);
      else await sleep(20);
    }
  }

  return {
    lock: (fn) =>
      local(async () => {
        await takeLock();
        try {
          return await fn();
        } finally {
          await rm(lockPath, { force: true });
        }
      }),
    version,
    load: async () => (await load()).map((record) => ({ ...record })),
    async write(change: Change) {
      // Load first even for a clear: a broken file fails here and stays as it is.
      const loaded = await load();
      const records = new Map(change.clear ? [] : loaded.map((record) => [record.id, record]));
      for (const id of change.remove) records.delete(id);
      for (const record of change.put) records.set(record.id, { ...record });
      const memories: Row[] = [...records.values()].map(({ vector, ...rest }) => ({ ...rest, vector: vector ? toBase64(vector) : null }));
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ format: "foxmemory-store", version: 1, memories }));
      await rename(temp, path);
      const now = await version();
      cache = { version: now, records: [...records.values()] };
      return now;
    },
  };
}
