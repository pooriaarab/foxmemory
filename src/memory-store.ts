import type { Change, Store, StoredMemory } from "./types.js";

/** Calls fn after every earlier call is done: one at a time. */
export function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** A store in this process's memory. Two memories on one store share it. */
export function memoryStore(): Store {
  const records = new Map<string, StoredMemory>();
  let version = 0;
  return {
    lock: mutex(),
    version: async () => version,
    load: async () => [...records.values()].map((record) => ({ ...record })),
    async write(change: Change) {
      if (change.clear) records.clear();
      for (const id of change.remove) records.delete(id);
      for (const record of change.put) records.set(record.id, { ...record });
      return ++version;
    },
  };
}
