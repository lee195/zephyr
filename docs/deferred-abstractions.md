# Deferred abstractions

Code that appears exactly twice stays duplicated until a third copy shows up, unless sharing it costs a reader nothing. This page lists each known pair, so the next person to add a third copy knows to extract it. Code repeated three or more times is already shared.

Reviewed on 2026-10-19 at commit `d5b510f`, and again on 2026-10-20 for the open-issues work.

## Extract when a third copy appears

| Pair | Where | Shared form when it's time |
|---|---|---|
| Ops validator skeleton: check the `ops` array, each op object, its `sources` array, drop ops with no known source | `src/kinds/organizer.ts` `validateOps`, `src/kinds/tasks.ts` `validateTaskOps` | `parseOps(json, (op, i) => Op \| Dropped \| Error)` in `src/kinds/common.ts`. A third ops-based kind is the trigger. |
| Validation result types | `Validation` in `organizer.ts`, `TaskValidation` in `tasks.ts` | `OpsValidation<Op>` alongside `parseOps` |
| `plan()` prelude: the run's entry ids and new entries | `organizer.ts` `plan`, `tasks.ts` `plan` | `runEntries(run, world)` in `common.ts`. The organizer still needs the id set for recent entries. |
| Rank the new entries' text and keep the top N ids | `organizer.ts` open topics, `tasks.ts` open tasks | `topRanked(world, newEntries, docs, n)` in `common.ts`. It must still wait for every doc to be embedded (`rankAll`). |
| Trimmed optional string check | `organizer.ts` title, `tasks.ts` `text` | Move `text` to `common.ts` |
| Write to a tmp file, then rename into place | `src/store.ts` `writeAtomic`, `src/embedding.ts` `compact` | Export `writeAtomic` from a small `src/files.ts` |
| Tolerant JSONL load that skips torn lines | `src/store.ts` `readText` + `parseJsonl`, `src/embedding.ts` `load` | Export from a small `src/jsonl.ts` |
| A done run with timestamps | `src/zephyr.ts` `migrateCoverage`, `scripts/measure-organizer-prompt.ts` | An exported `doneRun` in `src/` |
| Fake relevance that gives every doc one score | `test/hints.test.ts` `scoring`, `test/relevance.test.ts` `fixed` | A helper with a call counter in `test/helpers.ts` |
| Hint limit check, an integer from 1 to 5 | `src/server.ts` `hints` (query string), `src/mcp.ts` `search_notes` (JSON) | `parseHintLimit(raw)` in `src/hints.ts` taking the raw value |
| `afterEach` cleanup arrays | `test/hints.test.ts`, `test/warm.test.ts` | `useCleanup()` in `test/helpers.ts` |
| Short date-and-time formatter `when` | `viewer/src/TopicCard.vue`, `viewer/src/SummariesPage.vue` | `when(iso)` in a small `viewer/src/format.ts` |
| List a folder of ISO-named files and parse each name or file | `src/store.ts` `listHistory`, `listSummaries` | `listNamed(dir, parse)` in `store.ts`, sorting newest first |
| Read one file by an ISO name checked against `ISO_AT` | `src/store.ts` `readHistory`, `readSummary` | `readNamed(dir, at, ext)` in `store.ts` |
| Split a route's rest into decoded segments, then answer a list or one item | `src/server.ts` `history`, `summaries` | `listOrOne(rest, depth, list, one)` in `server.ts` |
| A harness backend: pick the binary, split the messages into instructions and input, run the CLI, parse its reply | `src/backends.ts` `claudeCode`, `opencode` | A `harnessBackend({ name, bin, args, files, parse })` in `backends.ts`. A third harness is the trigger. |
| Token usage from a harness reply: prompt tokens plus cache reads, output tokens, cached tokens | `src/backends.ts` `claudeReply`, `opencodeReply` | A `usageOf(input, cacheRead, output)` next to them. The two CLIs name the fields differently, so only the arithmetic is shared. |
| Missing endpoint, then missing key, with a hint on where to set it | `src/backends.ts` `chatEndpoint` and `chatCompletion`, `src/relevance.ts` `relevanceBackends.embedding` | An `endpointKey(endpoint, what)` in `src/config.ts`, which owns the variable names |
| Which model answers, as one line | `src/main.ts` startup log, `scripts/measure-deeper.ts` report | A `describeModel(config)` in `src/config.ts` |
| An archived version's and a saved summary's shape, written again in the viewer | `ArchivedVersion` and `SavedSummary` in `src/store.ts`; inline types in `viewer/src/TopicCard.vue` and `Saved` in `viewer/src/SummariesPage.vue` | A type-only import from `src/store.ts`, as the viewer already does from `src/domain.ts` |

## Leave as two copies

| Pair | Where | Why they stay apart |
|---|---|---|
| Sources union on update | `organizer.ts`, `tasks.ts` | The organizer orders sources by entry order, tasks by insertion order. A shared version needs a parameter for exactly that difference. |
| Cosine similarity | `src/relevance.ts` (sparse maps), `src/embedding.ts` (dense float arrays) | Same math on different data. Sharing forces one vector representation on both. |
| Grouping views into a map of arrays | `viewer/src/live.ts` `derivedBySource`, `viewsByKind` | Different keys and filters. They only look alike. |
| Done-task filter and task-list lookup | `src/kinds/tasks.ts`, `viewer/src/App.vue`, `viewer/src/live.ts` | The viewer imports only types from `src/`. Importing `kinds/tasks` would pull `node:fs` into the browser bundle through relevance and embedding. |
| The explicit seed in the last warm test | `test/warm.test.ts` `seeded()` and the organizer-wait test | Spelling out the seed shows the extra entry `e4` that the test depends on. |

## Shared once a third copy appeared

- The organizer corpus load and its `Subject` type. `scripts/measure-deeper.ts` was the third reader, so all three scripts now use `loadCorpus` from `scripts/corpus.ts`.
- A topic's stale marker, `bodyStale` with the titles merged in since the last rewrite. It is built in four places, so `staleMarker` in `src/domain.ts` holds the rule that the titles travel only with `bodyStale`.

## Repeated three times or more, but deliberately not shared

These are single expressions where the thing that could change already has one name, so a helper would only add a lookup.

- `views.filter((v) => v.kind === kind)` where the kind is a variable (`src/zephyr.ts`, `src/kinds/visualizer.ts`). Topic lookups go through `topicsIn`.
- The `if (!result.ok) return result` narrowing guard in the kinds.
- The best-first sort `(a, b) => b.score - a.score`.
- `text.slice(0, MAX_CHARS)` in `embedding.ts`. The limit is the constant.
- The `[zephyr]` log prefix on console calls.
- Fallback timing options in tests. Each test shows the timing it depends on.
- Assertion code in tests.
