# foxmemory

[![npm version](https://img.shields.io/npm/v/foxmemory)](https://www.npmjs.com/package/foxmemory)
[![Downloads/month](https://img.shields.io/npm/dm/foxmemory)](https://www.npmjs.com/package/foxmemory)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime_dependencies-0-green)](https://www.npmjs.com/package/foxmemory)

[Quickstart](#remember-your-first-preference) · [API reference](#runtime-surfaces) · [Storage coverage](#coverage) · [FAQ](#faq)

foxmemory is an open-source local memory library for JavaScript AI agents that stores user-editable facts, preferences, and task notes.
It ranks memories with embeddings from an embedder you supply.
It supports browser IndexedDB, Node.js JSON files, and in-process memory.

## Install

```bash
npm install foxmemory
```

Node.js 24 or later is required for the Node.js entry point and CLI.
The library includes TypeScript declarations and has zero runtime dependencies.
Browser storage needs IndexedDB and Web Locks.

## Remember your first preference

Save this as `example.mjs` and run `node example.mjs`.
This deterministic embedder demonstrates storage and recall; it is not a language model.
No environment variables, API keys, or `.env` file are needed.

```js
import { createMemory, memoryStore } from "foxmemory";

const memory = createMemory({
  store: memoryStore(),
  embedder: {
    async embed(texts) {
      return { model: "coffee-demo-v1", vectors: texts.map(() => [1, 0]) };
    },
  },
});
await memory.remember("I take my coffee with oat milk.", { kind: "preference" });
const [hit] = await memory.recall("How do I like my coffee?");
console.log(hit.memory.text);
```

Success prints `I take my coffee with oat milk.`
For semantic search, replace the demo embedder with a model such as Ollama through foxmind.
Use a local provider policy if memory text must stay on your device.

## How it works

```text
Text -> optional redact hook -> embedder -> deduplicate -> store
Query -> embedder -> refresh stale vectors -> cosine score + recency -> top k
```

Recall scans all stored vectors.
A model or dimension change causes old records to receive new embeddings.
Writes use the store's lock and version to coordinate writers.

## Why it exists

Agents need memories that users can inspect, correct, export, and delete.
Mem0 provides a memory engine; LangGraph provides memory stores within its agent framework.
foxmemory supplies explicit record operations and local storage without an agent framework or database service.
Your application decides what to remember and which embedder to call.

## Compare

Scope checked on 2026-10-14 against [Mem0 documentation](https://github.com/mem0ai/mem0/blob/main/docs/open-source/overview.mdx)
and [LangGraph documentation](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/memory.md).

| Property | foxmemory | Mem0 open source | LangGraph memory |
|---|---|---|---|
| Scope | Explicit records and vector recall | Agent memory engine | Memory stores for graph applications |
| Deployment | Library in your browser or Node.js process | Library or self-hosted server | Store inside an application |
| Configuration | Store and embedder objects | Memory engine configuration | Namespaces, keys, and store configuration |
| Storage coverage | IndexedDB, JSON file, process memory | Configurable backend stack | JSON documents in a store |

## Coverage

The source exports three implemented storage adapters.
The embedder is an interface, not a registry of model providers.

| Surface | Status | Implementation |
|---|---|---|
| Browser IndexedDB | ✓ | `indexedDbStore`; Web Locks coordinates writes |
| Node.js JSON file | ✓ | `fileStore` from `foxmemory/node`; lock file and atomic rename |
| In-process memory | ✓ | `memoryStore`; data ends with the process |
| foxmind | ✓ | Its `embed` reply matches the embedder interface |
| Ollama | Pending live verification | Caller supplies a foxmind provider; no built-in adapter |
| Hugging Face Transformers.js | Demo integration | Firefox demo uses MiniLM through foxmind |

Storage and embedder behavior have local automated tests.
This rewrite does not credential-check a model service or verify WebGPU execution.
No storage adapter above is a scaffold.

## Common use cases

1. Firefox extension developers store editable preferences in IndexedDB with MiniLM through foxmind.
2. Node.js agent developers persist task notes in JSON and export backups with the foxmemory CLI.
3. foxmate builders recall user facts and expose a Memory page for corrections.
4. Ollama application developers provide local embeddings for search over saved passages.

## Features

- **Editable records:** remember, list, update, pin, and delete memories through the [API](#runtime-surfaces).
- **Ranked recall:** cosine similarity, recency weighting, kind filters, and score thresholds; see [limits](#delivery-and-behavior-limits).
- **Retention:** expiry and eviction of old unpinned records within `maxItems`; see the [API](#runtime-surfaces).
- **Portable exports:** JSON import and export; imported vectors are discarded by default.
- **Redaction hook:** transform or refuse stored text before embedding; recall queries bypass this hook.

## Runtime surfaces

### `foxmemory`

| Export | What it does |
|---|---|
| `createMemory({ store, embedder, redact?, maxItems?, batchSize?, recencyWeight?, halfLifeMs?, now? })` | Makes a memory. `embedder` is any object with `embed(texts) → { vectors, model }`, for example a foxmind `Mind`. Defaults: `maxItems` 10000, `batchSize` 32, `recencyWeight` 0.05, `halfLifeMs` 30 days. |
| `memory.remember(text, { kind?, source?, pinned?, ttlMs?, expiresAt? })` | Stores one memory. Returns `{ memory, deduped, evicted }`. `kind` is `fact` (default), `preference` or `task-note`. `source` defaults to `user`. |
| `memory.rememberMany(items)` | Stores many in one write. When one embed call fails, it stores none. |
| `memory.recall(query, { k?, kinds?, minScore? })` | The best `k` (default 5) memories: `[{ memory, similarity, score }]`. `minScore` applies to `similarity`. |
| `memory.update(id, { text?, kind?, source?, pinned?, expiresAt? })` | Changes a memory. A new text gets a new vector. `expiresAt: null` removes the expiry. |
| `memory.forget(id)` | Deletes one memory and its vector. Returns `false` when there was none. |
| `memory.forgetWhere({ kinds?, source?, contains?, before?, pinned? })` | Deletes every match and returns the count. An empty filter fails. |
| `memory.clear()` | Deletes every memory. |
| `memory.list({ kinds?, contains? })`, `memory.get(id)` | Reads memories, pinned first, then the newest. |
| `memory.stats()` | `{ count, pinned, models }`, where `models` counts the vectors of each model. |
| `memory.exportAll({ vectors? })` | A JSON object, `{ format: "foxmemory", version: 1, memories }`. Vectors are left out unless `vectors: true`. |
| `memory.importAll(data, { mode?, trustVectors? })` | Reads an export (object or JSON text). It checks the whole file before it writes, and refuses an id that appears twice. `mode` is `merge` (default) or `replace`. It drops the file's vectors unless `trustVectors` is true, sets `createdAt` and `updatedAt` to now at most, and gives an id that matches a stored memory with other text a new id. Returns `{ added, updated, skipped }`. |
| `memoryStore()` | A store in this process's memory, for tests. |
| `indexedDbStore(name)` | The browser store. Pages that use one name share the memories. |
| `FoxmemoryError` | Every failure. `code` is one of `bad_input`, `not_found`, `redacted`, `embed_failed`, `full`, `bad_import`, `corrupt`, `locked`, `unavailable`. |

The `redact(text, meta)` hook runs before the embedder sees a text, on
`remember`, `update` and `importAll`. Return the text to keep, or `null` to
refuse it. Recall queries do not go through `redact`: the query goes to the
embedder as it is, and foxmemory does not store it.

### `foxmemory/node`

| Export | What it does |
|---|---|
| `fileStore(path, { staleMs?, waitMs? })` | A store in one JSON file. Writes go to a temp file and then rename. A lock file next to it keeps writers apart: it holds the holder's random token, and the holder refreshes its time while it works. A lock not refreshed for `staleMs` (default 10 s) is taken over. A writer without its token in the lock file cannot write. |

### CLI

The CLI works on a `fileStore` file. It does not embed text.

```bash
npx foxmemory list memories.json
npx foxmemory search memories.json sister      # text match, not by meaning
npx foxmemory export memories.json > backup.json
npx foxmemory import memories.json backup.json  # --replace replaces all; --trust-vectors keeps the file's vectors
npx foxmemory forget memories.json <id>
```

Output of `list` on the file from the example:

```text
1e05603e-b7de-4e2e-8162-e2312adcbf9b  fact  -  My sister lives in Vancouver.
120c84a1-fb01-4e75-90b5-c1dbca7d0a32  preference  -  I take my coffee with oat milk.
```

The exit code is 0 when the command works, 1 when it fails, and 2 for bad
arguments. There is no MCP server.

### Demo extension

`extension/` is a small Firefox extension. Its toolbar button opens a Memory
page. The page lists every memory with a text filter, and you can edit,
delete and pin each one. It also adds a memory, tests recall, and exports or
imports a JSON file. It runs MiniLM (`Xenova/all-MiniLM-L6-v2`) through
foxmind on WASM or WebGPU. Build it with `pnpm build:ext` and load
`dist-ext/manifest.json` from `about:debugging`.

## Delivery and behavior limits

- Recall reads every memory. There is no vector index. We measured 10,000
  memories; we did not test 100,000.
- Each page or process holds all memories in memory. 10,000 vectors of 384
  numbers are about 15 MB.
- Dedupe matches exact text only, in any case and spacing. "I like tea" and
  "I love tea" stay two memories.
- After a model swap, the next recall embeds every old memory again while it
  holds the lock. With many memories, that recall is slow.
- The recency boost uses `updatedAt`, not the last time a memory was recalled.
- Memories are not encrypted. They sit in IndexedDB or in the JSON file as
  plain text. The `redact` hook is only a hook: foxmemory has no secret
  detector of its own.
- An import that would pass `maxItems` fails with `full`. It does not evict
  other memories.
- `fileStore` rewrites the whole file on each write. Its lock file works for
  processes on one machine. We did not test it on network file systems. A
  holder that stops refreshing for `staleMs` (for example, a paused process)
  loses the lock; its next write then fails with `locked`.
- Recall queries do not go through the `redact` hook.
- The CLI does not embed text, so `search` is a text match.
- The demo loads the model in each Memory page. We tried the background page
  first: with a 2 s idle timeout, Firefox stopped it during a model load, and
  the call failed with "Receiving end does not exist". The default timeout
  is 30 s, so a slow first download can hit the same problem.
- We ran the E2E test in headless Firefox 157 on macOS, so on WASM. We did not
  run it with WebGPU.

## Integration guides

- [Node.js persistent agent memory](#foxmemorynode): use `fileStore` with your embedder.
- [Firefox extension memory](#demo-extension): use IndexedDB and Web Locks.
- [CLI backup and deletion](#cli): list, search, export, import, and forget JSON-file records.

## Status

foxmemory is a 0.x package; its API and export behavior can change before 1.0.
Report problems through [GitHub issues](https://github.com/pooriaarab/foxmemory/issues).
Public case studies are not yet published.
The demo extension is a development surface; this README does not claim an approved add-on listing.

## FAQ

### What is foxmemory?

foxmemory is a local memory library for JavaScript agents.
It stores explicit records and ranks them with caller-supplied embeddings.

### Which integrations are verified?

foxmemory tests its three stores and embedding contract locally.
This rewrite does not verify a live Ollama server or WebGPU execution.

### Does foxmemory provide a managed memory service?

foxmemory runs in your application.
You supply storage and an embedder; it provides no managed service.

### How is foxmemory different from Mem0?

foxmemory exposes explicit record operations with three local stores.
[Mem0](https://github.com/mem0ai/mem0/blob/main/docs/open-source/overview.mdx) supplies a memory engine that can run as a library or self-hosted server.

### How is foxmemory different from LangGraph?

foxmemory works without a graph runtime.
[LangGraph](https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/memory.md) organizes long-term memories as namespaced JSON documents in stores.

### Does foxmemory send memories to a cloud model?

foxmemory calls the embedder you provide.
Choose a local embedder to keep text on your device; the library does not enforce that choice.

### Are foxmemory records encrypted?

foxmemory stores plain text in its built-in persistent stores.
Provide your own storage protection and redaction policy for sensitive data.

### Does the foxmemory CLI perform semantic search?

foxmemory CLI search matches text words.
Semantic recall needs the library API and an embedder.

## Development

```bash
pnpm install
pnpm ci:local
pnpm e2e
```

The local gate checks lint, types, tests, builds, and the extension listing.
The separate end-to-end command starts Firefox and downloads the demo embedding model.

## License

[MIT](https://opensource.org/license/mit)
