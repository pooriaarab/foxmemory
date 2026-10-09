// The Memory page. It runs the embedding model (MiniLM through foxmind) and
// opens the IndexedDB store itself, so two open Memory pages are two writers
// on one store.
import { createMind } from "foxmind";
import { transformers } from "foxmind/browser";
import { createMemory, indexedDbStore } from "../src/index.js";

const storeName = new URLSearchParams(location.search).get("store") ?? "demo";
// Memories are private: the router may use only on-device and same-machine models.
const mind = createMind({ providers: [transformers({ task: "embed" })], only: ["browser", "local"] });
const memory = createMemory({ store: indexedDbStore(storeName), embedder: mind });
// Other open Memory pages draw the list again after each change here.
const channel = new BroadcastChannel(`foxmemory:${storeName}`);
const $ = (id) => document.getElementById(id);
const KIND_NAMES = { fact: "Fact", preference: "Preference", "task-note": "Task note" };

function say(text, isError = false) {
  $("status").textContent = text;
  $("status").style.color = isError ? "var(--danger)" : "";
}

async function attempt(action) {
  try {
    return await action();
  } catch (error) {
    say(error.code ? `${error.code}: ${error.message}` : error.message, true);
    return undefined;
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(label, onClick, extra = {}) {
  return el("button", { type: "button", textContent: label, onclick: onClick, ...extra });
}

async function changed(message) {
  // BroadcastChannel.postMessage takes no target origin; the rule is for window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  channel.postMessage("changed");
  if (message) say(message);
  await render();
}

function row(item) {
  const when = new Date(item.updatedAt).toLocaleString();
  const text = el("p", { className: "text", textContent: item.text });
  const meta = el("div", { className: "meta", textContent: `${KIND_NAMES[item.kind]} · from ${item.source} · updated ${when}${item.pinned ? " · pinned" : ""}` });
  const li = el("li", {}, text, meta);
  li.dataset.id = item.id;
  li.dataset.pinned = String(item.pinned);
  const edit = () => {
    const box = el("textarea", { className: "edit", value: item.text, rows: 2 });
    const save = () =>
      attempt(async () => {
        await memory.update(item.id, { text: box.value });
        await changed("Saved the change.");
      });
    text.replaceWith(box);
    actions.replaceChildren(button("Save", save, { className: "save" }), button("Cancel", () => render()));
    box.focus();
  };
  const actions = el(
    "div",
    { className: "row actions" },
    button("Edit", edit, { className: "edit-button" }),
    button(item.pinned ? "Unpin" : "Pin", () => attempt(async () => {
      await memory.update(item.id, { pinned: !item.pinned });
      await changed(item.pinned ? "Unpinned." : "Pinned. Pinned memories are never removed to make room.");
    }), { className: "pin" }),
    button("Delete", () => attempt(async () => changed((await memory.forget(item.id)) ? "Deleted the memory." : "It was deleted already.")), { className: "delete danger" }),
  );
  li.append(actions);
  return li;
}

async function render() {
  const contains = $("search").value.trim();
  const [items, stats] = await Promise.all([memory.list(contains ? { contains } : {}), memory.stats()]);
  const models = Object.keys(stats.models).filter((model) => model !== "none");
  $("stats").textContent = `${stats.count} ${stats.count === 1 ? "memory" : "memories"}, ${stats.pinned} pinned${models.length ? ` · embedding model: ${models.join(", ")}` : ""}`;
  $("list").replaceChildren(...items.map(row));
  document.body.dataset.count = String(stats.count);
  document.body.dataset.ready = "1";
}

$("add").addEventListener("submit", (event) => {
  event.preventDefault();
  attempt(async () => {
    const result = await memory.remember($("new-text").value, { kind: $("new-kind").value, pinned: $("new-pinned").checked, source: "user" });
    $("new-text").value = "";
    await changed(result.deduped ? "You told me this already. I refreshed it." : "Saved.");
  });
});

$("recall").addEventListener("submit", (event) => {
  event.preventDefault();
  const hits = $("hits");
  delete hits.dataset.done;
  attempt(async () => {
    const started = performance.now();
    const found = await memory.recall($("query").value, { k: 3 });
    const ms = Math.round(performance.now() - started);
    hits.replaceChildren(
      ...found.map((hit) => el("li", {}, el("span", { className: "score", textContent: hit.similarity.toFixed(2) }), hit.memory.text, el("div", { className: "meta", textContent: KIND_NAMES[hit.memory.kind] }))),
    );
    say(found.length ? `${found.length} best matches in ${ms} ms. The number is the similarity, from 0 to 1.` : "No memory matches.");
    hits.dataset.ms = String(ms);
    hits.dataset.done = "1";
  });
});

$("search").addEventListener("input", () => render());

$("export").addEventListener("click", () =>
  attempt(async () => {
    const text = JSON.stringify(await memory.exportAll(), null, 2);
    window.demo.exports.push(text);
    const link = el("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: `foxmemory-${new Date().toISOString().slice(0, 10)}.json` });
    link.click();
    URL.revokeObjectURL(link.href);
    say("Exported every memory to a JSON file.");
  }),
);

async function importText(text) {
  const result = await memory.importAll(text);
  await changed(`Imported: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped.`);
  return result;
}

$("import").addEventListener("change", () => attempt(async () => importText(await $("import").files[0].text())));

let armed = false;
$("clear").addEventListener("click", () =>
  attempt(async () => {
    if (!armed) {
      armed = true;
      $("clear").textContent = "Click again to delete all";
      setTimeout(() => {
        armed = false;
        $("clear").textContent = "Delete all";
      }, 4000);
      return;
    }
    armed = false;
    $("clear").textContent = "Delete all";
    await memory.clear();
    await changed("Deleted every memory.");
  }),
);

channel.addEventListener("message", () => render());
// For tests and the console: the memory, the model router, and the text of each export.
window.demo = { memory, mind, exports: [], importText };
attempt(render);
