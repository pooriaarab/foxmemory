import { FoxmemoryError } from "./errors.js";

/** A unit-length copy of the vector, so cosine similarity is a dot product. */
export function unit(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const out = new Float32Array(vector.length);
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

const fail = (why: string) => new FoxmemoryError("embed_failed", `The embedder reply is not usable: ${why}.`);

/** Check an embedder reply and return unit vectors. */
export function checkVectors(reply: unknown, count: number): { vectors: Float32Array[]; model: string } {
  const { vectors, model } = (reply ?? {}) as { vectors?: unknown; model?: unknown };
  if (typeof model !== "string" || !model) throw fail("it names no model");
  if (!Array.isArray(vectors) || vectors.length !== count) throw fail(`it has ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${count} texts`);
  const dim = (vectors[0] as ArrayLike<number> | undefined)?.length ?? 0;
  const out = vectors.map((vector: ArrayLike<number>, index) => {
    if (!vector || vector.length !== dim || dim === 0) throw fail(`vector ${index} has ${vector?.length ?? 0} numbers, not ${dim}`);
    for (let i = 0; i < dim; i++) if (!Number.isFinite(vector[i])) throw fail(`vector ${index} holds a number that is not finite`);
    return unit(vector);
  });
  return { vectors: out, model };
}
