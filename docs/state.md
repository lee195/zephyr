# Zephyr state

What is built, how it was checked, and what is open, as of 2026-10-20. The configurable-LLM work is not committed yet. Why it is built this way is in [design.md](design.md). How to run it is in the [README](../README.md).

## Built

| Area | What it does | Commits |
|---|---|---|
| Core loop | Tail a Claude Code transcript, file notes into topic pages, show them in the viewer | `eab6ff6`..`5a27c66` |
| Retries | Persist every run in `runs.jsonl`; retry failed and skipped notes (5 s, 30 s, 120 s); recover on start | `da87e7d`, `603ec39` |
| Bounded organizer | Top-3 topics in full plus a one-line index; `write` and `append` operations | `25ea3dc`..`862d769` |
| Tasks and diagrams | `tasks` kind with add, complete and update; `visualizer` kind drawing SVG or ASCII for topics with 4+ notes | `6e405f6`..`2b67fe7` |
| Hints | `GET /hints` and the mod's band lines while you type | `07ed0ff`, `412dac4` |
| Relevance | TF-IDF with stopwords; `embeddinggemma2` embeddings with TF-IDF fallback; cache warm-up | `bdfca48`..`a3fbac5` |
| Config and registries | One config parser; registries for adapters, model backends and relevance backends | `f33b8e7`..`ca569ec` |
| opencode | SQLite adapter and the `/note` plugin | `8a64a39`, `903e858`, `0517b59` |
| Codex | Added, then removed | added `b14cab4`, removed `da63c37` |
| Viewer | Multi-topic marker, title history, collapsed failure chips | `95c3dc2`, `27078c9`, `732540f`, `3863117` |
| Retitle | `append` may carry a new title | `8aaaef7` |
| Cleanup sweep | Rewrite append-log pages, save old bodies to `.history`, compact the embeddings cache | `25b9f93`..`60ca832` |
| Review digest | `GET /api/review`, the review cursor, the request guard | `3d79f22` |
| Adjustments | Rename, merge, move, detach, split, note edit and tombstone, task ops, pins | `d8a19bb`..`b6255d4` |
| MCP and review commands | `/mcp`, `/zephyr review`, `/zephyr-review` | `18b3cd9`, `d1aef65`, `c5c9d9b` |
| Purge | Remove a note's text from `data/` for good | `1766d0d`..`9f84973` |
| Questions | Agents park `whichTopic` and `isTask` questions for the review | `c625753`, `a7bf153` |
| Deeper processing | `summarize_review`, `rewrite_touched_topics`, `suggest_links`, related-topic links | `c59ff50`..`24c0c9d` |
| Finding things | Every topic per note in hints and `search_notes` (up to 10); `lastNote` in `/status`; the band's and opencode's "last note →" line; `/zephyr where`; the `map` kind | `9d689ef`, `030680d`, `33c5db4` |
| Spaces, phase 1 | Sticky sidebar with spaces from the map's areas, hash pages for spaces, all topics, tasks and activity; 3 done runs in the header; `GET /api/runs/history`; `noCall` on runs that made no model call | `ebc43a5` |
| Open-issues work | Viewer: `.history` versions in each topic card, a Summaries page, `vue-tsc` in `bun run typecheck`, a fixed `aria-controls`. Purge: plain words scrubbed only where the note was. Model: retitling rewrites and merges, a weak and similarity gate on link suggestions, no added framing in summaries, a repair retry for refused diagrams. Measured with `scripts/measure-deeper.ts` (below) | `421c85e`..`a0b3915` |
| Configurable LLM | Chat and embeddings each get their own endpoint, model and key variable; the LLM settings live in a gitignored `.env`, with `.env.example` committed. Two harness backends: `claude-code` (`claude -p`) and `opencode` (`opencode run`) | `a8fcc5c`, `3303b36`, `383263b` |
| Spaces, phase 2 | Space slugs on map areas; `pins.spaces` enforced on map replies; `moveTopicToSpace` and `renameSpace` (MCP `move_topic_to_space`, `rename_space`); spaces in `list_topics`; `newSpaces` in the digest; viewer pages by space slug | `432e2cc` |
| Placed notes | `/zephyr new topic` and `/zephyr new space` mark the next note `[zephyr new topic] ` or `[zephyr new space] `. The organizer files such a note in a run of its own, with the unchanged prompt and no topic shown, under a slug no topic has; for a space, a `moveTopicToSpace` with `fresh` puts the topic in a new space titled after it. A move before the map exists now starts the map. Other runs neither see nor cite a placed note, which the first live check caught | not committed |

