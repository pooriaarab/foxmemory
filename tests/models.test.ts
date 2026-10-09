import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError, memoryStore } from "../src/index.js";
import { clock, fakeEmbedder, fakeVector } from "./fake.js";

async function failure(promise: Promise<unknown>): Promise<FoxmemoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FoxmemoryError);
    return error as FoxmemoryError;
  }
  throw new Error("expected the call to fail");
}

const THREE = [{ text: "cats purr when happy" }, { text: "dogs bark at night" }, { text: "birds sing at dawn" }];

describe("model swap (F11)", () => {
  it("embeds old records again with the new model before it ranks", async () => {
    const embedder = fakeEmbedder("model-a");
    const store = memoryStore();
    const memory = createMemory({ store, embedder, batchSize: 2 });
    await memory.rememberMany(THREE);
    embedder.model = "model-b";
    const before = embedder.calls.length;
    const [hit] = await memory.recall("cats purr");
    expect(hit?.memory.text).toBe("cats purr when happy");
    expect(hit?.similarity).toBeCloseTo(2 / Math.sqrt(8), 5);
    expect(embedder.calls.slice(before + 1)).toEqual([["cats purr when happy", "dogs bark at night"], ["birds sing at dawn"]]);
    expect((await store.load()).map((record) => record.model)).toEqual(["model-b", "model-b", "model-b"]);
    expect((await memory.stats()).models).toEqual({ "model-b": 3 });
  });

  it("treats a new vector size as a new space", async () => {
    const embedder = fakeEmbedder("model-a", 256);
    const memory = createMemory({ store: memoryStore(), embedder });
    await memory.rememberMany(THREE);
    embedder.dim = 128;
    const [hit] = await memory.recall("dogs bark");
    expect(hit?.memory.text).toBe("dogs bark at night");
    expect(hit?.similarity).toBeCloseTo(2 / Math.sqrt(8), 5);
  });

  it("embeds a record again only once", async () => {
    const embedder = fakeEmbedder("model-a");
    const memory = createMemory({ store: memoryStore(), embedder });
    await memory.rememberMany(THREE);
    embedder.model = "model-b";
    await memory.recall("cats");
    const before = embedder.calls.length;
    await memory.recall("dogs");
    expect(embedder.calls.length).toBe(before + 1);
  });
});

describe("model changes during re-embedding (F12)", () => {
  it("fails, keeps the batches done before, and mixes nothing", async () => {
    const embedder = fakeEmbedder("model-a");
    const store = memoryStore();
    const memory = createMemory({ store, embedder, batchSize: 2 });
    await memory.rememberMany(THREE);
    let call = 0;
    embedder.reply = (texts) => {
      const model = call++ < 2 ? "model-b" : "model-c";
      return { model, vectors: texts.map((text) => fakeVector(text, model, 256)) };
    };
    const error = await failure(memory.recall("cats purr"));
    expect(error.code).toBe("embed_failed");
    expect((await store.load()).map((record) => record.model).toSorted()).toEqual(["model-a", "model-b", "model-b"]);
  });
});

describe("embed failure in rememberMany (F13)", () => {
  it("stores nothing and keeps the cause", async () => {
    const embedder = fakeEmbedder();
    const store = memoryStore();
    const memory = createMemory({ store, embedder, batchSize: 2 });
    embedder.failCall = 1;
    const error = await failure(memory.rememberMany(THREE));
    expect(error.code).toBe("embed_failed");
    expect((error.cause as Error).message).toBe("embedder is down");
    expect(await store.load()).toEqual([]);
  });
});

describe("bad embedder replies (F14)", () => {
  const replies = {
    "wrong count": () => ({ model: "m", vectors: [[1, 0]] }),
    "wrong size": () => ({ model: "m", vectors: [[1, 0], [1, 0, 0]] }),
    "not finite": () => ({ model: "m", vectors: [[1, Number.NaN], [1, 0]] }),
    "no model": () => ({ model: "", vectors: [[1, 0], [0, 1]] }),
  };
  for (const [name, reply] of Object.entries(replies)) {
    it(`fails with embed_failed for ${name}`, async () => {
      const embedder = fakeEmbedder();
      embedder.reply = reply;
      const store = memoryStore();
      const memory = createMemory({ store, embedder });
      expect((await failure(memory.rememberMany([{ text: "one" }, { text: "two" }]))).code).toBe("embed_failed");
      expect(await store.load()).toEqual([]);
    });
  }
});

describe("size cap (F15)", () => {
  it("evicts the oldest unpinned memory and says which", async () => {
    const time = clock();
    const memory = createMemory({ store: memoryStore(), embedder: fakeEmbedder(), maxItems: 3, now: time.now });
    const ids: string[] = [];
    for (const text of ["first", "second", "third"]) {
      ids.push((await memory.remember(text, { pinned: text === "first" })).memory.id);
      time.advance(1);
    }
    const fourth = await memory.remember("fourth");
    expect(fourth.evicted).toEqual([ids[1]]);
    expect((await memory.list()).map((item) => item.text)).toEqual(["first", "fourth", "third"]);
  });

  it("fails with full when every other memory is pinned", async () => {
    const memory = createMemory({ store: memoryStore(), embedder: fakeEmbedder(), maxItems: 2 });
    await memory.rememberMany([{ text: "a", pinned: true }, { text: "b", pinned: true }]);
    expect((await failure(memory.remember("c"))).code).toBe("full");
    expect((await memory.list()).map((item) => item.text).toSorted()).toEqual(["a", "b"]);
  });

  it("refuses a batch bigger than the cap", async () => {
    const memory = createMemory({ store: memoryStore(), embedder: fakeEmbedder(), maxItems: 2 });
    expect((await failure(memory.rememberMany(THREE))).code).toBe("full");
    expect(await memory.list()).toEqual([]);
  });
});

describe("a huge store (F16)", () => {
  it("recalls from 10,000 memories in under 200 ms", async () => {
    const embedder = fakeEmbedder("model-a", 384);
    const memory = createMemory({ store: memoryStore(), embedder, batchSize: 1000 });
    const items = Array.from({ length: 10_000 }, (_, i) => ({ text: `memory number ${i} about topic ${i % 97} and place ${i % 13}` }));
    await memory.rememberMany(items);
    await memory.recall("warm up");
    const started = performance.now();
    const hits = await memory.recall("memory number 4242 about topic 71", { k: 3 });
    const ms = performance.now() - started;
    expect(hits.map((hit) => hit.memory.text)).toContain("memory number 4242 about topic 71 and place 4");
    expect(ms).toBeLessThan(200);
  });
});
