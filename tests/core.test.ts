import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError, memoryStore } from "../src/index.js";
import { clock, fakeEmbedder } from "./fake.js";

function setup(options: Partial<Parameters<typeof createMemory>[0]> = {}) {
  const embedder = fakeEmbedder();
  const store = memoryStore();
  const time = clock();
  const memory = createMemory({ store, embedder, now: time.now, ...options });
  return { embedder, store, time, memory };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FoxmemoryError);
    return (error as FoxmemoryError).code;
  }
  throw new Error("expected the call to fail");
}

describe("remember and dedupe (F1)", () => {
  it("keeps one record for the same text with other case and spaces", async () => {
    const { memory, store, time } = setup();
    const first = await memory.remember("The user likes  green tea", { kind: "preference" });
    time.advance(1000);
    const second = await memory.remember("the user likes green tea ", { pinned: true });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.updatedAt).toBe(first.memory.updatedAt + 1000);
    expect(second.memory.pinned).toBe(true);
    expect(await store.load()).toHaveLength(1);
  });

  it("keeps pinned when only the first call set it", async () => {
    const { memory } = setup();
    await memory.remember("Office is on floor 3", { pinned: true });
    const again = await memory.remember("office is on floor 3");
    expect(again.memory.pinned).toBe(true);
  });

  it("stores the meta fields and defaults", async () => {
    const { memory, time } = setup();
    const { memory: saved } = await memory.remember("Ship the report on Friday", { kind: "task-note", source: "https://example.com/a" });
    expect(saved).toMatchObject({ kind: "task-note", source: "https://example.com/a", pinned: false, createdAt: time.time.now, model: "fake-a" });
    const plain = await memory.remember("Sky is blue");
    expect(plain.memory).toMatchObject({ kind: "fact", source: "user" });
  });
});

describe("bad input (F7)", () => {
  it("stores nothing", async () => {
    const { memory, store } = setup();
    expect(await code(memory.remember("   "))).toBe("bad_input");
    expect(await code(memory.remember(42 as unknown as string))).toBe("bad_input");
    expect(await code(memory.remember("ok", { kind: "secret" as "fact" }))).toBe("bad_input");
    expect(await code(memory.remember("ok", { ttlMs: -1 }))).toBe("bad_input");
    expect(await code(memory.remember("ok", { expiresAt: Number.NaN }))).toBe("bad_input");
    expect(await store.load()).toEqual([]);
  });
});
