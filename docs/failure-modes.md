# Failure modes

This file lists every way foxmemory can fail that we know of. Each row has a
test. The tests went in before the code. Unit tests use a fake embedder that
gives the same vector for the same text, so each result is exact. The E2E test
(`pnpm e2e`) runs a real embedding model in Firefox.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F1 | Duplicate memories pile up: the same text comes in twice, maybe with other case or spaces. | One record. The second call returns `deduped: true`, refreshes `updatedAt`, and keeps `pinned` when either call set it. | `tests/core.test.ts` |
| F2 | Recall returns expired items. | `recall`, `list` and `get` never return an item after its `expiresAt`. The next write deletes it. | `tests/core.test.ts` |
| F5 | Secret text reaches the embedder or the store before the `redact` hook runs. | `redact` runs first. The embedder and the store get only its output. When it returns `null`, nothing is stored and the call fails with `redacted`. | `tests/core.test.ts` |
| F7 | Bad input (empty text, unknown kind, bad date) is stored. | It fails with `bad_input`. Nothing is stored. | `tests/core.test.ts` |
| F8 | Recall on an empty store, or with `k` at 0, throws. | It returns an empty list. `k`, `kinds` and `minScore` filter the hits. | `tests/core.test.ts` |
| F9 | The recency boost lets a new, unrelated memory beat an old, close one. | The boost is small (default 0.05). A close match always wins over a far one. | `tests/core.test.ts` |
