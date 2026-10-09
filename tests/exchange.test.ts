import { describe, expect, it } from "vitest";
import { createMemory, FoxmemoryError, memoryStore } from "../src/index.js";
import { clock, DAY, fakeEmbedder, fakeVector } from "./fake.js";

function setup(redact?: (text: string) => string | null) {
  const embedder = fakeEmbedder();
  const store = memoryStore();
  const time = clock();
  return { embedder, store, time, memory: createMemory({ store, embedder, now: time.now, ...(redact ? { redact } : {}) }) };
}

async function importError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FoxmemoryError);
    expect((error as FoxmemoryError).code).toBe("bad_import");
    return (error as FoxmemoryError).message;
  }
  throw new Error("expected the import to fail");
}

const item = (extra: Record<string, unknown> = {}) => ({
  id: "m1",
  text: "The user lives in Toronto",
  kind: "fact",
  source: "user",
  createdAt: Date.UTC(2026, 8, 1),
  updatedAt: Date.UTC(2026, 8, 2),
  pinned: false,
  ...extra,
});
const file = (memories: unknown[], extra: Record<string, unknown> = {}) => ({ format: "foxmemory", version: 1, exportedAt: 0, memories, ...extra });

function base64(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}

describe("malformed import (F17)", () => {
  const cases: [string, unknown, RegExp][] = [
    ["not JSON", "{ nope", /not JSON/],
    ["wrong format", { ...file([]), format: "other" }, /format/],
    ["wrong version", file([], { version: 2 }), /version/],
    ["no memories list", { format: "foxmemory", version: 1 }, /memories/],
    ["missing text", file([item(), item({ id: "m2", text: undefined })]), /memories\[1\]\.text/],
    ["bad kind", file([item({ kind: "secret" })]), /memories\[0\]\.kind/],
    ["bad date", file([item({ createdAt: "yesterday" })]), /memories\[0\]\.createdAt/],
    ["bad pinned", file([item({ pinned: "yes" })]), /memories\[0\]\.pinned/],
    ["bad vector", file([item({ model: "m", vector: "!!!" })]), /memories\[0\]\.vector/],
    ["vector without model", file([item({ vector: base64([1, 0]) })]), /memories\[0\]\.model/],
  ];
  for (const [name, data, message] of cases) {
    it(`refuses ${name} and writes nothing`, async () => {
      const { memory, store } = setup();
      await memory.remember("Keep this");
      const before = await store.version();
      expect(await importError(memory.importAll(data))).toMatch(message);
      expect(await store.version()).toBe(before);
      expect((await memory.list()).map((m) => m.text)).toEqual(["Keep this"]);
    });
  }

  it("leaves the store as it was when replace fails", async () => {
    const { memory } = setup();
    await memory.remember("Keep this");
    await importError(memory.importAll(file([item({ kind: 3 })]), { mode: "replace" }));
    expect((await memory.list()).map((m) => m.text)).toEqual(["Keep this"]);
  });
});

describe("duplicates on import (F18)", () => {
  it("keeps one record for the same id or the same text", async () => {
    const { memory } = setup();
    await memory.importAll(file([item()]));
    expect(await memory.importAll(file([item()]))).toEqual({ added: 0, updated: 1, skipped: 0 });
    await memory.importAll(file([item({ id: "other", text: "the user lives in  TORONTO" })]));
    await memory.importAll(file([item({ id: "x1", text: "Twice" }), item({ id: "x2", text: "twice" })]));
    expect((await memory.list()).map((m) => m.text).toSorted()).toEqual(["The user lives in Toronto", "Twice"]);
  });
});

describe("vectors from another model (F19)", () => {
  it("keeps them and embeds them again at recall", async () => {
    const { memory, store, embedder } = setup();
    const text = "Coffee beans are in the left cupboard";
    await memory.importAll(file([item({ text, model: "model-x", vector: base64(fakeVector(text, "model-x", 256)) })]));
    expect((await store.load())[0]?.model).toBe("model-x");
    const [hit] = await memory.recall("coffee beans cupboard");
    expect(hit?.memory.text).toBe(text);
    expect(embedder.calls.at(-1)).toEqual([text]);
    expect((await store.load())[0]?.model).toBe("fake-a");
  });
});

describe("redact on import (F20)", () => {
  it("runs on each text, drops changed vectors and skips refused ones", async () => {
    const { memory, store } = setup((text) => (text.includes("password") ? null : text.replace("Toronto", "[city]")));
    const result = await memory.importAll(
      file([item({ model: "fake-a", vector: base64(fakeVector("x", "fake-a", 256)) }), item({ id: "m2", text: "My password is hunter2" })]),
    );
    expect(result).toEqual({ added: 1, updated: 0, skipped: 1 });
    const [saved] = await store.load();
    expect(saved).toMatchObject({ text: "The user lives in [city]", model: null, vector: null });
    expect(JSON.stringify(await store.load())).not.toContain("hunter2");
  });
});

async function filled() {
  const { memory, time } = setup();
  await memory.remember("Prefers dark mode", { kind: "preference", pinned: true });
  await memory.remember("Renew the passport", { kind: "task-note", source: "conversation:42", ttlMs: 30 * DAY });
  await memory.remember("Lives near the lake", { source: "https://example.com/profile" });
  return { memory, time };
}

const strip = (list: { model: string | null }[]) => list.map(({ model: _model, ...rest }) => rest);

describe("export and import round trip (F21)", () => {
  it("keeps text, kind, source, dates and pinned", async () => {
    const { memory } = await filled();
    const exported = await memory.exportAll();
    expect(JSON.stringify(exported)).not.toContain('"vector"');
    const other = setup();
    expect(await other.memory.importAll(JSON.stringify(exported))).toEqual({ added: 3, updated: 0, skipped: 0 });
    expect(strip(await other.memory.list())).toEqual(strip(await memory.list()));
  });

  it("with vectors, the copy needs no new embeddings", async () => {
    const { memory } = await filled();
    const exported = await memory.exportAll({ vectors: true });
    const other = setup();
    await other.memory.importAll(exported);
    await other.memory.recall("dark mode");
    expect(other.embedder.calls).toEqual([["dark mode"]]);
  });

  it("skips expired items and replace mode drops the rest", async () => {
    const { memory, time } = setup();
    await memory.remember("Old thing");
    const result = await memory.importAll(file([item(), item({ id: "m2", text: "Gone", expiresAt: time.time.now - 1 })]), { mode: "replace" });
    expect(result).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect((await memory.list()).map((m) => m.text)).toEqual(["The user lives in Toronto"]);
  });
});
