// A fake embedder for the tests. The same text and model always give the same
// vector. Each word lands in one slot, and the slot depends on the model id,
// so two models give two different vector spaces, as real models do. A test
// that mixes spaces gets similarities near 0 and fails.
export interface EmbedReply {
  vectors: number[][];
  model: string;
}

export interface FakeEmbedder {
  model: string;
  dim: number;
  /** The texts of each call, in order. */
  calls: string[][];
  /** Fail the call with this index (0 is the first call). */
  failCall: number;
  /** Replace the reply of every call. */
  reply?: (texts: string[]) => EmbedReply;
  embed(texts: string[]): Promise<EmbedReply>;
}

function slot(word: string, model: string, dim: number): number {
  let hash = 2166136261;
  for (const char of `${model}:${word}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % dim;
}

export function fakeVector(text: string, model: string, dim: number): number[] {
  const vector: number[] = Array.from({ length: dim }, () => 0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) vector[slot(word, model, dim)]! += 1;
  return vector;
}

export function fakeEmbedder(model = "fake-a", dim = 256): FakeEmbedder {
  const fake: FakeEmbedder = {
    model,
    dim,
    calls: [],
    failCall: -1,
    async embed(texts) {
      const index = fake.calls.push([...texts]) - 1;
      if (index === fake.failCall) throw new Error("embedder is down");
      if (fake.reply) return fake.reply(texts);
      return { model: fake.model, vectors: texts.map((text) => fakeVector(text, fake.model, fake.dim)) };
    },
  };
  return fake;
}

/** A clock the test moves by hand. */
export function clock(start = Date.UTC(2026, 9, 1)) {
  const time = { now: start };
  return { time, now: () => time.now, advance: (ms: number) => (time.now += ms) };
}

export const DAY = 86_400_000;
