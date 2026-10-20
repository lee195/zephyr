# About Zephyr's design

Zephyr turns notes you type into your agent harness into organized topic pages, a task list and diagrams. This page explains why it is built the way it is. For how to run it and what each route does, see the [README](../README.md). For what is built and what is open, see [state.md](state.md).

## The premise: you type into the harness

You already spend the day in Claude Code or opencode. Zephyr keeps your notes there instead of sending you to a notepad. A note is a line you type in notes mode; the harness keeps it in its session transcript without a model reply, and a local server reads the transcript and does the rest.

This is the one decision everything else follows from. An early plan had a web text box, and it was rejected: typing in the harness is the point. So the localhost viewer only displays, and every way to change your notes, including the post-session review, goes through the harness.

Two harnesses are supported:

- **Claude Code.** The `zephyr` mod (`mods/claude-code`) catches the prompt in notes mode, appends it to the transcript as a hidden user row with `$.session.append`, drops the turn so no model runs, and echoes a visible `✎` notice. Hidden rows are never drawn in the transcript, which is why the echo exists.
- **opencode.** The opencode TUI plugin (`mods/opencode`) adds `/note`, a dialog that sends each line with the SDK's `noReply` flag.

Codex was supported briefly and then dropped. It has no way to keep a message without a model turn, so every note cost a full turn of its session context (about 6.7k tokens in the measurement), and it needed a request-shape shim to talk to the vLLM endpoint.

A note is any user row whose text starts with `[zephyr] `. One rule for every harness means the transcript itself says which rows are notes, so re-reading it after a restart finds the same notes.

## Lessons from prior art

