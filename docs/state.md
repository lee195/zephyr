# Zephyr state

What is built, how it was checked, and what is open, as of 2026-10-19 at commit `9f67b48`. Why it is built this way is in [design.md](design.md). How to run it is in the [README](../README.md).

## Built

| Area | What it does | Commits |
|---|---|---|
| Core loop | Tail a Claude Code transcript, file notes into topic pages, show them in the viewer | `192a80a`..`59c8cd6` |
| Retries | Persist every run in `runs.jsonl`; retry failed and skipped notes (5 s, 30 s, 120 s); recover on start | `fa50423`, `f55a8e6` |
| Bounded organizer | Top-3 topics in full plus a one-line index; `write` and `append` operations | `df099e3`..`8e0dbad` |
| Tasks and diagrams | `tasks` kind with add, complete and update; `visualizer` kind drawing SVG or ASCII for topics with 4+ notes | `a2ad1be`..`fd49116` |
| Hints | `GET /hints` and the mod's band lines while you type | `6c1f0b2`, `005e70a` (jlee-mods) |
| Relevance | TF-IDF with stopwords; `embeddinggemma2` embeddings with TF-IDF fallback; cache warm-up | `ddf5ab6`..`7499cba` |
| Config and registries | One config parser; registries for adapters, model backends and relevance backends | `a3368e0`..`a7655ed` |
| opencode | SQLite adapter and the `/note` plugin | `c8408dc`, `5d90094`, `415c269` (jlee-mods) |
| Codex | Added, then removed | added `8454c88`, removed `b20ef6f` |
| Viewer | Multi-topic marker, title history, collapsed failure chips | `e8eb44a`, `15d6719`, `0e167cd`, `82fffcb` |
| Retitle | `append` may carry a new title | `550d595` |
| Cleanup sweep | Rewrite append-log pages, save old bodies to `.history`, compact the embeddings cache | `5db8396`..`9de559c` |
| Review digest | `GET /api/review`, the review cursor, the request guard | `f40bca8` |
| Adjustments | Rename, merge, move, detach, split, note edit and tombstone, task ops, pins | `a7e66a3`..`0410b2f` |
| MCP and review commands | `/mcp`, `/zephyr review`, `/zephyr-review` | `4796dbb`, `942e0b0`, `f0c3c63` (jlee-mods) |
| Purge | Remove a note's text from `data/` for good | `e13fbfe`..`37fcba6` |
| Questions | Agents park `whichTopic` and `isTask` questions for the review | `705c5e0`, `81a3739` |
| Deeper processing | `summarize_review`, `rewrite_touched_topics`, `suggest_links`, related-topic links | `ec1b60d`..`9f67b48` |

Tests: 213 pass under `bun test`; `bunx tsc -p tsconfig.json` is clean. The mod's 36 tests pass under `claude plugin test`.

## Running on this machine

- The server runs detached on `127.0.0.1:7317`, started from this folder with `wick exec --only vllm -- bun run start`. Its log is `data/server.log`. To stop it, kill `wick` and both `bun` processes; killing only `wick` leaves `bun` running.
- The `zephyr` mod is in `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.
- The `zephyr` MCP server is in the user-scope Claude Code config (`claude mcp get zephyr`).
- The first review has not happened yet. The data predates the review cursor, so the first digest covers all 13 notes and the one topic, "LLM Context Degradation".

## Checked live, and not yet

Checked against the real vLLM endpoint or in a real harness:

- Organizing, retries, tasks, diagrams, hints, embeddings and warm-up, on scratch data.
- The opencode five-note organize check.
- Every adjustment op, purge, questions and the deeper tools, on scratch data.
- `/zephyr review` in a real Claude Code session and `/zephyr-review` in a real opencode session: a rename, a move and finishing the review.

Not checked yet:

- The plan's first check, typing five notes in your own Claude Code session against your own server, end to end.
- A review on your real data.
- The opencode toasts for "MCP not connected" and "server down".
- An `isTask` question raised by the real model; only scripted tests cover it.
- Purge removing the text from a task and a diagram live; unit tests cover both.

## Open issues

Model behavior:

- Renaming a topic during a rewrite or append happened in 1 of 3 test runs, and a merged page keeps the old target's title.
- The organizer asks about an ambiguous note in 2 of 5 runs. Wording that asks more often also misfiled new subjects more often.
- `suggest_links` returns weak pairs even when told an empty list is fine.
- `summarize_review` adds small framing ("open task", "To do:") that is not in the notes.
- The visualizer sometimes returns invalid SVG; the retry usually succeeds.

Behavior gaps:

- opencode notes go in the `/note` dialog, not the main prompt, and the plugin only knows the database path of release builds.
- The memory of a rewrite that used up its attempts is lost on restart, so a stuck topic gets one more round.
- Answering a question with a topic that was merged away since returns an error instead of following the alias.
- Purge's word matching is coarse: a word of 4+ characters found only in the purged note becomes `[purged]` everywhere. Slugs that contain the note's words stay.
- An adjustment that fails partway with an I/O error returns 500 and is applied again only on the next start.
- Stopping a transcript reader doesn't cancel a read already in progress.
- A session whose every note was typed while the server was down stays unregistered until the next note.
- `adjustments.jsonl`, `questions.jsonl` and `runs.jsonl` only grow.

Viewer:

- `.history` versions and saved summaries are not shown.
- The `.vue` files are not type-checked (`vue-tsc` is not installed), and state is a hand-built `reactive()` store rather than rstore.
- The title-history button's `aria-controls` points at an id that exists only while the list is open.

Code that appears exactly twice and is left duplicated on purpose is listed in [deferred-abstractions.md](deferred-abstractions.md).

## Where the plan lives

The working plan, with the phase-by-phase history and every decision as it was made, is `~/.claude/plans/greedy-stirring-hennessy.md` on this machine. This file and [design.md](design.md) are the versions kept with the code.
