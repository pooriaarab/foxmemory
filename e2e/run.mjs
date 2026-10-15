// The E2E test. It installs the built demo extension (dist-ext/) in a real
// Firefox, runs the real MiniLM embedding model through foxmind, and uses the
// Memory page as a person would. It writes artifacts/e2e-<date>.json with
// every check and timing.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary),
// FOXMEMORY_SCREENSHOT (a PNG path for a capture of the Memory page).
import { launch, poll, writeArtifact } from "create-foxkit/e2e";
import { FACTS } from "./facts.mjs";

const record = { startedAt: new Date().toISOString(), checks: [], timings: {} };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });
const headless = !process.argv.includes("--headed");
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

/** Open the Memory page and wait until it has drawn the list. */
async function memoryPage(fox, query = "") {
  const page = await fox.openExtensionPage(`memory.html${query}`);
  await poll(page, () => document.body.dataset.ready === "1", undefined, 30_000);
  return page;
}

const count = (page) => page.evaluate(() => Number(document.body.dataset.count));

/** Type a memory into the add form and wait until the list has `expected` items. */
async function addThroughForm(page, fact, expected) {
  const started = Date.now();
  await page.evaluate((f) => {
    document.getElementById("new-text").value = f.text;
    document.getElementById("new-kind").value = f.kind;
    document.getElementById("add").requestSubmit();
  }, fact);
  await poll(page, (n) => Number(document.body.dataset.count) === n && document.getElementById("new-text").value === "", expected, 180_000);
  return Date.now() - started;
}

/** Ask the recall box and return the top hits and the time. */
async function recallThroughForm(page, question) {
  const started = Date.now();
  await page.evaluate((q) => {
    document.getElementById("query").value = q;
    document.getElementById("recall").requestSubmit();
  }, question);
  await poll(page, () => document.getElementById("hits").dataset.done === "1", undefined, 60_000);
  const hits = await page.evaluate(() => [...document.querySelectorAll("#hits li")].map((li) => ({ score: Number(li.querySelector(".score").textContent), text: li.childNodes[1].textContent })));
  // ms counts the test's polling too; pageMs is the page's own count of the recall call.
  return { hits, ms: Date.now() - started, pageMs: await page.evaluate(() => Number(document.getElementById("hits").dataset.ms)) };
}

const rowAction = (page, text, action) =>
  page.evaluate(
    (t, a) => {
      const li = [...document.querySelectorAll("#list li")].find((item) => item.querySelector(".text")?.textContent === t);
      li.querySelector(a).click();
      return Boolean(li);
    },
    text,
    action,
  );


// A seeded corpus of notes and chat turns. Words come from a Zipf-like list, so a
// query word is common, as in real text. Targets carry two rare marker words.
const letters = (n) => [...String(n)].map((d) => String.fromCharCode(97 + Number(d))).join("");
const markers = (n) => [`qzx${letters(n)}`, `vyw${letters(n)}`];
function corpus(size, seed, targets = []) {
  let state = seed;
  const rand = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const syllables = ["ka", "lo", "mi", "ra", "su", "ten", "vo", "bel", "dun", "fi", "gor", "hal"];
  const vocab = Array.from({ length: 1728 }, (_, i) => syllables[i % 12] + syllables[Math.floor(i / 12) % 12] + syllables[Math.floor(i / 144) % 12]);
  const words = (n) => Array.from({ length: n }, () => vocab[Math.floor(rand() ** 3 * vocab.length)]).join(" ");
  const texts = Array.from({ length: size }, (_, n) => (n % 2 ? `user: ${words(5 + Math.floor(rand() * 12))} assistant: ${words(8 + Math.floor(rand() * 20))} #${n}` : `Note ${n}: ${words(8 + Math.floor(rand() * 14))}`));
  for (const n of targets) texts[n] += ` ${markers(n).join(" ")}`;
  // Each query takes three words of one record.
  const queries = Array.from({ length: 20 }, () => texts[Math.floor(rand() * size)].match(/[a-z]{4,}/g).filter((w) => vocab.includes(w)).slice(0, 3).join(" "));
  return { texts, queries };
}

