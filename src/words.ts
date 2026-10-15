// A word index for the first pass of recall: lowercase letters and digits, a light
// English stemmer, stop words, and BM25 over postings kept in Uint32Arrays.
const STOP = new Set(
  "a about after all also am an and any are as at be been but by can did do does for from had has have he her his how i if in into is it its just me my no not of on or our she so some than that the their them then there these they this to up us was we were what when where which who why will with would you your".split(" "),
);
const K1 = 1.2;
const B = 0.75;

function stem(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed", "es", "ly", "s"]) {
    if (!word.endsWith(suffix) || word.length - suffix.length < 3 || (suffix === "s" && word.endsWith("ss"))) continue;
    const root = word.slice(0, -suffix.length);
    return suffix === "ing" || suffix === "ed" ? root.replace(/([^aeiolsz])\1$/, "$1") : root;
  }
  return word;
}

/** The distinct stems of a text, with how often each occurs. */
function terms(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length < 2 || STOP.has(word)) continue;
    const term = stem(word);
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

interface Posting {
  docs: Uint32Array;
  freqs: Uint32Array;
  size: number;
}

export interface WordHit {
  id: string;
  score: number;
}

export interface WordIndex {
  /** Index a text under an id. An id that is there already is replaced. */
  add(id: string, text: string): void;
  remove(id: string): void;
  clear(): void;
  /** The best `k` ids by BM25 score, best first, among those `accept` allows. Ids with no query word are left out. */
  search(query: string, k: number, accept?: (id: string) => boolean): WordHit[];
}

export function createWordIndex(): WordIndex {
  let ids: (string | undefined)[] = [];
  let lengths: number[] = [];
  let docTerms: (string[] | undefined)[] = [];
  let slotOf = new Map<string, number>();
  let free: number[] = [];
  let postings = new Map<string, Posting>();
  let totalLength = 0;

  function remove(id: string): void {
    const slot = slotOf.get(id);
    if (slot === undefined) return;
    for (const term of docTerms[slot]!) {
      const posting = postings.get(term)!;
      const at = posting.docs.indexOf(slot);
      posting.size--;
      posting.docs[at] = posting.docs[posting.size]!;
      posting.freqs[at] = posting.freqs[posting.size]!;
      if (posting.size === 0) postings.delete(term);
    }
    totalLength -= lengths[slot]!;
    ids[slot] = undefined;
    docTerms[slot] = undefined;
    slotOf.delete(id);
    free.push(slot);
  }

  return {
    add(id, text) {
      remove(id);
      const counts = terms(text);
      const slot = free.pop() ?? ids.length;
      ids[slot] = id;
      docTerms[slot] = [...counts.keys()];
      lengths[slot] = [...counts.values()].reduce((sum, n) => sum + n, 0);
      totalLength += lengths[slot]!;
      slotOf.set(id, slot);
      for (const [term, freq] of counts) {
        let posting = postings.get(term);
        if (!posting) postings.set(term, (posting = { docs: new Uint32Array(2), freqs: new Uint32Array(2), size: 0 }));
        if (posting.size === posting.docs.length) {
          const grown = { docs: new Uint32Array(posting.size * 2), freqs: new Uint32Array(posting.size * 2) };
          grown.docs.set(posting.docs);
          grown.freqs.set(posting.freqs);
          Object.assign(posting, grown);
        }
        posting.docs[posting.size] = slot;
        posting.freqs[posting.size++] = freq;
      }
    },

    remove,

    clear() {
      ids = [];
      lengths = [];
      docTerms = [];
      slotOf = new Map();
      free = [];
      postings = new Map();
      totalLength = 0;
    },

    search(query, k, accept) {
      const count = slotOf.size;
      if (count === 0 || k <= 0) return [];
      const average = totalLength / count || 1;
      const scores = new Float64Array(ids.length);
      const touched: number[] = [];
      for (const term of terms(query).keys()) {
        const posting = postings.get(term);
        if (!posting) continue;
        const idf = Math.log(1 + (count - posting.size + 0.5) / (posting.size + 0.5));
        for (let i = 0; i < posting.size; i++) {
          const slot = posting.docs[i]!;
          const freq = posting.freqs[i]!;
          if (scores[slot] === 0) touched.push(slot);
          scores[slot]! += (idf * freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * lengths[slot]!) / average));
        }
      }
      // Keep the best k in a list sorted from best to worst.
      const best: number[] = [];
      for (const slot of touched) {
        const score = scores[slot]!;
        if (best.length === k && score <= scores[best[k - 1]!]!) continue;
        if (accept && !accept(ids[slot]!)) continue;
        let low = 0;
        let high = best.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (scores[best[mid]!]! >= score) low = mid + 1;
          else high = mid;
        }
        best.splice(low, 0, slot);
        if (best.length > k) best.pop();
      }
      return best.map((slot) => ({ id: ids[slot]!, score: scores[slot]! }));
    },
  };
}
