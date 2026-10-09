import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (text: string) => out.push(text), err: (text: string) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

const dir = () => mkdtempSync(join(tmpdir(), "foxmemory-cli-"));
const exportFile = {
  format: "foxmemory",
  version: 1,
  exportedAt: 0,
  memories: [
    { id: "a", text: "Prefers tea over coffee", kind: "preference", source: "user", createdAt: 1, updatedAt: 2, pinned: true },
    { id: "b", text: "Car is a blue Golf", kind: "fact", source: "user", createdAt: 1, updatedAt: 3, pinned: false },
  ],
};

describe("CLI bad arguments (F25)", () => {
  for (const argv of [[], ["nope"], ["list"], ["import", "store.json"], ["search", "store.json"], ["forget", "store.json"]]) {
    it(`exits 2 with the usage for: ${argv.join(" ") || "(nothing)"}`, async () => {
      const result = await cli(...argv);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/Usage: foxmemory/);
    });
  }

  it("exits 1 with the reason for a malformed import file", async () => {
    const d = dir();
    writeFileSync(join(d, "bad.json"), JSON.stringify({ format: "foxmemory", version: 1, memories: [{ id: "x" }] }));
    const result = await cli("import", join(d, "store.json"), join(d, "bad.json"));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/bad_import: .*memories\[0\]\.text/);
  });
});

describe("CLI commands", () => {
  it("imports, lists, searches, forgets and exports", async () => {
    const d = dir();
    const store = join(d, "store.json");
    writeFileSync(join(d, "in.json"), JSON.stringify(exportFile));
    expect((await cli("import", store, join(d, "in.json"))).out).toMatch(/added 2, updated 0, skipped 0/);
    const listed = await cli("list", store);
    expect(listed.out.trim().split("\n")).toEqual(["a  preference  pinned  Prefers tea over coffee", "b  fact  -  Car is a blue Golf"]);
    expect((await cli("search", store, "blue", "golf")).out.trim()).toBe("b  fact  -  Car is a blue Golf");
    expect((await cli("forget", store, "b")).out).toMatch(/Forgot b/);
    expect((await cli("forget", store, "b")).code).toBe(1);
    const exported = JSON.parse((await cli("export", store)).out);
    expect(exported.memories.map((m: { id: string }) => m.id)).toEqual(["a"]);
    expect(JSON.parse(readFileSync(store, "utf8")).memories).toHaveLength(1);
  });
});