/** The Memory page on a store of its own, with room for `max` memories. */
const wordsPage = (fox, store, max) => memoryPage(fox, `?store=${store}&max=${max}`);

// F42, F43, F45: the word index ranks first, and recall works before embedding ends.
async function wordIndexChecks() {
  const t0 = Date.now();
  const size = 20_000;
  const targets = [3, 4_001, 9_998, 15_555, 19_999];
  const { texts, queries } = corpus(size, 7, targets);
  const fox = await launch({ extension: "dist-ext", headless, prefs: { "extensions.background.idle.timeout": 600_000 } });
  const words = { size };
  try {
    // (a) Import with no vectors, then ask by words. A recall that embeds every record first never returns.
    let page = await wordsPage(fox, "words", size);
    await page.evaluate(() => window.demo.mind.embed(["load the model"]));
    words.importMs = await page.evaluate(async (items) => {
      const t = performance.now();
      const memories = items.map((text, n) => ({ id: `w${n}`, text, kind: "fact", source: "e2e", createdAt: n, updatedAt: n, pinned: false }));
      await window.demo.memory.importAll({ format: "foxmemory", version: 1, exportedAt: 0, memories }, { mode: "replace" });
      return Math.round(performance.now() - t);
    }, texts);
    const found = [];
    for (const n of targets) {
      const started = Date.now();
      const answer = await Promise.race([page.evaluate((q) => window.demo.memory.recall(q, { k: 5 }).then((hits) => hits.map((hit) => hit.memory.id)), markers(n).join(" ")), new Promise((done) => setTimeout(done, 2000, "no answer in 2 s"))]);
      found.push({ want: `w${n}`, got: Array.isArray(answer) ? answer[0] : answer, ms: Date.now() - started });
      if (!Array.isArray(answer)) break;
    }
    words.found = found;
    check("20,000 imported records with no vectors: a word query finds its record within 2 s of the import (F42)", found.length === targets.length && found.every((f) => f.got === f.want && f.ms < 2000), found);
    await page.close();

    // (b) The same records with vectors: recall at 20,000 under 25 ms median. The query is embedded by MiniLM.
    page = await wordsPage(fox, "words", size);
    words.withVectors = await page.evaluate(
      async (items, queryList) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const vector = (n) => {
          const v = new Float32Array(384);
          for (let i = 0; i < 384; i++) v[i] = Math.sin(n * 12.9898 + i * 78.233) % 1;
          let binary = "";
          for (const byte of new Uint8Array(v.buffer)) binary += String.fromCharCode(byte);
          return btoa(binary);
        };
        const memories = items.map((text, n) => ({ id: `w${n}`, text, kind: "fact", source: "e2e", createdAt: n, updatedAt: n, pinned: false, model: "Xenova/all-MiniLM-L6-v2", vector: vector(n) }));
        await window.demo.memory.importAll({ format: "foxmemory", version: 1, exportedAt: 0, memories }, { mode: "replace", trustVectors: true });
        let t = performance.now();
        await window.demo.memory.recall("warm up the page", { k: 5 });
        const firstMs = Math.round(performance.now() - t);
        const times = [];
        for (const q of queryList) {
          t = performance.now();
          await window.demo.memory.recall(q, { k: 5 });
          times.push(performance.now() - t);
        }
        const sorted = times.toSorted((a, b) => a - b);
        return { firstMs, medianMs: Math.round(sorted[10] * 10) / 10, maxMs: Math.round(sorted[19] * 10) / 10 };
      },
      texts,
      queries,
    );
    check(`recall at 20,000 records takes ${words.withVectors.medianMs} ms median over 20 queries, under 25 ms (F43)`, words.withVectors.medianMs < 25, words.withVectors);
    await page.close();

    // (c) 1,000 records, a bag-of-words embedder: top 5 equals a cosine-only scan.
    page = await wordsPage(fox, "words-parity", 2000);
    const parity = corpus(1000, 11);
    words.parity = await page.evaluate(
      async (items, queryList) => {
        // A bag of words with one slot per word, so cosine needs a shared word, as the word pass does.
        const slots = new Map();
        const embedder = {
          async embed(list) {
            return {
              model: "bag-of-words",
              vectors: list.map((text) => {
                const v = Array.from({ length: 2048 }, () => 0);
                for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
                  if (!slots.has(word)) slots.set(word, slots.size % 2048);
                  v[slots.get(word)] += 1;
                }
                return v;
              }),
            };
          },
        };
        const memory = window.demo.lib.createMemory({ store: window.demo.lib.indexedDbStore("words-parity"), embedder, maxItems: 2000 });
        await memory.rememberMany(items.map((text) => ({ text })));
        const stored = (await memory.exportAll({ vectors: true })).memories.map((m) => ({ id: m.id, vector: new Float32Array(Uint8Array.from(atob(m.vector), (c) => c.charCodeAt(0)).buffer) }));
        let differ = 0;
        for (const q of queryList) {
          const { vectors } = await embedder.embed([q]);
          const norm = Math.hypot(...vectors[0]);
          const scan = stored.map((m) => ({ id: m.id, s: m.vector.reduce((sum, x, i) => sum + (x * vectors[0][i]) / norm, 0) })).toSorted((a, b) => b.s - a.s).slice(0, 5).map((m) => m.id);
          const got = (await memory.recall(q, { k: 5 })).map((hit) => hit.memory.id);
          if (scan.some((id) => !got.includes(id))) differ++;
        }
        return { records: items.length, queries: queryList.length, differ };
      },
      parity.texts,
      parity.queries,
    );
    check(`top 5 of 20 queries at 1,000 records equals cosine-only recall, ${words.parity.differ} differ, at most 1 (F45)`, words.parity.differ <= 1, words.parity);
    await page.close();
  } finally {
    words.totalMs = Date.now() - t0;
    record.timings.words = words;
    await fox.close();
  }
}