Tests: 266 pass under `bun test`; `bun run typecheck` (`tsc` and `vue-tsc`) is clean. The mod's 47 tests pass under `claude plugin test`.

## Running it

- The server runs on `127.0.0.1:7317`, started from the repo folder with `bun run start`, with the chat key in its environment when `ZEPHYR_BACKEND` is `vllm`.
- The Claude Code mod loads through `CLAUDE_CODE_PLUGIN_DIRS`, the opencode plugin through `tui.json`; see [mods/claude-code](../mods/claude-code/README.md) and [mods/opencode](../mods/opencode/README.md).
- The review commands need the `zephyr` MCP server added once in each harness; see the README's MCP section.

## Checked live, and not yet

Checked against the real vLLM endpoint or in a real harness:

- Organizing, retries, tasks, diagrams, hints, embeddings and warm-up, on scratch data.
- The opencode five-note organize check.
- The map on scratch data: 8 notes made 4 topics and one map call (the other three map runs found it current); 2 more notes added a fifth topic, and the map kept its four areas and added one.
- Every adjustment op, purge, questions and the deeper tools, on scratch data.
- `/zephyr review` in a real Claude Code session and `/zephyr-review` in a real opencode session: a rename, a move and finishing the review.
- The open-issues work, on a scratch server against the real endpoint (2026-10-20). A merge retitled "Lisbon Flights" to "Lisbon Flights and Cascais Wedding" and left an archived version. The viewer showed that version under the card and the saved summary on the Summaries page, and the title button's `aria-controls` named an element that exists. Purging the note with a wifi key and a name left neither anywhere under the data dir. The first try found the name in the archived diagram of the merged-away topic, which led to the purge scope covering diagram archives too.

Not checked yet:

- The plan's first check, typing five notes in your own Claude Code session against your own server, end to end.
- A review on your real data.
- The opencode toasts for "MCP not connected" and "server down".
- An `isTask` question raised by the real model; only scripted tests cover it.
- Purge removing the text from a task and a diagram live; unit tests cover both.
- The band's "last note →" line and `/zephyr where` in a real Claude Code session, and the opencode "✎ →" toast; mod tests cover the band and the command, nothing covers the toast.
- `/zephyr new topic` and `/zephyr new space` typed in a real Claude Code session; the server side was checked against the real endpoint on 2026-10-23 with transcript rows as the mod writes them.
- The visualizer's repair retry against the real model: no reply failed the SVG check in 50 measured calls, so no repair ran. A test covers that a retry names the fault.

## Measured on 2026-10-20

On the real endpoint, 5 repetitions per probe, with `scripts/measure-deeper.ts`. Results are in `scripts/measurements/deeper/`.

| What | Before | After |
|---|---|---|
| Rewrite retitles a page whose notes outgrew its title | 0/15 | 15/15 |
| Rewrite retitles a page whose title still fits | 0/15 | 0/15 |
| Rewrite after a merge names both pages | 1/15 | 15/15 |
| Unrelated pairs among the link suggestions kept | 10 of 25 | 4 of 22 |
| Related pairs kept | 6 | 10 |
| Summaries adding a "To do", "Open question" or "Decision" label | 13/15 | 0/15 (2 hits were "wants to do" in prose) |
| Diagrams failing the SVG check on the first try | not measured | 0/50 |

