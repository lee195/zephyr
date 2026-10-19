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
  sessions.json                 registered transcripts and their byte offsets
  views/<kind>/<slug>.md        view body (.svg / .txt for other formats)
  views/<kind>/<slug>.json      view metadata: title, sources, updatedAt
```

## HTTP

| Route | Purpose |
| --- | --- |
| `POST /sessions` `{ harness, sessionId, transcriptPath }` | Register a transcript. Idempotent. A new session is read from the start, so earlier notes are backfilled. |
| `GET /status` | `{ up, entries, runsInFlight, lastViewAt, sessions }` |
| `GET /api/views`, `/api/entries`, `/api/runs` | Current state |
| `GET /events` | SSE stream of `entry`, `run`, and `view` events |
| `GET /` | Viewer |
