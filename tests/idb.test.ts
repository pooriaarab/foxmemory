import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError, indexedDbStore } from "../src/index.js";
import { fakeEmbedder } from "./fake.js";

// Each test gets its own fake IndexedDB. Node's navigator.locks is the real
// Web Locks API, as in Firefox.
function pages(count: number) {
  const indexedDB = new IDBFactory();
  const name = `test-${Math.random()}`;
  return Array.from({ length: count }, () => createMemory({ store: indexedDbStore(name, { indexedDB }), embedder: fakeEmbedder() }));
}

describe("IndexedDB store", () => {
  it("keeps memories, vectors and forgets", async () => {
    const [memory] = pages(1);
    const { memory: saved } = await memory!.remember("Stored in IndexedDB", { kind: "preference" });
    expect((await memory!.recall("stored indexeddb"))[0]?.memory).toEqual(saved);
    expect(await memory!.forget(saved.id)).toBe(true);
    expect(await memory!.list()).toEqual([]);
  });

  it("loses nothing and stores no duplicate with two pages at once (F26)", async () => {
    const [a, b] = pages(2);
    await Promise.all([
      ...Array.from({ length: 15 }, (_, i) => a!.remember(`page a ${i}`)),
      ...Array.from({ length: 15 }, (_, i) => b!.remember(`page b ${i}`)),
      a!.remember("same text"),
      b!.remember("SAME text"),
    ]);
    expect(await a!.list()).toHaveLength(31);
    expect(await b!.list()).toHaveLength(31);
  });

  it("sees what another page wrote (F27)", async () => {
    const [a, b] = pages(2);
    await b!.list();
    const { memory: saved } = await a!.remember("Written by page a");
    expect(await b!.get(saved.id)).toEqual(saved);
    await b!.update(saved.id, { pinned: true });
    expect((await a!.get(saved.id))?.pinned).toBe(true);
  });

  it("fails with unavailable when IndexedDB cannot open (F28)", async () => {
    const broken = {
      open() {
        const request = Object.assign(new EventTarget(), { error: new Error("The operation is insecure.") });
        setTimeout(() => request.dispatchEvent(new Event("error")));
        return request;
      },
    } as unknown as IDBFactory;
    const memory = createMemory({ store: indexedDbStore("x", { indexedDB: broken }), embedder: fakeEmbedder() });
    await expect(memory.list()).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/insecure/) });
    const none = createMemory({ store: indexedDbStore("x", { indexedDB: undefined }), embedder: fakeEmbedder() });
    await expect(none.list()).rejects.toBeInstanceOf(FoxmemoryError);
  });
});
