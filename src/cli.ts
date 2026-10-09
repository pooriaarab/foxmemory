import { readFile } from "node:fs/promises";
import { FoxmemoryError } from "./errors.js";
import { createMemory } from "./memory.js";
import { fileStore } from "./node.js";
import type { Memory } from "./types.js";

export const USAGE = `Usage: foxmemory <command> <store.json> [arguments]

Commands:
  list <store.json>                          Print each memory: id, kind, pinned, text.
  search <store.json> <word> [word...]       Print the memories whose text has every word.
                                             This is a text match, not a search by meaning.
  export <store.json> [--vectors]            Print the memories as a foxmemory export file.
  import <store.json> <file.json> [--replace] [--trust-vectors]
                                             Add the memories in an export file. It drops the
                                             file's vectors unless you trust the file.
  forget <store.json> <id>                   Delete one memory.
`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const line = (memory: Memory) => `${memory.id}  ${memory.kind}  ${memory.pinned ? "pinned" : "-"}  ${memory.text}\n`;

/** Run the CLI and return the exit code: 0 done, 1 failed, 2 bad arguments. */
export async function run(argv: string[], io: Io): Promise<number> {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const [command, path, ...rest] = argv.filter((arg) => !arg.startsWith("--"));
  const needs = { list: 0, search: 1, export: 0, import: 1, forget: 1 }[command ?? ""];
  if (needs === undefined || !path || rest.length < needs) {
    io.err(USAGE);
    return 2;
  }
  // These commands never embed text, so the embedder only says so.
  const memory = createMemory({
    store: fileStore(path),
    embedder: { embed: () => Promise.reject(new Error("the foxmemory CLI does not embed text")) },
  });
  try {
    if (command === "list") for (const item of await memory.list()) io.out(line(item));
    if (command === "search") {
      const words = rest.map((word) => word.toLowerCase());
      for (const item of await memory.list()) if (words.every((word) => item.text.toLowerCase().includes(word))) io.out(line(item));
    }
    if (command === "export") io.out(`${JSON.stringify(await memory.exportAll({ vectors: flags.has("--vectors") }), null, 2)}\n`);
    if (command === "import") {
      const result = await memory.importAll(await readFile(rest[0]!, "utf8"), { mode: flags.has("--replace") ? "replace" : "merge", trustVectors: flags.has("--trust-vectors") });
      io.out(`Imported: added ${result.added}, updated ${result.updated}, skipped ${result.skipped}.\n`);
    }
    if (command === "forget") {
      if (!(await memory.forget(rest[0]!))) {
        io.err(`There is no memory with id ${rest[0]}.\n`);
        return 1;
      }
      io.out(`Forgot ${rest[0]}.\n`);
    }
    return 0;
  } catch (error) {
    io.err(error instanceof FoxmemoryError ? `${error.code}: ${error.message}\n` : `${(error as Error).message}\n`);
    return 1;
  }
}
