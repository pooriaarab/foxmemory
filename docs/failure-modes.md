# Failure modes

This file lists every way foxmemory can fail that we know of. Each row has a
test. The tests went in before the code. Unit tests use a fake embedder that
gives the same vector for the same text, so each result is exact. The E2E test
(`pnpm e2e`) runs a real embedding model in Firefox.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F1 | Duplicate memories pile up: the same text comes in twice, maybe with other case or spaces. | One record. The second call returns `deduped: true`, refreshes `updatedAt`, and keeps `pinned` when either call set it. | `tests/core.test.ts` |
| F2 | Recall returns expired items. | `recall`, `list` and `get` never return an item after its `expiresAt`. The next write deletes it. | `tests/core.test.ts` |
| F3 | Forget leaves vectors behind. | `forget` removes the record and its vector from the store in one write. A second `forget` returns `false`. | `tests/core.test.ts`, `tests/file.test.ts` |
| F4 | `forgetWhere({})` deletes everything by accident. | An empty filter fails with `bad_input`. `clear()` is the only way to delete all. | `tests/core.test.ts` |
| F5 | Secret text reaches the embedder or the store before the `redact` hook runs. | `redact` runs first. The embedder and the store get only its output. When it returns `null`, nothing is stored and the call fails with `redacted`. | `tests/core.test.ts` |
| F6 | `update` changes the text but keeps the old vector. | A new text gets a new vector. A change to `pinned` only does not call the embedder. | `tests/core.test.ts` |
| F7 | Bad input (empty text, unknown kind, bad date) is stored. | It fails with `bad_input`. Nothing is stored. | `tests/core.test.ts` |
| F8 | Recall on an empty store, or with `k` at 0, throws. | It returns an empty list. `k`, `kinds` and `minScore` filter the hits. | `tests/core.test.ts` |
| F9 | The recency boost lets a new, unrelated memory beat an old, close one. | The boost is small (default 0.05). A close match always wins over a far one. | `tests/core.test.ts` |
| F10 | `update` of an unknown id fails without a clear reason. | It fails with `not_found`. | `tests/core.test.ts` |
| F11 | An embedding model swap mixes two vector spaces. | Each record keeps its model id and dimension. Recall compares only vectors from the query's model. It embeds other records again first, in batches, and keeps them. | `tests/models.test.ts` |
| F12 | The embedder changes model during a batch of re-embedding. | The call fails with `embed_failed`. Batches done before keep the new vectors. No record holds a vector from the wrong model. | `tests/models.test.ts` |
| F13 | An embedding call fails in the middle of `rememberMany`. | Nothing from that call is stored. It fails with `embed_failed`, and the cause is kept. | `tests/models.test.ts` |
| F14 | The embedder returns the wrong count, the wrong size, or `NaN`. | It fails with `embed_failed`. Nothing is stored. | `tests/models.test.ts` |
| F15 | The store grows without a limit. | Over `maxItems`, the oldest unpinned items go first, and the result lists them. Pinned items never go. When all are pinned, the call fails with `full`. | `tests/models.test.ts` |
| F16 | A huge store makes recall slow. | 10,000 items recall in under 200 ms in Node, without the embed call. The E2E test measures it in Firefox. | `tests/models.test.ts`, E2E |
| F17 | An import file is malformed: not JSON, wrong format, a bad field, a bad vector. | It fails with `bad_import`, and the message names the item and the field. Nothing is written. | `tests/exchange.test.ts` |
| F18 | An import brings duplicates of stored memories. | Same id or same text: one record is kept. | `tests/exchange.test.ts` |
| F19 | An import brings vectors from another model. | They are kept with their model id and embedded again at the next recall (F11). | `tests/exchange.test.ts` |
| F20 | An import skips the `redact` hook. | Imported text goes through `redact`. Text that changes loses its old vector. | `tests/exchange.test.ts` |
| F21 | Export and import lose data. | A round trip keeps text, kind, source, dates and `pinned`. | `tests/exchange.test.ts`, E2E |
