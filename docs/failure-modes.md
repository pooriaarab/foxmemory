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
| F19 | An import brings vectors from another model. | With `trustVectors: true`, they are kept with their model id and embedded again at the next recall (F11). | `tests/exchange.test.ts` |
| F20 | An import skips the `redact` hook. | Imported text goes through `redact`. Text that changes loses its old vector. | `tests/exchange.test.ts` |
| F21 | Export and import lose data. | A round trip keeps text, kind, source, dates and `pinned`. | `tests/exchange.test.ts`, E2E |
| F22 | Two writers on one store file lose a write. | A lock file serializes writes, and each writer reloads a changed file before it writes. | `tests/file.test.ts` |
| F23 | A crash during a write leaves half a file, or a broken file is read as empty and then overwritten. | Writes go to a temp file and then rename. A broken file fails with `corrupt` and stays as it is. | `tests/file.test.ts` |
| F24 | A lock file from a crashed process blocks writes forever. | A lock older than `staleMs` is taken over. A live lock that does not clear fails with `locked`. | `tests/file.test.ts` |
| F25 | The CLI gets bad arguments. | It prints the usage and exits with code 2. | `tests/cli.test.ts` |
| F26 | Two extension pages write to one IndexedDB store at once. | Web Locks serialize the writes. No record is lost and no duplicate is stored. | `tests/idb.test.ts`, E2E |
| F27 | A page keeps a stale copy after another page writes. | Each call checks the store version and reloads when it changed. | `tests/idb.test.ts`, E2E |
| F28 | IndexedDB cannot open (for example, the profile blocks storage). | It fails with `unavailable` and the browser's reason. | `tests/idb.test.ts` |
| F29 | Firefox stops an idle background page even while it owes a reply, so a slow model load there fails with "Receiving end does not exist". | The demo runs the model in the Memory page, not in the background page. A cold load with a 2 s background timeout still works. | E2E |
| F30 | Recall by meaning does not work with a real model. | 20 facts with MiniLM: each paraphrased question finds its fact in the top 3. | E2E |
| F31 | An edit or a delete on the Memory page does not last. | After a reload, the page shows the edit and not the deleted memory. | E2E |
| F32 | A writer holds the lock file longer than `staleMs` (for example during a long re-embed), and another writer takes it over. | The holder refreshes the lock file's time while it works, so a live lock never looks stale. | `tests/lock.test.ts` |
| F33 | Two writers see the same stale lock at once, and both take it over. | Takeover moves the stale lock aside under a unique name, then creates a new lock with `wx`. A writer writes only while the lock file holds its own random token. | `tests/lock.test.ts` |
| F34 | A writer that lost its lock deletes, or writes past, the new owner's lock. | It releases only a lock that holds its token. A write without its token fails with `locked`. | `tests/lock.test.ts` |
| F35 | A re-embed batch writes back a memory that another writer deleted meanwhile. | Before each batch write, recall reads the store again and writes only ids that are still there. | `tests/lock.test.ts` |
| F36 | A failed write or a crash leaves a temp file with every memory, deleted ones too, in plain text. | A failed write deletes its temp file. The next lock holder deletes old temp files of the store. | `tests/lock.test.ts` |
| F37 | A hostile import file brings a crafted vector, so its memory ranks first for a chosen question (memory poisoning, then prompt injection). | importAll drops every imported vector unless the caller sets `trustVectors: true`. Recall embeds the text itself. | `tests/exchange.test.ts` |
| F38 | An import file sets `updatedAt` far in the future, so its memory gets the full recency boost and is never evicted. | importAll sets `createdAt` and `updatedAt` to now at most. | `tests/exchange.test.ts` |
| F39 | One import file holds the same id twice, and both count as added. | It fails with `bad_import` and names both items. | `tests/exchange.test.ts` |
| F40 | In merge mode, an imported id matches a stored memory with other text, and the import replaces that memory. | The imported item gets a new id. The stored memory stays as it was. | `tests/exchange.test.ts` |

## AMO release build and listed submission (`scripts/amo-listing.mjs`)

`pnpm check:amo` reads `dist-ext/`, which is what `release.yml` signs. Each
row is a way that the listed build or the submission can go wrong.

| ID | Failure | Wanted result |
|---|---|---|
| AR1 | `dist-ext/` is missing, so the check reads nothing | The check stops and says to run `pnpm build:ext` |
| AR2 | A content script in the release manifest matches `127.0.0.1`, `localhost` or `*.localhost` (a test bridge) | The check stops and names the pattern |
| AR3 | A host permission for a local host exists only for tests | The check stops, unless `local_hosts` in the listing gives a reason for that exact pattern |
| AR4 | A file named for tests (`e2e`, `fixture`, `test`, `spec`) is in `dist-ext/` | The check stops and names the file |
| AR5 | `dist-ext/` came from `build-ext.mjs --e2e` | AR2 or AR4 stops it |
| AR6 | The `local_hosts` reasons go to AMO as an unknown field | `metadata` leaves them out, as it does the privacy policy |
| AR7 | A re-run submits a version that AMO already has as listed | `version-status` says `listed`, and the step skips web-ext sign and finishes the release |
| AR8 | AMO has the version as unlisted | `version-status` stops and says to bump the version |
| AR9 | The AMO version lookup fails (401, 500, network) | `version-status` stops; it never guesses `absent` |
| AR10 | The add-on already exists on AMO, and the version lookup sends a parameter AMO refuses on a single version (400), so every release stops | `version-status` asks for `versions/v<version>/` with no query; an owner sees listed and unlisted versions there |

| ID | Failure | Wanted result |
|---|---|---|
| AR-U1 | A `local_hosts` reason for a host permission also clears a test content script on the same pattern | Each reason names its use (`host_permission`, `content_script`, `web_accessible_resource`, `externally_connectable`); a use without its own reason stops the check |
| AR-U2 | `local_hosts` keeps a reason for a use that the release build does not have | The check stops and names the pattern and the use |