let fox;
try {
  await wordIndexChecks();
  fox = await launch({ extension: "dist-ext", headless, prefs: { "extensions.background.idle.timeout": 600_000 } });
  record.firefox = await fox.browser.version();
  const page = await memoryPage(fox);
  record.env = await page.evaluate(() => ({ crossOriginIsolated: globalThis.crossOriginIsolated, userAgent: navigator.userAgent }));

  // F30: 20 facts through the add form, then each question in other words.
  const addMs = [];
  for (const [index, fact] of FACTS.entries()) addMs.push(await addThroughForm(page, fact, index + 1));
  record.timings.firstRememberWithModelLoadMs = addMs[0];
  record.timings.rememberMedianMs = median(addMs.slice(1));
  check("20 facts stored through the Memory page", (await count(page)) === 20, await count(page));
  const model = await page.evaluate(() => window.demo.memory.stats().then((s) => s.models));
  check("each memory keeps the real model id", model["Xenova/all-MiniLM-L6-v2"] === 20, model);

  const misses = [];
  const recallMs = [];
  const recallPageMs = [];
  let top1 = 0;
  for (const fact of FACTS) {
    const { hits, ms, pageMs } = await recallThroughForm(page, fact.ask);
    recallMs.push(ms);
    recallPageMs.push(pageMs);
    if (hits[0]?.text === fact.text) top1++;
    if (!hits.some((hit) => hit.text === fact.text)) misses.push({ ask: fact.ask, want: fact.text, got: hits.map((hit) => hit.text) });
  }
  record.timings.recallMedianMs = median(recallMs);
  record.timings.recallInPageMedianMs = median(recallPageMs);
  record.recall = { top1, top3: FACTS.length - misses.length, of: FACTS.length, misses };
  check("each paraphrased question finds its fact in the top 3 (F30)", misses.length === 0, record.recall);

  // F1: the same fact again, in other case and spaces.
  await page.evaluate(() => {
    document.getElementById("new-text").value = "  i am ALLERGIC to   peanuts. ";
    document.getElementById("add").requestSubmit();
  });
  const dedupe = await poll(page, () => /told me this already/.test(document.getElementById("status").textContent) && document.getElementById("status").textContent);
  check("a repeated fact is refreshed, not stored twice (F1)", (await count(page)) === 20, { count: await count(page), status: dedupe });

  // F31: edit, delete and pin through the page, then reload.
  const edited = "I take my coffee with soy milk now, still no sugar.";
  await rowAction(page, FACTS[0].text, ".edit-button");
  await page.evaluate((text) => {
    document.querySelector("#list textarea.edit").value = text;
    document.querySelector("#list .save").click();
  }, edited);
  await poll(page, (t) => [...document.querySelectorAll("#list .text")].some((p) => p.textContent === t), edited);
  await rowAction(page, FACTS[8].text, ".delete");
  await poll(page, () => Number(document.body.dataset.count) === 19);
  await rowAction(page, FACTS[16].text, ".pin");
  await poll(page, (t) => document.querySelector("#list li")?.querySelector(".text").textContent === t, FACTS[16].text);
  // Mark the old document, so the poll cannot pass on it before the reload.
  await page.evaluate(() => {
    document.body.dataset.ready = "0";
    location.reload();
  });
  await poll(page, () => document.readyState === "complete" && document.body.dataset.ready === "1", undefined, 30_000);
  const after = await page.evaluate(() => [...document.querySelectorAll("#list li")].map((li) => ({ text: li.querySelector(".text").textContent, pinned: li.dataset.pinned })));
  check(
    "edit, delete and pin last after a reload (F31)",
    after.length === 19 && after.some((item) => item.text === edited) && !after.some((item) => item.text === FACTS[8].text) && after[0].text === FACTS[16].text && after[0].pinned === "true",
    { count: after.length, first: after[0] },
  );
  const milk = await recallThroughForm(page, "What milk goes in my coffee?");
  check("recall finds the edited text, not the old one", milk.hits[0]?.text === edited, milk.hits);
  record.recall.afterEdit = milk.hits;

  if (process.env.FOXMEMORY_SCREENSHOT) {
    // BiDi cannot screenshot moz-extension: pages, so the test copies the
    // page's live markup and styles into a normal page and captures that.
    const html = await page.evaluate(() => `<!doctype html><html><head><meta charset="utf-8"><style>${[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n")}</style></head>${document.body.outerHTML}</html>`);
    const shot = await fox.browser.newPage();
    await shot.setViewport({ width: 820, height: 1100 });
    await shot.setContent(html);
    await shot.screenshot({ path: process.env.FOXMEMORY_SCREENSHOT });
    await shot.close();
  }

  // F26, F27: two Memory pages write at once; the other page updates live.
  const second = await memoryPage(fox);
  const before = await count(page);
  await Promise.all([
    page.evaluate(() => Promise.all([...Array.from({ length: 10 }, (_, i) => window.demo.memory.remember(`Page one note ${i}`)), window.demo.memory.remember("Both pages wrote this")])),
    second.evaluate(() => Promise.all([...Array.from({ length: 10 }, (_, i) => window.demo.memory.remember(`Page two note ${i}`)), window.demo.memory.remember("both pages wrote THIS")])),
  ]);
  const total = await page.evaluate(() => window.demo.memory.list().then((items) => items.length));
  check("two pages at once: no lost write, no duplicate (F26)", total === before + 21, { before, total });
  await addThroughForm(page, { text: "Written in page one after the race", kind: "fact" }, before + 22);
  const live = await poll(second, (n) => Number(document.body.dataset.count) === n && document.body.dataset.count, before + 22, 10_000).catch(() => undefined);
  check("the other page shows the change without a reload (F27)", Number(live) === before + 22, live);
  await second.close();

  // F21: export through the page, delete all, import the file again.
  await page.evaluate(() => document.getElementById("export").click());
  const exported = JSON.parse(await poll(page, () => window.demo.exports[0]));
  await page.evaluate(() => document.getElementById("clear").click());
  await poll(page, () => /again/.test(document.getElementById("clear").textContent));
  await page.evaluate(() => document.getElementById("clear").click());
  const cleared = await poll(page, () => Number(document.body.dataset.count) === 0 || /error|failed/i.test(document.getElementById("status").textContent)).then(() => page.evaluate(() => ({ count: Number(document.body.dataset.count), status: document.getElementById("status").textContent })));
  check("delete all through the page empties the store", cleared.count === 0, cleared);
  const started = Date.now();
  const imported = await page.evaluate((text) => window.demo.importText(text), JSON.stringify(exported));
  record.timings.importMs = Date.now() - started;
  await page.evaluate(() => window.demo.embedding);
  const reembed = await recallThroughForm(page, "Who looks after my teeth?");
  record.timings.recallWithReembedOfAllMs = reembed.pageMs;
  const restored = await page.evaluate(() => window.demo.memory.list());
  const same = exported.memories.every((m) => restored.some((r) => r.id === m.id && r.text === m.text && r.kind === m.kind && r.pinned === m.pinned && r.createdAt === m.createdAt));
  check("export, delete all, import: every memory comes back (F21)", imported.added === exported.memories.length && same && reembed.hits[0]?.text === FACTS[6].text, { exported: exported.memories.length, imported, top: reembed.hits[0] });

  // F16: 10,000 memories in IndexedDB, with the real model's vector size.
  const bulk = await memoryPage(fox, "?store=bulk");
  record.timings.bulk = await bulk.evaluate(async () => {
    // This function runs in the page, so its helpers must live inside it.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const vectors = (n) => {
      const v = new Float32Array(384);
      for (let i = 0; i < 384; i++) v[i] = Math.sin(n * 12.9898 + i * 78.233) % 1;
      let binary = "";
      for (const byte of new Uint8Array(v.buffer)) binary += String.fromCharCode(byte);
      return btoa(binary);
    };
    let t = performance.now();
    await window.demo.mind.embed(["load the model"]);
    const modelLoadMs = performance.now() - t;
    const memories = Array.from({ length: 10_000 }, (_, n) => ({ id: `bulk-${n}`, text: `Bulk note ${n}`, kind: "fact", source: "e2e", createdAt: n, updatedAt: n, pinned: false, model: "Xenova/all-MiniLM-L6-v2", vector: vectors(n) }));
    t = performance.now();
    await window.demo.memory.importAll({ format: "foxmemory", version: 1, exportedAt: 0, memories }, { trustVectors: true });
    const importMs = performance.now() - t;
    t = performance.now();
    await window.demo.memory.recall("a note about the weather", { k: 5 });
    const firstRecallMs = performance.now() - t;
    t = performance.now();
    await window.demo.memory.recall("a note about the garden", { k: 5 });
    const warmRecallMs = performance.now() - t;
    return { items: 10_000, modelLoadMs: Math.round(modelLoadMs), importMs: Math.round(importMs), firstRecallMs: Math.round(firstRecallMs), warmRecallMs: Math.round(warmRecallMs) };
  });
  const fresh = await memoryPage(fox, "?store=bulk");
  Object.assign(
    record.timings.bulk,
    await fresh.evaluate(async () => {
      let t = performance.now();
      await window.demo.mind.embed(["load the model"]);
      const coldPageModelLoadMs = Math.round(performance.now() - t);
      t = performance.now();
      await window.demo.memory.recall("a note about the sea", { k: 5 });
      return { coldPageModelLoadMs, coldPageRecallMs: Math.round(performance.now() - t) };
    }),
  );
  check("10,000 memories: the first recall in a new page, model loaded, under 2 s (F16)", record.timings.bulk.coldPageRecallMs < 2000, record.timings.bulk);
  await fresh.close();
  await bulk.close();

  // F41: 256 records of mixed length embed in under 60 s, and each stored vector
  // is the vector of its own text, so the order is restored. MiniLM runs as q8,
  // which scales activations per batch, so a vector differs a little (about
  // 0.03 per value) from the one embedded alone. Compare by cosine and by rank.
  const mixed = await memoryPage(fox, "?store=mixed");
  record.timings.mixed = await mixed.evaluate(async () => {
    let seed = 12345;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const words = ["note", "plan", "trip", "mail", "tea", "stove", "garden", "invoice", "train", "doctor", "soon", "later", "red", "quiet", "bridge", "paper"];
    const texts = Array.from({ length: 256 }, (_, n) => {
      const chars = n === 0 ? 59 : n === 1 ? 2871 : 59 + Math.floor(rand() ** 2 * 2812);
      let text = `Record ${n}:`;
      while (text.length < chars) text += ` ${words[Math.floor(rand() * words.length)]}`;
      return text.slice(0, chars).trim();
    });
    await window.demo.mind.embed(["load the model"]);
    const t = performance.now();
    await window.demo.memory.rememberMany(texts.map((text) => ({ text })));
    const embedMs = Math.round(performance.now() - t);
    const stored = (await window.demo.memory.exportAll({ vectors: true })).memories;
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const decode = (b64) => new Float32Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    const alone = [];
    for (const text of texts) alone.push((await window.demo.mind.embed([text])).vectors[0]);
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
    let minCosine = 1;
    let wrongRank = 0;
    let missing = 0;
    for (const [n, text] of texts.entries()) {
      const memory = stored.find((m) => m.text === text);
      if (!memory?.vector) {
        missing++;
        continue;
      }
      const got = decode(memory.vector);
      const scores = alone.map((vector) => dot(got, vector));
      minCosine = Math.min(minCosine, scores[n]);
      if (scores.indexOf(Math.max(...scores)) !== n) wrongRank++;
    }
    return { records: texts.length, embedMs, minCosine: Math.round(minCosine * 1e5) / 1e5, wrongRank, missing };
  });
  const mixedTimings = record.timings.mixed;
  check(`256 mixed-length records embed in ${(mixedTimings.embedMs / 1000).toFixed(1)} s, under 60 s (F41)`, mixedTimings.embedMs < 60_000, mixedTimings);
  check("each stored vector is closest to its own text embedded alone, cosine above 0.95 (F41)", mixedTimings.missing === 0 && mixedTimings.wrongRank === 0 && mixedTimings.minCosine > 0.95, mixedTimings);
  await mixed.close();
  await page.close();
  await fox.close();

  // F29: Firefox stops the idle background page after 2 s here. The model
  // lives in the Memory page, so a cold load (a new profile downloads the
  // model again) and an idle gap do not break remember or recall.
  fox = await launch({ extension: "dist-ext", headless, prefs: { "extensions.background.idle.timeout": 2000 } });
  const page2 = await memoryPage(fox, "?store=unload");
  const cold = Date.now();
  await addThroughForm(page2, { text: "The boiler service is booked for October.", kind: "fact" }, 1);
  record.timings.coldRememberShortIdleMs = Date.now() - cold;
  await new Promise((done) => setTimeout(done, 8000));
  const afterIdle = await recallThroughForm(page2, "When is the heating checked?");
  record.timings.recallAfterIdleMs = afterIdle.ms;
  check("a cold model load and an idle gap with a 2 s background timeout (F29)", afterIdle.hits[0]?.text === "The boiler service is booked for October.", afterIdle.hits);
} catch (error) {
  record.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await fox?.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", headless ? "e2e" : "e2e-headed", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}`);
console.log(JSON.stringify(record.timings));
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
