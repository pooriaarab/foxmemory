// The Node store: one JSON file. Writes go to a temp file and then rename, so
// a reader never sees half a file. A lock file next to it lets one writer in
// at a time, across processes. The lock file holds the holder's random token,
// and the holder refreshes its time while it works.
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

  /** The token in the lock file, or undefined when there is none. */
  const lockToken = () => readFile(lockPath, "utf8").catch(() => undefined);
  let held: string | undefined;

  async function takeLock(token: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        await writeFile(lockPath, token, { flag: "wx" });
        if ((await lockToken()) === token) return;
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new FoxmemoryError("unavailable", `Cannot make the lock file ${lockPath}: ${(error as Error).message}`, { cause: error });
      }
      const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > staleMs) {
        // Take over a stale lock only while holding the takeover guard, and only
        // if it is still stale then. So two writers never both remove a lock,
        // and no one removes the fresh lock of the writer that came first.
        const guard = `${lockPath}.takeover`;
        if (await writeFile(guard, token, { flag: "wx" }).then(() => true, () => false)) {
          try {
            const again = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
            if (again > staleMs) await rm(lockPath, { force: true });
          } finally {
            await rm(guard, { force: true });
          }
        } else {
          const guardAge = await stat(guard).then((info) => Date.now() - info.mtimeMs, () => 0);
          if (guardAge > staleMs) await rm(guard, { force: true });
          await sleep(20);
        }
      } else if (Date.now() - started > waitMs) {
        throw new FoxmemoryError("locked", `Another writer holds ${lockPath}. Try again, or delete the file when no foxmemory process runs.`);
      } else await sleep(20);
    }
  }

  /** Delete temp files that a failed write or a crash left. Only the lock holder writes them. */
  async function sweep(): Promise<void> {
    const prefix = `${basename(path)}.`;
    const names = await readdir(dirname(path)).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => name.startsWith(prefix) && name.endsWith(".tmp")).map((name) => rm(join(dirname(path), name), { force: true })));
  }

  return {
    lock: (fn) =>
      local(async () => {
        const token = randomUUID();
        await takeLock(token);
        held = token;
        // Keep the lock fresh while fn runs, so no one takes it over as stale.
        const timer = setInterval(() => {
          void lockToken().then((now) => (now === token ? utimes(lockPath, new Date(), new Date()) : undefined)).catch(() => undefined);
        }, Math.max(10, Math.floor(staleMs / 3)));
        try {
          await sweep();
          return await fn();
        } finally {
          clearInterval(timer);
          held = undefined;
          if ((await lockToken()) === token) await rm(lockPath, { force: true });
        }
      }),
    version,
    load: async () => (await load()).map((record) => ({ ...record })),
    async write(change: Change) {
      if (!held || (await lockToken()) !== held) throw new FoxmemoryError("locked", `This writer does not hold ${lockPath}, so it did not write. Another writer may have taken the lock over.`);
      // Load first even for a clear: a broken file fails here and stays as it is.
      const loaded = await load();
      const records = new Map(change.clear ? [] : loaded.map((record) => [record.id, record]));
      for (const id of change.remove) records.delete(id);
      for (const record of change.put) records.set(record.id, { ...record });
      const memories: Row[] = [...records.values()].map(({ vector, ...rest }) => ({ ...rest, vector: vector ? toBase64(vector) : null }));
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ format: "foxmemory-store", version: 1, memories }));
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw new FoxmemoryError("unavailable", `Cannot write ${path}: ${(error as Error).message}`, { cause: error });
      }
      const now = await version();
      cache = { version: now, records: [...records.values()] };
      return now;
    },
  };
}
