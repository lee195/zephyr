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

Other scripts: `bun run dev` (server with reload), `bun run dev:viewer` (Vite, proxied to the server), `bun run build`, `bun test`.

## Data

```
data/
  entries.jsonl                 one Entry per line, append-only
  sessions.json                 registered transcripts and where each read resumes
  views/<kind>/<slug>.md        view body (.svg / .txt for other formats)
  views/<kind>/<slug>.json      view metadata: title, sources, updatedAt
  runs.jsonl                    every finished run, append-only
```

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
| `organizer` | each new entry | topic pages `organizer/<slug>.md` |
| `tasks` | each new entry | `tasks/tasks.json` holds the tasks as data (`{ id, text, due?, done, sources }`), `tasks/tasks.md` renders them |
| `visualizer` | an organizer topic with 4 or more sources whose diagram is missing or older than the topic | `visualizer/<slug>.svg` or `.txt`, with `derivedFrom` naming the topic version it drew |

The viewer shows SVG only as `<img src="blob:…">`, so scripts in a diagram never run, and HTML responses carry a Content-Security-Policy that allows only the viewer's own scripts.

## HTTP

| Route | Purpose |
| --- | --- |
| `POST /sessions` `{ harness, sessionId, transcriptPath }` | Register a transcript. Idempotent. A new session is read from the start, so earlier notes are backfilled. |
| `GET /status` | `{ up, entries, runsInFlight, lastViewAt, sessions, relevance: { warmup, pending } }`. `warmup` is `running`, `done` or `failed` for the background embedding of stored docs on start; `pending` counts docs being embedded now. |
| `GET /hints?q=<draft>&limit=1..5` | `{ hints, backend, partial }`: stored entries related to the draft. Never waits on embedding entries; `partial` is true when some were not embedded yet and so were left out. |
| `GET /api/views`, `/api/entries`, `/api/runs` | Current state |
| `GET /events` | SSE stream of `entry`, `run`, and `view` events |
| `GET /` | Viewer |

## Duplication

Code that appears exactly twice stays duplicated until a third copy appears. [docs/deferred-abstractions.md](docs/deferred-abstractions.md) lists each pair and the shared form to extract once there are three.
