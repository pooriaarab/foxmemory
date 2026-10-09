import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError, memoryStore } from "../src/index.js";
import { fileStore } from "../src/node.js";
import { fakeEmbedder, fakeVector } from "./fake.js";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "foxmemory-lock-")), "memories.json");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("a lock held past staleMs (F32)", () => {
  it("stays with its holder while it works", async () => {
    const path = tempFile();
    const a = fileStore(path, { staleMs: 200 });
    const b = fileStore(path, { staleMs: 200, waitMs: 3000 });
    const order: string[] = [];
    const first = a.lock(async () => {
      order.push("a starts");
      await sleep(800);
      order.push("a ends");
    });
    await sleep(50);
    const second = b.lock(async () => {
      order.push("b runs");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a starts", "a ends", "b runs"]);
  });
});

describe("two writers on one stale lock (F33)", () => {
  it("lets only one of them in at a time", async () => {
    for (let round = 0; round < 5; round++) {
      const path = tempFile();
      writeFileSync(`${path}.lock`, "crashed-writer");
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${path}.lock`, old, old);
      let inside = 0;
      let most = 0;
      const work = async () => {
        inside++;
        most = Math.max(most, inside);
        await sleep(30);
        inside--;
      };
      await Promise.all(Array.from({ length: 4 }, () => fileStore(path, { staleMs: 1000 }).lock(work)));
      expect(most).toBe(1);
      expect(existsSync(`${path}.lock`)).toBe(false);
    }
  });
});

describe("a writer that lost its lock (F34)", () => {
  it("does not delete the new owner's lock, and its write fails", async () => {
    const path = tempFile();
    const store = fileStore(path);
    let code = "";
    await store.lock(async () => {
      writeFileSync(`${path}.lock`, "someone-else");
      try {
        await store.write({ put: [], remove: [], clear: true });
      } catch (error) {
        code = (error as FoxmemoryError).code;
      }
    });
    expect(code).toBe("locked");
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("someone-else");
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a write outside the lock", async () => {
    const store = fileStore(tempFile());
    await expect(store.write({ put: [], remove: [] })).rejects.toMatchObject({ code: "locked" });
  });
});

describe("a forget during re-embedding (F35)", () => {
  it("does not bring the memory back", async () => {
    const embedder = fakeEmbedder("model-a");
    const store = memoryStore();
    const memory = createMemory({ store, embedder, batchSize: 1 });
    const [, second] = await memory.rememberMany([{ text: "cats purr" }, { text: "dogs bark" }]);
    embedder.model = "model-b";
    let call = 0;
    embedder.reply = (texts) => {
      // The second call is the first re-embed batch. Another writer deletes "dogs bark" now,
      // as one with a lost lock could.
      if (call++ === 1) void store.write({ put: [], remove: [second!.memory.id] });
      return { model: "model-b", vectors: texts.map((text) => fakeVector(text, "model-b", 256)) };
    };
    await memory.recall("cats");
    expect((await store.load()).map((record) => record.text)).toEqual(["cats purr"]);
  });
});

describe("temp files (F36)", () => {
  it("are deleted by the next lock holder", async () => {
    const path = tempFile();
    writeFileSync(`${path}.0b6f.tmp`, '{"memories":[{"text":"forgotten secret"}]}');
    await createMemory({ store: fileStore(path), embedder: fakeEmbedder() }).remember("new");
    expect(readdirSync(dirname(path)).toSorted()).toEqual(["memories.json"]);
  });
});