Changing the organizer's filing prompt to retitle on append was tried and reverted. It raised retitling on appends from 10/15 to 15/15, but filing correctness fell from 25/25 to 20/25. So appends keep the old title rule, and the next log rewrite fixes the title.

## Harness backends, measured on 2026-10-20

The organizer measurement, 20 topics and 5 probes, run once per backend with TF-IDF relevance. Results are in `scripts/measurements/harness-*.json`.

| Backend | Correct | Median latency |
|---|---|---|
| `vllm`, `deepseek-v4-flash-fast` (25 runs, earlier) | 25/25 | 0.9 s |
| `claude-code`, its default model (Opus 5.5) | 5/5 | 7.2 s |
| `opencode`, `llm-proxy/deepseek-v4-flash-fast` | 4/5 | 6.4 s |

The opencode miss filed the sailing probe on the sourdough topic, with the same model the endpoint gets. One run is not enough to tell that from noise. The prompts were not retuned for either harness.

Found while building it: opencode cuts an attached file (`-f`) off after about 2,000 characters, so the backend sends its input on stdin, which arrives whole. opencode also retries an unreachable provider forever, so the call's 180 s timeout kills it. That matters because the opencode default model on this machine is a local server that is not running.

## Open issues

Model behavior:

- The organizer asks about an ambiguous note in 2 of 5 runs. Wording that asks more often also misfiled new subjects more often. A server-raised question from close relevance scores was measured and dropped: clear notes had smaller gaps between their top two topics (0.011 and 0.017) than ambiguous ones (0.000 to 0.028), and no ambiguous probe's runner-up reached the 0.8 relatedness threshold. This rate is the accepted trade-off.
- A retitle on append still depends on the model, at 10/15 for clearly outgrown titles; the log rewrite after 5 appends catches the rest.

Behavior gaps:

- The opencode backend leaves one opencode session per run in opencode's database, holding the notes that run was shown. A purge result says so, but Zephyr does not delete them.
- A harness backend is about seven times slower per call than the endpoint, and the claude-code calls count against the Claude plan's usage limits.

- opencode notes go in the `/note` dialog, not the main prompt, and the plugin only knows the database path of release builds.
- A slug that contains the purged note's words stays, since it is the page's id and file name; the purge result counts them. Aliases too.
- `adjustments.jsonl`, `questions.jsonl` and `runs.jsonl` only grow. Left open on purpose: at 50 notes a day `runs.jsonl` reaches about 14 MB in four years (projected), and 300k runs parse in 87 ms (measured). Compaction could keep every behavior and lose only history, and archiving would lose nothing; [design.md](design.md#storage-plain-files-not-a-database) has what must be kept and when to move to a database backend.

Decided, not open:

- The viewer's state stays a hand-built `reactive()` store. A move to rstore would touch every component for no change the person sees.

## Ideas not built yet

From the 2026-10-20 ideas for finding things as notes pile up; the first slice (the "last note →" line, `/zephyr where`, the map) is built.

- `ask_notes`: an MCP tool that answers from notes and topic bodies with citations.
- `search_notes` that also ranks topic bodies.
- Merge suggestions for near-duplicate topics and split suggestions for oversized ones, in the review.
- An index of people, projects and terms, each mapped to its topics and notes.
- Archiving topics untouched for some weeks, still searchable.
- A duplicate warning in hints when the draft is nearly a note already written.
- A "where it went" list in the digest.
- A note timeline in the viewer.
- A topic graph from related links and shared notes.
- A search box in the viewer.

Real-time collaboration as a future extension is explored in [explore-collaboration.md](explore-collaboration.md): a hub server per shared space is the recommended direction, with open decisions listed there.

Code that appears exactly twice and is left duplicated on purpose is listed in [deferred-abstractions.md](deferred-abstractions.md).

## Where the plan lives

The plan up to 2026-10-20, phase by phase with every decision as it was made, is [history.md](history.md). Work planned after that lives in `~/.claude/plans/greedy-stirring-hennessy.md` on this machine until it is built.