Nothing public started agents from notes typed into a harness when this project began. The products closest to it (Notion Custom Agents, Mem 2.0, Tana, Claude Code over an Obsidian vault, Letta's sleep-time agents) taught six lessons, and each one is a rule in the code:

1. **People don't let AI edit their raw notes.** Products drifted from acting to proposing. So entries are immutable, and agents write only derived views.
2. **Concurrent agents overwrite each other without an error.** So every view has exactly one writer.
3. **A model call per keystroke costs too much.** So a submitted note is the trigger. Hints while you type rank by embeddings, with no chat-model call.
4. **Background agents can't ask you anything.** So agents may file their best guess and park a question for the review.
5. **Organized notes get messy as they grow.** So a periodic sweep rewrites pages that became lists of appended sections.
6. **Products in this space get shut down.** So all data is plain files under `data/`.

## Agents return data; the server writes

An agent kind (`organizer`, `tasks`, `visualizer`, `map`) is a function from a bounded prompt to JSON. The server checks the reply at the boundary and does every write itself. The agents get no file tools, so it doesn't matter whether the model supports tool calls, and a malformed reply fails one run, not your data.

Each kind owns `data/views/<kind>/` and runs through its own serial queue. Kinds run in parallel and never touch each other's files. Work that changes another kind's views, such as deleting a diagram when its topic goes away, is queued on that kind's queue as a `reconcile` step. This is why no locks are needed.

Coverage is a fact read from the log, not a flag. A note is organized for a kind when a `done` run of that kind covered it in `runs.jsonl`. A note the model skipped is recorded as `uncovered` and retried with the same backoff as a failed run (5 s, 30 s, 120 s, then it stops), and a restart queues every note no done run covered.

## Bounded prompts

Every prompt has a cap, because the first organizer sent every topic page in full and grew by a page per topic. The organizer now sees the 3 most relevant topics in full, plus a one-line index of the rest, and replies with `write` (only for open or new topics) or `append` (any topic) operations. At 20 topics that cut the prompt from about 10k to 4.7k tokens; at 40 topics, from 17k to 5k. The remaining growth is the index, about 13 tokens per topic.

The endpoint adds a fixed 1,290 or so tokens to every request, even a bare "hi". That is why small calls never cost less than about 1.5k prompt tokens.

## Relevance: embeddings with a fallback

Picking the 3 open topics and showing hints both rank text by relevance. `embeddinggemma2` on the vLLM endpoint ranks the right note first for 65% of notes on the test corpus, against 30% for TF-IDF. Embeddings are the default; TF-IDF answers when the endpoint fails, and the embedding backend is skipped for 30 s afterwards so a down VPN doesn't cost a timeout per keystroke. Every ranking names the backend that answered and carries that backend's thresholds, because the two score on different scales: `minRelatedScore` for a note against a page, and `minLinkScore` for one topic page against another.

Vectors are cached per model in `data/embeddings/<backend>.jsonl`, warmed in the background at start, and compacted by the sweep. A hint never waits for note embedding; during warm-up it ranks what is cached and says `partial`.

## The review: a second, deliberate pass

Live processing files each note as it arrives. The review is where you look at what the agents made and fix it. The decisions behind it:

- **In the harness, over MCP.** The server speaks MCP at `/mcp`. `/zephyr review` (Claude Code) or `/zephyr-review` (opencode) starts a turn from a digest of everything since the last review. You direct; the agent applies its own suggestions only after you say yes. The prompt carries that rule, and the harness's tool-permission prompts are the hard gate.
- **A cursor, not session objects.** The server keeps `lastReviewedAt`. Finishing a review advances it to the digest's `until`, so a note that arrives during the review shows up in the next one.
- **Corrections are an overlay.** Edits and deletions are entries in `data/adjustments.jsonl`, an append-only log. The server keeps the effective notes (raw plus corrections, minus tombstones) in memory, so every kind sees the corrected text. The raw `entries.jsonl` is never rewritten, with one exception: purge.
- **Adjustments go through the owning kind's queue.** A rename or move runs as a step after any run in flight. Without this, an organizer run that read a page before your rename would write the old title back.
- **Fixes stick.** A page carries server-owned pins: a pinned title, notes excluded from it, and slugs merged into it. The organizer's reply check enforces them, so a later run can't undo your fix.
- **Body changes reuse the rewrite run.** A move, split, edit or merge marks the page `bodyStale`, and the sweep's rewrite run cleans the text. The flag is stored, so a restart can't lose a pending cleanup.
- **Purge is for secrets.** It removes a note's text from everything under `data/` and suppresses its id so re-reading the transcript can't bring it back. It needs the exact confirmation `purge <noteId>`. The harness transcript still holds the text, and Zephyr never writes there, so the result tells you where to remove it yourself.

## Storage: plain files, not a database

`data/` is JSONL logs, small JSON files and real view files: `.md`, `.svg` and `.txt` bodies, each with a JSON sidecar. SQLite was considered on 2026-10-20 and not adopted.

**Why files are enough.**

- Every log is read into memory once at start. After that the hot path never reads the disk.
- Only the review digest and purge read a file again, and both run only on request.
- At a heavy 50 notes a day with about 3 runs per note, four years come to about 20k entries (6 MB) and 60k runs (14 MB). Bun parses 60k run lines in 17 ms and 300k (69 MB) in 87 ms.
- Atomicity comes from the design, not a database:
  - Each file has one writer.
  - Appends and rewrites of the same file share an exclusive section.
  - Rewrites go through a tmp file and a rename.
  - A view's sidecar is written after its body, and a view is read only through its sidecar.

**Why a database would hurt.**

- Topic pages are meant to be files you can open, grep and keep without Zephyr. A database would still need those files, so there would be two stores to keep in step.
- Purge is checked by `rg` finding nothing under `data/`. In SQLite a deleted row stays in free pages and in the write-ahead log until a `VACUUM`.

**When to revisit.**

- A second process writes `data/`.
- A query must run over more data than fits in memory.
- Start-up parsing nears 500 ms.

**Growing logs.** `runs.jsonl`, `adjustments.jsonl` and `questions.jsonl` only grow, and a database alone would not change that. Shrinking them is a policy choice that costs only history:

- Old done runs can fold into one coverage record per kind, which covers exactly the same notes. Runs since the last review, which the digest reads, and runs whose `exhausted` mark still matches their page must stay.
- Closed questions and finished structural adjustments (rename, merge, move, split, links, task edits) can go, since their effect lives on the views as pins, aliases and related lists.
- Every edited text of a note must stay, because purge uses them to find the note's old words in `.history` versions and saved summaries. Purge requests and results must stay for `get_purge`.
- What is lost is the record of the past: older runs on the activity page, when each fix was made, and which answers were given. Moving old lines to an archive file that start-up does not read would keep even that.

**When the information grows large enough, move to a proper database backend** rather than stretching plain files. The signals are the revisit triggers above: start-up parsing nearing 500 ms, a query over more than fits in memory, or a second writer. Put it behind a storage interface, as relevance and models are, and keep three things: topic pages stay plain files a person can read, a purge stays provably complete (`VACUUM` or secure delete, so no deleted row lingers), and every edited text of a note stays available to purge.

## Interfaces that can be swapped

Anything that ranks, embeds or calls a model sits behind an interface with a registry: `TranscriptAdapter` (`src/adapters`), `ModelBackend` (`src/backends.ts`) and `RelevanceBackend` (`src/relevance.ts`). Configuration is parsed once in `src/config.ts`, and an unknown name fails there with the registered names. Chat and embeddings each have their own endpoint, so they can come from different providers, and the model backend can also be the user's own harness (`claude -p`, `opencode run`) instead of an endpoint. The endpoint settings (URLs, models and key variables) have no defaults in code: they live in `.env`, so there is one place to read what the server talks to. The choice of backend and relevance does default in code, to `vllm` and `embedding`.
