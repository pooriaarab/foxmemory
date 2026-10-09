import { FoxmemoryError } from "./errors.js";
import { KINDS, type Kind, type Memory, type StoredMemory } from "./types.js";
import { fromBase64, toBase64, unit } from "./vector.js";

/** One memory in an export file. `vector` is base64 of 32-bit floats. */
export type ExportedMemory = Omit<Memory, "model"> & { model?: string; vector?: string };

/** The JSON file that exportAll writes and importAll reads. */
export interface ExportFile {
  format: "foxmemory";
  version: 1;
  exportedAt: number;
  memories: ExportedMemory[];
}

const bad = (why: string) => new FoxmemoryError("bad_import", why);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function toExport(records: StoredMemory[], vectors: boolean, now: number): ExportFile {
  const memories = records.map(({ vector, model, ...rest }): ExportedMemory => (vectors && vector && model ? { ...rest, model, vector: toBase64(vector) } : rest));
  return { format: "foxmemory", version: 1, exportedAt: now, memories };
}

function field(at: string, name: string, ok: boolean, want: string): void {
  if (!ok) throw bad(`${at}.${name} must be ${want}.`);
}

function toRecord(item: unknown, at: string): StoredMemory {
  if (!isObject(item)) throw bad(`${at} is not an object.`);
  field(at, "id", typeof item.id === "string" && item.id.length > 0, "a string");
  field(at, "text", typeof item.text === "string" && item.text.trim().length > 0, "a string with text");
  field(at, "kind", KINDS.includes(item.kind as Kind), `one of ${KINDS.join(", ")}`);
  field(at, "source", typeof item.source === "string", "a string");
  field(at, "createdAt", isTime(item.createdAt), "a time in milliseconds");
  field(at, "updatedAt", isTime(item.updatedAt), "a time in milliseconds");
  field(at, "expiresAt", item.expiresAt === undefined || isTime(item.expiresAt), "a time in milliseconds");
  field(at, "pinned", typeof item.pinned === "boolean", "true or false");
  let vector: Float32Array | null = null;
  if (item.vector !== undefined) {
    const decoded = fromBase64(item.vector);
    field(at, "vector", decoded !== undefined, "base64 of 32-bit floats");
    field(at, "model", typeof item.model === "string" && item.model.length > 0, "the model id of the vector");
    vector = unit(decoded!);
  }
  return {
    id: item.id as string,
    text: (item.text as string).trim(),
    kind: item.kind as Kind,
    source: item.source as string,
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
    ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt as number }),
    pinned: item.pinned as boolean,
    model: vector ? (item.model as string) : null,
    vector,
  };
}

/** Parse and check an export file, as an object or JSON text. Fails with bad_import, naming the item and the field. */
export function parseExport(data: unknown): StoredMemory[] {
  let file = data;
  if (typeof data === "string") {
    try {
      file = JSON.parse(data);
    } catch (error) {
      throw bad(`The file is not JSON: ${(error as Error).message}`);
    }
  }
  if (!isObject(file) || file.format !== "foxmemory") throw bad('The file has no "format": "foxmemory" field, so it is not a foxmemory export.');
  if (file.version !== 1) throw bad(`The file has version ${String(file.version)}. This foxmemory reads version 1.`);
  if (!Array.isArray(file.memories)) throw bad('The file has no "memories" list.');
  return file.memories.map((item, index) => toRecord(item, `memories[${index}]`));
}
