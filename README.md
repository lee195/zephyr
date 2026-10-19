# Zephyr

Take notes by typing into your agent harness. The Zephyr mod writes each note into the session transcript as a user row starting with `[zephyr] `. This server tails the registered transcripts, copies each note into `data/entries.jsonl`, runs agent kinds on the vLLM endpoint, and writes the derived views as plain files. A localhost viewer shows them live. The viewer only displays; input always comes from the harness.

## Run

```sh
bun install
wick exec --only vllm -- bun run start
```

`wick` injects `DEEPSEEK_API_KEY` into that one process. `start` builds the viewer when its sources are newer than `viewer/dist`, then serves everything on http://127.0.0.1:7317.

| Variable | Default |
| --- | --- |
| `ZEPHYR_PORT` | `7317` (bound to 127.0.0.1 only) |
| `ZEPHYR_DATA` | `./data` |
| `ZEPHYR_VLLM_URL` | `https://llm.example.com/v1` |
| `ZEPHYR_MODEL` | `deepseek-v4-flash-fast` |
| `ZEPHYR_SWEEP_MINUTES` | `30`: minutes between cleanup sweeps; any positive number |

Other scripts: `bun run dev` (server with reload), `bun run dev:viewer` (Vite, proxied to the server), `bun run build`, `bun test`.

## Data

```
data/
  entries.jsonl                 one Entry per line, append-only; receivedAt is when the server stored it
  sessions.json                 registered transcripts and where each read resumes
  views/<kind>/<slug>.md        view body (.svg / .txt for other formats)
  views/<kind>/<slug>.json      view metadata: title, sources, updatedAt, createdAt, pastTitles, appendsSinceWrite,
                                pins, bodyStale
  views/<kind>/.history/<slug>/<updatedAt>.md
                                a page as it was before a rewrite replaced it or an adjustment deleted it
  embeddings/<backend>.jsonl    cached document vectors; the sweep drops those no ranking can ask about
  runs.jsonl                    every finished run, append-only
  review.json                   { lastReviewedAt }: where the last review ended
  adjustments.jsonl             every adjustment: a request line, then a result line once it applied
```

The viewer does not show `.history`; the files are plain markdown next to the page.

## Cleanup sweep

On start and every `ZEPHYR_SWEEP_MINUTES`, the server sweeps:

- A topic an adjustment marked `bodyStale` is queued for a rewrite whatever its append count; see Adjustments.
- A topic whose last 5 writes each only extended its body (`appendsSinceWrite`, counted by the server from the bodies) reads like a log, so it is queued for a rewrite on the organizer's own queue. The model gets the page and every note it cites, in full, and returns the whole page. The rewrite must keep the slug and cite every note the page cites, or the run fails and retries. The old page goes to `.history`, and the diagram is redrawn. A topic whose body and notes exceed 32,000 characters is not rewritten. Notes waiting in the queue are filed before a rewrite. A rewrite whose attempts ran out is not tried again until the page changes or the server restarts.
- The embeddings cache is rewritten to hold only docs a ranking can still be asked about. It logs `[zephyr] sweep: queued N rewrites; embeddings cache … → …`.

## Harnesses

A note is a user row whose text starts with `[zephyr] `, in every harness. Each harness has an adapter in `src/adapters/` that reads its transcript into rows.

| Harness | Transcript (`transcriptPath`) | Capture |
| --- | --- | --- |
| `claude-code` | the session `.jsonl`, tailed from a byte offset | the Zephyr mod in `jlee-mods/zephyr` |
| `opencode` | opencode's SQLite database (`opencode db path`); each read returns the session's user text again and dedupe drops repeats | the `/note` TUI plugin in `jlee-mods/zephyr-opencode` |

## Kinds

Each kind writes only `views/<kind>/`, through its own serial queue.

| Kind | Runs on | Writes |
| --- | --- | --- |
| `organizer` | each new entry; a topic the sweep finds has become an append log | topic pages `organizer/<slug>.md` |
| `tasks` | each new entry | `tasks/tasks.json` holds the tasks as data (`{ id, text, due?, done, sources }`), `tasks/tasks.md` renders them |
| `visualizer` | an organizer topic with 4 or more sources, not stale, whose diagram is missing or older than the topic | `visualizer/<slug>.svg` or `.txt`, with `derivedFrom` naming the topic version it drew; deleted when its topic is gone or under 4 sources |

The viewer shows SVG only as `<img src="blob:…">`, so scripts in a diagram never run, and HTML responses carry a Content-Security-Policy that allows only the viewer's own scripts.

## Adjustments

