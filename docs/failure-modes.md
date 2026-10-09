# Failure modes

This file lists every way foxmemory can fail that we know of. Each row has a
test. The tests went in before the code. Unit tests use a fake embedder that
gives the same vector for the same text, so each result is exact. The E2E test
(`pnpm e2e`) runs a real embedding model in Firefox.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F1 | Duplicate memories pile up: the same text comes in twice, maybe with other case or spaces. | One record. The second call returns `deduped: true`, refreshes `updatedAt`, and keeps `pinned` when either call set it. | `tests/core.test.ts` |
| F7 | Bad input (empty text, unknown kind, bad date) is stored. | It fails with `bad_input`. Nothing is stored. | `tests/core.test.ts` |
