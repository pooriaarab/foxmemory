import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError, memoryStore } from "../src/index.js";
import { clock, DAY, fakeEmbedder } from "./fake.js";

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

const hideCards = (text: string) => text.replace(/\d{4}-\d{4}/g, "[card]");

describe("redact (F5)", () => {
  it("runs before the embedder and the store", async () => {
    const { memory, embedder, store } = setup({ redact: hideCards });
    const { memory: saved } = await memory.remember("Card 1234-5678 is the travel card");
    expect(saved.text).toBe("Card [card] is the travel card");
    expect(JSON.stringify(embedder.calls)).not.toContain("1234");
    expect(JSON.stringify(await store.load())).not.toContain("1234");
  });

  it("stores nothing when redact returns null", async () => {
    const { memory, embedder, store } = setup({ redact: async (text) => (text.includes("password") ? null : text) });
    expect(await code(memory.remember("My password is hunter2"))).toBe("redacted");
    expect(embedder.calls).toEqual([]);
    expect(await store.load()).toEqual([]);
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

describe("list", () => {
  it("lists pinned first, then the newest", async () => {
    const { memory, time } = setup();
    await memory.remember("One");
    time.advance(1);
    await memory.remember("Two");
    time.advance(1);
    await memory.remember("Three", { pinned: true });
    time.advance(1);
    await memory.remember("Four");
    expect((await memory.list()).map((item) => item.text)).toEqual(["Three", "Four", "Two", "One"]);
  });
});

describe("expiry (F2)", () => {
  it("never returns an expired item and deletes it on the next write", async () => {
    const { memory, store, time } = setup();
    const short = await memory.remember("Parking spot 12 today", { ttlMs: DAY });
    await memory.remember("Parking garage closes at 9");
    time.advance(DAY + 1);
    const hits = await memory.recall("parking spot");
    expect(hits.map((hit) => hit.memory.text)).toEqual(["Parking garage closes at 9"]);
    expect(await memory.list()).toHaveLength(1);
    expect(await memory.get(short.memory.id)).toBeUndefined();
    await memory.remember("Another fact");
    expect((await store.load()).map((record) => record.text)).not.toContain("Parking spot 12 today");
  });

  it("takes an absolute expiresAt", async () => {
    const { memory, time } = setup();
    await memory.remember("Sale ends soon", { expiresAt: time.time.now + 10 });
    time.advance(10);
    expect(await memory.recall("sale")).toEqual([]);
  });
});

describe("recall (F8, F9)", () => {
  it("returns an empty list for an empty store or k 0", async () => {
    const { memory } = setup();
    expect(await memory.recall("anything")).toEqual([]);
    await memory.remember("Something");
    expect(await memory.recall("something", { k: 0 })).toEqual([]);
  });

  it("ranks by similarity and filters by k, kinds and minScore", async () => {
    const { memory } = setup();
    await memory.remember("The user drinks green tea every morning", { kind: "preference" });
    await memory.remember("Green tea shop is on Main Street");
    await memory.remember("The car needs new tires");
    const hits = await memory.recall("green tea morning");
    expect(hits[0]?.memory.text).toBe("The user drinks green tea every morning");
    expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity);
    expect(await memory.recall("green tea", { k: 1 })).toHaveLength(1);
    const prefs = await memory.recall("green tea", { kinds: ["preference"] });
    expect(prefs.map((hit) => hit.memory.kind)).toEqual(["preference"]);
    const close = await memory.recall("green tea morning", { minScore: 0.5 });
    expect(close.map((hit) => hit.memory.text)).toEqual(["The user drinks green tea every morning"]);
  });

  it("keeps a close old match above a new far one", async () => {
    const { memory, time } = setup();
    await memory.remember("Dentist appointment is at 3 pm");
    time.advance(365 * DAY);
    await memory.remember("Dentist parking costs money");
    const [first, second] = await memory.recall("dentist appointment 3 pm");
    expect(first?.memory.text).toBe("Dentist appointment is at 3 pm");
    expect(second!.score - second!.similarity).toBeGreaterThan(first!.score - first!.similarity);
    expect(second!.score - second!.similarity).toBeLessThanOrEqual(0.05);
  });
});

describe("forget (F3, F4)", () => {
  it("removes the record and its vector", async () => {
    const { memory, store } = setup();
    const { memory: saved } = await memory.remember("My locker code is 4411");
    expect(await memory.forget(saved.id)).toBe(true);
    const left = await store.load();
    expect(left.find((record) => record.id === saved.id)).toBeUndefined();
    expect(JSON.stringify(left)).not.toContain("4411");
    expect(await memory.recall("locker code")).toEqual([]);
    expect(await memory.forget(saved.id)).toBe(false);
  });

  it("forgetWhere removes only the matching items", async () => {
    const { memory } = setup();
    await memory.remember("From page a", { source: "https://a.example" });
    await memory.remember("Also from page a", { source: "https://a.example", pinned: true });
    await memory.remember("From the user");
    expect(await memory.forgetWhere({ source: "https://a.example", pinned: false })).toBe(1);
    expect(await memory.forgetWhere({ source: "https://a.example" })).toBe(1);
    expect((await memory.list()).map((item) => item.text)).toEqual(["From the user"]);
  });

  it("forgetWhere matches kinds, text and age", async () => {
    const { memory, time } = setup();
    await memory.remember("Old task", { kind: "task-note" });
    time.advance(DAY);
    await memory.remember("New task", { kind: "task-note" });
    await memory.remember("Old fact");
    expect(await memory.forgetWhere({ kinds: ["task-note"], before: time.time.now })).toBe(1);
    expect(await memory.forgetWhere({ contains: "FACT" })).toBe(1);
    expect((await memory.list()).map((item) => item.text)).toEqual(["New task"]);
  });

  it("refuses an empty filter, and clear() deletes all", async () => {
    const { memory } = setup();
    await memory.remember("Keep me");
    expect(await code(memory.forgetWhere({}))).toBe("bad_input");
    expect(await memory.list()).toHaveLength(1);
    await memory.clear();
    expect(await memory.list()).toEqual([]);
  });
});

describe("redact on update (F5)", () => {
  it("runs on update too", async () => {
    const { memory } = setup({ redact: (text) => text.replace("secret", "[x]") });
    const { memory: saved } = await memory.remember("Plain text");
    const updated = await memory.update(saved.id, { text: "A secret plan" });
    expect(updated.text).toBe("A [x] plan");
  });
});

describe("update (F6, F10)", () => {
  it("embeds a new text again", async () => {
    const { memory, embedder } = setup();
    const { memory: saved } = await memory.remember("Meeting is on Monday");
    await memory.update(saved.id, { text: "Meeting moved to Thursday" });
    expect(embedder.calls.at(-1)).toEqual(["Meeting moved to Thursday"]);
    const [hit] = await memory.recall("moved to thursday");
    expect(hit?.memory.text).toBe("Meeting moved to Thursday");
  });

  it("does not call the embedder for a pin change", async () => {
    const { memory, embedder, time } = setup();
    const { memory: saved } = await memory.remember("Pin me");
    const before = embedder.calls.length;
    time.advance(5);
    const updated = await memory.update(saved.id, { pinned: true, kind: "preference", expiresAt: null });
    expect(embedder.calls.length).toBe(before);
    expect(updated).toMatchObject({ pinned: true, kind: "preference", updatedAt: saved.updatedAt + 5 });
  });

  it("fails with not_found for an unknown id", async () => {
    const { memory } = setup();
    expect(await code(memory.update("nope", { pinned: true }))).toBe("not_found");
  });

  it("refuses a text that another memory already has", async () => {
    const { memory } = setup();
    await memory.remember("Alpha");
    const { memory: beta } = await memory.remember("Beta");
    expect(await code(memory.update(beta.id, { text: "alpha" }))).toBe("bad_input");
  });
});
