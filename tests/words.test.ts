import { describe, expect, it } from "vitest";
import { createMemory, memoryStore } from "../src/index.js";
import { createWordIndex } from "../src/words.js";
import { fakeEmbedder } from "./fake.js";

const file = (texts: string[]) => ({
  format: "foxmemory",
  version: 1,
  exportedAt: 0,
  memories: texts.map((text, n) => ({ id: `m${n}`, text, kind: "fact", source: "test", createdAt: n, updatedAt: n, pinned: false })),
});
const filler = (n: number) => Array.from({ length: n }, (_, i) => `filler note ${i} about tea and trains`);

describe("the word index (F44)", () => {
  it("ranks by BM25, stems, drops stop words, and follows add, edit and remove", () => {
    const words = createWordIndex();
    words.add("a", "The cats are running in the garden");
    words.add("b", "A dog sleeps");
    expect(words.search("cat run", 5).map((hit) => hit.id)).toEqual(["a"]);
    expect(words.search("the of and", 5)).toEqual([]);
    words.add("a", "The dog barks");
    expect(words.search("garden", 5)).toEqual([]);
    expect(words.search("dog", 5).map((hit) => hit.id).toSorted()).toEqual(["a", "b"]);
    words.remove("b");
    expect(words.search("dog", 5).map((hit) => hit.id)).toEqual(["a"]);
    words.clear();
    expect(words.search("dog", 5)).toEqual([]);
  });

  it("scores a rarer word above a common one", () => {
    const words = createWordIndex();
    for (let i = 0; i < 20; i++) words.add(`c${i}`, "common word here");
    words.add("r", "common marmot");
    expect(words.search("common marmot", 3)[0]?.id).toBe("r");
  });
});

describe("recall without vectors (F42)", () => {
  it("ranks by words alone, embeds nothing, and embedPending adds the vectors", async () => {
    const embedder = fakeEmbedder();
    const store = memoryStore();
    const memory = createMemory({ store, embedder, batchSize: 2 });
    await memory.importAll(file(["The boiler service is in October", "Tea is in the left cupboard", "Trains leave at noon"]));
    const [hit] = await memory.recall("boiler");
    expect(hit?.memory.id).toBe("m0");
    expect(embedder.calls).toEqual([]);
    expect(await memory.embedPending(2)).toBe(2);
    expect(await memory.embedPending()).toBe(1);
    expect(await memory.embedPending()).toBe(0);
    expect((await store.load()).every((record) => record.vector)).toBe(true);
    expect((await memory.recall("boiler"))[0]?.memory.id).toBe("m0");
  });
});

describe("recall in a store over the default cap of 10,000 memories (F44, F46)", () => {
  it("follows an edit and a forget, and falls back to every vector with no word match", async () => {
    const embedder = fakeEmbedder();
    const memory = createMemory({ store: memoryStore(), embedder, maxItems: 12_000 });
    await memory.importAll(file([...filler(10_100), ...Array.from({ length: 5 }, (_, i) => `The marmot crossing ${i} is on Elm Street`), "marmot"]));
    await memory.embedPending(12_000);
    // The fake embedder has 256 slots, so a hash collision can tie another memory: look at the top 5.
    const ids = async (query: string) => (await memory.recall(query)).map((hit) => hit.memory.id);
    expect(await ids("marmot")).toContain("m10105");
    await memory.update("m10105", { text: "okapi" });
    expect(await ids("okapi")).toContain("m10105");
    await memory.forget("m10105");
    expect(await ids("okapi")).not.toContain("m10105");
    // "the" is a stop word, so the word pass is empty and cosine ranks every vector.
    await memory.update("m1", { text: "The harbour closes at nine" });
    expect(await ids("the")).toContain("m1");
  });
});