Corrections the person makes after the fact. Each op is applied by a step on the queue of the kind that owns what it writes (the organizer for topics and notes, tasks for tasks), after the run in flight and before any waiting run, with no model call. So an adjustment never races a run that read the views before it.

| Op | Fields | Effect |
| --- | --- | --- |
| `renameTopic` | `slug, title` | Sets the title and pins it. |
| `mergeTopics` | `from, into` | Appends `from`'s body to `into` under `## <from title>`, moves its notes, makes `from` an alias of `into`, and deletes `from` and its diagram. |
| `splitTopic` | `slug, noteIds, into: { slug, title }` | Moves some, not all, of the topic's notes to a new topic with a pinned title. |
| `moveNote` | `noteId, from, to` | Takes the note off `from` and onto `to`, which does not cite it yet. |
| `detachNote` | `noteId, from, to` | Takes the note off `from`; `to` already cites it and keeps it. |
| `editNote` | `noteId, text` | Replaces the note's text for every kind, hint and ranking. Tasks are not re-run. |
| `tombstoneNote` | `noteId` | Removes the note everywhere: entries, every view's sources, hints. A topic left with no notes is deleted. |
| `editTask` | `taskId, text?, due?` | `due: null` clears the due date. |
| `completeTask`, `deleteTask` | `taskId` | |

`move`, `detach` and `split` refuse to leave a topic with no notes, so a note is never on no topic while it counts as filed.

- **Pins.** Topic views carry `pins: { title?, excluded?, aliases? }`, which no run can change. A run's op on an alias lands on the merge target as an append, a note taken off a topic is not cited there again, and a pinned title stays. Each refusal is a reason in the run's `dropped`.
- **Stale bodies.** An op that changes a topic's notes marks it `bodyStale` and queues a rewrite, which is told that the notes changed and are the truth. The flag is persisted, so the sweep on start re-queues a rewrite a restart interrupted. A page whose body and notes exceed 32,000 characters is not marked; the result carries a warning instead.
- **Overlay.** `entries.jsonl` is never rewritten. Edits and tombstones are folded from `adjustments.jsonl` on start. A tombstoned note re-read from its transcript stays out.
- **Replay.** A request with no result line was cut short by a crash, and the next start applies it again. Every op converges from whatever state it finds, so applying one twice changes nothing.

## HTTP

| Route | Purpose |
| --- | --- |
| `POST /sessions` `{ harness, sessionId, transcriptPath }` | Register a transcript. Idempotent. A new session is read from the start, so earlier notes are backfilled. |
| `GET /status` | `{ up, entries, runsInFlight, lastViewAt, sessions, relevance: { warmup, pending, compaction } }`. `warmup` is `running`, `done` or `failed` for the background embedding of stored docs on start; `pending` counts docs being embedded now. `compaction` is `{ count, bytesBefore, bytesAfter }` for the cache compactions since start and the latest one's sizes, or `null` before the first. |
| `GET /hints?q=<draft>&limit=1..5` | `{ hints, backend, partial }`: stored entries related to the draft. Never waits on embedding entries; `partial` is true when some were not embedded yet and so were left out. |
| `GET /api/views`, `/api/entries`, `/api/runs` | Current state |
| `GET /api/review` | The digest since the last review, computed on each request: `{ since, until, notes: { count, ids }, newTopics, topics, sharedNotes, renames, tasks, unfiled, rewrites }`. Every list is about the notes the server received after `since` and up to `until`, or about writes in that window. `since` is `null` before the first review. |
| `POST /api/review/done` `{ until }` | Ends a review: the next digest starts after `until`, the value the digest that was reviewed returned. A note received after that digest was read stays in the next one. Refuses an `until` in the future or before the last review. |
| `POST /api/adjustments` `{ op, ... }` | Apply one adjustment (below). 200 with `{ id, ok: true, written, deleted, rewrites, warnings }`; 400 for a malformed op; 409 with `{ id, ok: false, error }` when the data refuses it, such as an unknown topic. |
| `GET /events` | SSE stream of `entry`, `run`, `view` and `removed` (`{ of: 'entry' \| 'view', id }`) events |
| `GET /` | Viewer |

Every request other than `GET` must send `content-type: application/json` (else 415) and either no `Origin` or a loopback one (else 403). The harness plugins send no `Origin`. A web page on another site, including one reaching this port through a DNS name that resolves to 127.0.0.1, sends its own and is refused.

## Duplication

Code that appears exactly twice stays duplicated until a third copy appears. [docs/deferred-abstractions.md](docs/deferred-abstractions.md) lists each pair and the shared form to extract once there are three.
