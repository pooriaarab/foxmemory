import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError } from "../src/index.js";
import { fileStore } from "../src/node.js";
import { fakeEmbedder } from "./fake.js";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "foxmemory-")), "memories.json");
const open = (path: string, options = {}) => createMemory({ store: fileStore(path, options), embedder: fakeEmbedder() });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FoxmemoryError);
    return (error as FoxmemoryError).code;
  }
  throw new Error("expected the call to fail");
}

describe("file store", () => {
  it("starts empty and keeps memories across opens", async () => {
    const path = tempFile();
    expect(await open(path).list()).toEqual([]);
    await open(path).remember("Saved to disk", { pinned: true });
    const [saved] = await open(path).list();
    expect(saved).toMatchObject({ text: "Saved to disk", pinned: true, model: "fake-a" });
    expect(await open(path).recall("saved disk")).toHaveLength(1);
  });

  it("removes the vector from the file on forget (F3)", async () => {
    const path = tempFile();
    const memory = open(path);
    const { memory: saved } = await memory.remember("Locker code is 4411");
    await memory.remember("Keep me");
    await memory.forget(saved.id);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("4411");
    expect(raw).not.toContain(saved.id);
    expect(JSON.parse(raw).memories).toHaveLength(1);
  });

  it("loses no write with two writers on one file (F22)", async () => {
    const path = tempFile();
    const a = open(path);
    const b = open(path);
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => a.remember(`from a ${i}`)),
      ...Array.from({ length: 20 }, (_, i) => b.remember(`from b ${i}`)),
      a.remember("both said this"),
      b.remember("Both said  this"),
    ]);
    expect(await open(path).list()).toHaveLength(41);
    expect((await b.recall("from a 7", { k: 1 }))[0]?.memory.text).toBe("from a 7");
  });

  it("never shows half a file to a reader (F23)", async () => {
    const path = tempFile();
    const memory = open(path);
    await memory.remember("first");
    let reads = 0;
    const state = { writing: true };
    const reader = (async () => {
      while (state.writing) {
        JSON.parse(readFileSync(path, "utf8"));
        reads++;
        await new Promise((done) => setImmediate(done));
      }
    })();
    for (let i = 0; i < 40; i++) await memory.remember(`write ${i} ${"x".repeat(2000)}`);
    state.writing = false;
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(readdirSync(join(path, "..")).toSorted()).toEqual(["memories.json"]);
  });

  it("fails with corrupt on a broken file and leaves it as it is (F23)", async () => {
    const path = tempFile();
    writeFileSync(path, '{ "format": "foxmemory-store", "memo');
    const memory = open(path);
    expect(await code(memory.list())).toBe("corrupt");
    expect(await code(memory.remember("new"))).toBe("corrupt");
    expect(await code(memory.clear())).toBe("corrupt");
    expect(readFileSync(path, "utf8")).toBe('{ "format": "foxmemory-store", "memo');
  });

  it("takes over a stale lock (F24)", async () => {
    const path = tempFile();
    writeFileSync(`${path}.lock`, "12345");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    await open(path, { staleMs: 10_000 }).remember("after a crash");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("fails with locked when a live lock does not clear (F24)", async () => {
    const path = tempFile();
    writeFileSync(`${path}.lock`, "12345");
    expect(await code(open(path, { waitMs: 100 }).remember("blocked"))).toBe("locked");
  });
});
