<!-- The working plan as it stood on 2026-10-20, phase by phase, with every decision as it was made. Kept verbatim; current state is in state.md. -->

# Zephyr: notes typed into the agent harness

## Context

You want to take notes by typing into the agent harness you already use (Claude Code or opencode; Codex was dropped on 2026-10-19), not into a notepad. A local server called Zephyr reads each note from the harness's session transcript. It starts agents that organize the notes and draw visualizations, and shows the results in a localhost viewer. Typing in the harness is the point of the project. The web app only displays results and never takes input.

## Prior art (summary)

Nothing public does this. The products and setups I found start their agents from a command, a save or a schedule, never from notes typed into a harness. Closest are Notion Custom Agents (triggered background agents), Mem 2.0 (live resurfacing), Tana (agents in meetings), Claude Code over an Obsidian vault (Claudian, claudesidian), and Letta sleep-time agents.

Lessons that shape the design:

1. Products end up proposing changes instead of making them, and people who use AI on their notes don't let it edit raw notes. So agents write derived views only.
2. Concurrent agents overwrite each other's edits without any error. So each file gets one writer.
3. Calling a model per keystroke is too costly. So the trigger is a submitted entry.
4. Background agents cannot ask you anything. Deferred.
5. Organized notes get messy as they grow. So a periodic cleanup pass rewrites a topic page that became an append log and compacts the embeddings cache (built: zephyr `5db8396`..`9de559c`).
6. Products in this space get archived, shut down or bought. So all data is plain files.

## Decisions

From you:

- **Input.** You type in the harness. The server watches the harness transcript.
- **What agents may change.** Agents write derived views only.
- **Visuals.** SVG or ASCII in a localhost viewer. No Mermaid.
- **Model.** Agents run on a vLLM endpoint.
- **Status.** A Claude Code mod shows the server's state.

My defaults. Change any of them before approving.

- **Location.** The server in its own repo, with the mod in a separate mods repo; both now live here, the mods under `mods/`.
- **Stack.** Bun server, with Server-Sent Events (SSE) for live updates, and a Vite + Vue 3 + TS viewer.
- **Key.** `DEEPSEEK_API_KEY` loads with `bun --env-file=.env.local`.

## How a note travels

1. **Type.** You switch notes mode on with `/zephyr` or a key binding. The mod shows it in the band above the prompt.
2. **No reply.** The harness must record the note without running a model turn. Each harness does this differently:
   - **Claude Code (v1).** The mod hooks `prompt.submit`. In notes mode it calls `$.session.append({ message: { type: "user", content: [text] } })` and returns `{ drop }`. The note lands in the transcript and no model turn runs. API at `jlee-mods/context-lens/.claude-plugin/types/claude-code/index.d.ts:2946` (append) and `:4201` (submit).
   - **opencode (done 2026-10-19, v1.18.33).** A TUI plugin (now `mods/opencode`) adds `/note`, which opens a dialog and sends each line with `noReply`. Sessions live in SQLite (`opencode.db`, `message` + `part` tables); the adapter reads them and dedupes by message id.
   - **Codex (dropped 2026-10-19).** It had no no-reply path and cost a model turn per note; support was removed.
3. **Mark.** A note is a user row whose text starts with `[zephyr] `. The mod adds the prefix, and in Codex you type it. One rule works for every harness. The transcript then says on its own which rows are notes, so re-reading it after a restart finds the same entries. You can still chat normally in the same session, for example to ask the model about your notes.
4. **Register.** When notes mode turns on, the mod sends `POST /sessions { harness, sessionId, transcriptPath }` to the server. Hook inputs carry `transcript_path` (`index.d.ts:855`), so the server never has to scan folders for Claude Code.
5. **Ingest.** The server tails each registered transcript from a stored byte offset, keeps partial lines until they complete, and parses rows with that harness's `TranscriptAdapter`. Each marked user row becomes an Entry. The entry id comes from the harness's message id, so reading the same row twice changes nothing. Entries are copied into `data/entries.jsonl` because Claude Code deletes old transcripts.
6. **Organize.** Each new entry goes to each agent kind's queue. The agent returns JSON view upserts, and the server checks them and writes the files.
7. **Show.** The viewer gets views and runs over SSE. The mod's band polls `GET /status` with `$.http.fetch`. The band must render `next(e)` beneath its own row.

## Data shape

- **Entry.** `{ id, harness, sessionId, at, text }`, appended to `data/entries.jsonl`. Nothing edits or deletes it.
- **View.** `{ id, kind, sources: EntryId[], format: 'md' | 'svg' | 'ascii', body, updatedAt }`, stored as `data/views/<kind>/<slug>.<ext>` plus a JSON sidecar.
- **AgentKind registry.** `{ kind, prompt, outputSchema }`. v1 has three kinds:
  - `organizer` writes topic pages and links.
  - `tasks` writes one task list.
  - `visualizer` writes SVG or ASCII diagrams.
- **Run.** `{ id, kind, entryIds, status, error? }`. Runs feed the status band and the viewer's activity strip.
- **Session.** `{ harness, sessionId, transcriptPath, offset }`, kept in `data/sessions.json`. This lets ingestion resume after a restart.

## Two choices that remove whole failure classes

1. **Agents return data and the server writes.** Agents get no file tools. So it doesn't matter whether the vLLM model supports tool calls, and a malformed reply fails one run, not your data.
2. **One writer per kind.** Each kind owns `views/<kind>/` and runs through its own serial queue. Different kinds run in parallel and can never touch each other's files.

## Pluggable interfaces

- **`TranscriptAdapter`.** `parse(line) -> Row[]` and `isNote(row)`. v1 is `claude-code`; `codex` and `opencode` follow.
- **`ModelBackend`.** `complete(messages, { json })`. v1 is `vllm`, through OpenAI-compatible chat completions.
- **`HintBackend`.** `related(draft) -> EntryId[]`. v1 is TF-IDF with no model call.

## Phases (each ends in a check)

0. **Two probes.** Nothing gets built until both pass.
   - **No-reply probe.** A throwaway mod appends a user row and drops the turn. Check that the row lands in the transcript `.jsonl` and that no assistant turn follows. If `session.append` does not write the file, stop. The design then needs a different no-reply route before anything else.
   - **vLLM probe.** One JSON-format completion through `bun --env-file=.env.local`. Check that the reply parses into an organizer-shaped JSON.
   - **Result (2026-10-19): both passed.** Appended rows land as `type:"user"`, `isMeta:true`, `[zephyr] …`, with no assistant turn. A drop puts the draft back in the box, so the mod clears it on the next tick with `$.prompt.fill({ text: '' })`. That was tested and works. `deepseek-v4-flash-fast` returned valid organizer JSON with correct grouping. The key comes from `wick exec --only vllm -- <cmd>`, not `.env.local`.
1. **The core loop.**
   - Build: the Zephyr mod (notes toggle, append and drop, registration), server ingestion through the Claude Code adapter, the `organizer` kind, and the viewer.
   - Check: type 5 notes on two topics in Claude Code. Two topic views appear with correct `sources`, and the session shows no assistant replies.
   - Check: restart the server mid-stream. It creates no duplicate entries.
2. **Status band.**
   - Build: the band shows whether the server is up, how many runs are in flight, and the last view updated.
   - Check: stop the server and the band says so within 5 s. The other mods' bands still render.
3. **`tasks` and `visualizer` kinds.**
   - Check: "TODO call Anna Friday" shows up in the task list.
   - Check: a topic with 4+ entries gets a diagram. The viewer draws SVG via `<img src="blob:...">`, and a planted `<script>` in a test SVG does not run.
4. **Idle hints in the harness.**
   - Build: the mod debounces `prompt.edit` for 1 s and calls `GET /hints`. Up to three related entries show in the band.
   - Check: the server makes no model call for hints.
5. **Second harness.**
   - Build: an opencode adapter if its `noReply` exists, otherwise a Codex adapter with the AGENTS.md fallback.
   - Check: the same five-note test passes in that harness.

Deferred: the periodic cleanup pass, an inbox for agent questions, embeddings, and editing past entries.

## Verification

- **Unit tests (Bun).** Cover the adapter's parsing against real transcript lines, offset resume, reading the same row twice, output validation, and TF-IDF. None of them need a model.
- **Mod tests.** Use `claude plugin test`, as the existing mods do.
- **End to end.** Type in a real Claude Code session with the mod loaded. Watch the viewer with the ego-browser skill, and check the files in `data/`. Each phase's check gates the next phase.
- **After approval.** Save a project memory for Zephyr. Its core premise is input through the harness transcript, not a web text box.

---

# Feature area: post-session adjustments (complete, 2026-10-19: phases 0-6 done)

## Context

Live processing files each note as it arrives. After a note-taking session the person wants a second, deliberate pass: see what the agents made of the session and fix or deepen it. Decisions so far (from the user):

- **Where.** In the harness. The harness agent gets Zephyr tools over MCP; the viewer stays display-only.
- **Trigger.** Ending notes mode produces a review digest; `/zephyr review` starts the adjustment conversation from it.
- **Scope.** Fix topic structure (move or detach a note, merge, split, rename; fixes must stick against later agent runs), edit or delete notes, answer questions agents parked during the session, deeper processing (session summary, rewrite touched topics, cross-topic links).
- **Authority.** The person commands and the agent executes. Agent suggestions apply only after a yes.

## Pre-phase: remove Codex support (done: zephyr `b20ef6f`, jlee-mods `280ab9d`)

Zephyr supports Claude Code and opencode only. Remove Codex entirely, in one commit per repo:

- **zephyr:** delete `src/adapters/codex.ts`, its registry entry in `src/adapters/index.ts`, `test/codex.test.ts`, `test/fixtures/codex-notes.jsonl`, and the Codex row in `README.md`. `parseConfig` and `POST /sessions` then reject `harness: "codex"` through the existing registry lookup, with no special case.
- **jlee-mods:** delete `zephyr-codex/` and its line in `jlee-mods/README.md`.
- **Data:** a `sessions.json` entry with `harness: "codex"` must not crash startup. Skip it with one warning (check what `tail` does today for an unknown harness and keep the smallest fix).
- **Docs:** mark Codex as dropped in this plan's earlier sections and in the Zephyr project memory.
- **Check:** `bun test` and `tsc` green; `rg -i codex src test README.md` finds nothing; the server starts on a data dir whose `sessions.json` has a Codex session.

## Phase 0: cleanup pass (done: zephyr `5db8396`..`9de559c`)

Build the design in `~/.claude/plans/greedy-stirring-hennessy-agent-ae699e9be8ab54fd7.md` as written: server-owned append counter, organizer rewrite runs keyed by the topic view through the organizer queue (note runs first), reply check that no cited note is dropped, old body saved to `.history/`, a sweep at startup and every 30 minutes (`ZEPHYR_SWEEP_MINUTES`), and embeddings cache compaction. Its tests and live check are listed in that file. The rewrite run is the mechanism later phases reuse to rewrite pages after a move, merge or split.

## Design (after a review against the code at 82fffcb)

- **Review cursor, not session objects.** The server keeps `lastReviewedAt`. The digest covers everything since then; finishing a review advances it. Turning notes mode off (Claude Code mod) or closing the `/note` dialog (opencode plugin) shows "N notes since last review · /zephyr review". No end signals, no idle timer.
- **Digest is a computed response,** `GET /api/review`, not a new agent kind. Contents: new topics, notes per topic, notes in 2+ topics, renames (from `pastTitles`), tasks whose sources fall in the window (tasks carry no timestamps), notes left uncovered or failed (read from `runs.jsonl`, since memory holds only 50 runs). These items are also the review's question list.
- **Entries stay immutable; corrections are an overlay.** `data/adjustments.jsonl` is an append-only log of typed ops. The server keeps `this.entries` materialized as raw entries plus corrections minus tombstones, so kinds, hints and warm-up all see the effective text through the one array they already read. Purge is the single exception (below).
- **Adjustments run through the owning kind's queue** as a new third kind of queued work: an adjust step that `drain` runs and that calls `writeView` directly, with no model call. This removes the lost-update race with an organizer run already in flight. `Store` gains view deletion (for merges).
- **Stickiness is server-owned view data,** preserved by `writeView` like `pastTitles`: `View.pins?: { title?: true; excluded?: EntryId[]; aliases?: string[] }`. `validateOps` maps alias slugs to the merge target (a write to a non-open target becomes an append), strips excluded ids from sources (dropping ops left with none), and drops a title change on a title-pinned page, each with a reason in `run.dropped`.
- **Body changes reuse the phase 0 rewrite run,** with a `force` flag on the queued work so it runs even when the topic doesn't qualify by append count. The 32k-character cap still applies; an over-cap page is reported in the reply, not truncated.
- **Tool access:** a typed `POST /api/adjustments` with one validator is the source of truth. A stateless `/mcp` route maps tools one-to-one onto it (plain JSON-RPC `tools/list` and `tools/call`, about 100 lines, no dependency). Every mutating route requires `content-type: application/json` and rejects any request with a non-local `Origin` (the MCP spec requires the Origin check; it also blocks CSRF and DNS rebinding).

Defaults I chose; change any before approving:
- An edited note rewrites the pages that cite it and does not re-run tasks (the person edits tasks directly).
- A rename redraws the diagram (existing rule; renames are rare in review).
- A forced rewrite does not override the 32k cap.
- Origin check plus JSON content-type, no token. A token in each harness's MCP config can come later.

## Phases (each ends in a check)

1. **Digest and review cursor** (done: zephyr `f40bca8`, jlee-mods `6de276c`). `GET /api/review`, `POST /api/review/done`, the "N notes since last review" line in the mod band and the opencode toast. Check: a fixture data dir yields an exact digest (new topics, renames from `pastTitles`, notes in several topics, uncovered notes from `runs.jsonl`), and `done` empties it.
2. **Adjustment log and structural ops** (done: zephyr `a7e66a3`, `36af43c`, `420bcc9`, `4cf57c2`, `0410b2f`). Deviation: the forced rewrite is a persisted `View.bodyStale` flag, not a `force` field on queued work, so it survives a restart and the sweep re-queues it. Overlay, adjust queue work, view deletion, pins, the request guard. Ops: rename, merge (old body appended to the target, old slug aliased, old page and its diagram deleted), task edit, complete and delete, note edit, note tombstone, move, detach (requires a target topic, so no note is orphaned while counted as covered), split. Body cleanup goes through forced rewrites. Checks: a rename made while an organizer run is held survives it; a tombstoned id leaves sources, hints and the organizer's known ids; a scripted reply that re-cites an excluded note, writes to an alias slug or retitles a pinned page is dropped with a reason; a moved note's old page is rewritten without it and the old body is in `.history`; a cross-origin POST gets 403.
3. **MCP and review commands** (done: zephyr `4796dbb`, `942e0b0`; jlee-mods `efcd2e1`, `f0c3c63`). Deviations: the review prompt is served by the server (`GET /api/review/brief`), so both harnesses submit one text that names the server's tools; the Claude Code mod checks `$.tool.list()` for `mcp__zephyr__finish_review` and defers its `prompt.submit` one tick, since a submit inside `command.run` is refused. Found live: opencode's Esc closes the note box through the dialog stack's `onClose`, so the phase 1 toast never showed; fixed in `efcd2e1`. Fixed in `e13fbfe`: the next digest leaves out renames and new topics an adjustment made (`PastTitle.byPerson`, `View.createdByPerson`) and lists a rewrite the person's change forced with `yours: true` (`Run.forced`), since its new body is model text they have not read. `37fcba6` puts `run.endedAt` on the stamp clock that `until` uses. The `/mcp` route; `/zephyr review` in the Claude Code mod and `/zephyr-review` in the opencode plugin start a turn with the digest and an instruction to apply only what the person asks, and to apply its own suggestions only after a yes. Check: `tools/call` results equal the phase 2 tests; both harnesses list the tools; a live review in each harness renames a topic and moves a note.
4. **Purge** (done: zephyr `a05d171`; live check on the real endpoint passed, see below). Removes a note from Zephyr's data entirely: atomic rewrite of `entries.jsonl` serialized with appends, a persisted suppressed-id set loaded into the dedupe set (so re-reading the transcript can't bring it back), forced rewrites of every page citing it, task text scrubbed, `.history` versions containing it deleted, diagrams redrawn. The harness transcript still holds the text, and Zephyr never writes to it; the reply says so. Requires an explicit confirmation field. Check: after purge and a restart, re-polling an opencode database that still has the row ingests nothing, and `rg` finds no trace of the text under `data/`. As built: `purgeNote { noteId, confirm }` in OPS (confirm exactly `purge <noteId>`), `purged.json` (ids only) loaded into the dedupe set, per-kind scrub steps on each kind's queue, a deterministic scrub of the note's texts and distinctive words (`[purged]`) before the queued rewrite, tasks from only that note deleted, diagrams dropped and redrawn, `.history` files with its words deleted (a dropped topic's whole history), `runs.jsonl` keeps ids, `adjustments.jsonl` keeps edit lines with `[purged]` text, `entries.jsonl` rewritten last in a per-file exclusive section shared with appends; a start finishes an interrupted purge before queueing any run. `GET /api/purge/<id>` and MCP `get_purge` report pending rewrites; `stillIn` names the transcript location via `TranscriptAdapter.locate`. Live: one secret note on a real organizer page, `.history`, task and diagram (the task was deleted, the diagram cited it; the model wrote neither with the token itself); after purge and rewrite `rg -uu -i` found nothing; restart plus shrunk and moved transcript re-reads ingested nothing. Open: a slug holding the note's words stays (counted in warnings); in-memory embedding vectors live until restart; an embedding batch for the note still in flight can append after the purge's compaction until the next sweep.
5. **Agent-raised questions** (done: zephyr `705c5e0`, `81a3739`). Live organizer and tasks runs may return a bounded list of questions while still filing their best guess. They are stored in `data/questions.jsonl`, appear in the digest, and answers become adjustments. Check: a scripted ambiguous note yields a question, and answering it moves the note. As built: `Question = whichTopic { noteId, chosen, alternatives } | isTask { noteId, taskId }`; answers are `keep`, an alternative slug (moveNote, or detachNote when that topic already cites the note, or mergeTopics when the note was the only one on `chosen`), or `deleteTask`, applied through `adjust`. Cap 2 per run; each kind checks its questions against what its reply wrote (`parseQuestions` in `kinds/common.ts`), dropping with a reason in `run.dropped`. `questions.jsonl` holds ids and slugs only (asked line, closed line with `kept | applied | moot`); `list_questions` and the digest read the note and titles at list time. A purge deletes every line of a question about the note. MCP `list_questions`, `answer_question`; no HTTP route. `sameTopic` left out: it is not about a note of the run, and merge needs a direction. Prompt: +75 tokens organizer, +56 tasks (same payload, base vs head, real endpoint); the first wording ("file every entry by your best guess") pulled the beekeeping probe onto an existing topic 2/6, so the rule names existing topics only. Live, ambiguous tomato note between seeded Garden and Balcony: asked 2/5 with the final wording (3/5 and 2/3 with wordings that misfiled more); answering over MCP moved the note. Measurement: final wording 73/75 correct, base 88/90, no question on any clear probe.
6. **Deeper processing on request** (done: zephyr `ec1b60d`, `9bb1261`, `a14359f`, `272822e`, `9f67b48`). A session summary in the review reply (model-written, not stored unless asked), forced rewrite of every topic touched since the last review, cross-topic link suggestions offered as review items. Check: live against the real endpoint on a scratch session. As built: MCP `summarize_review { save? }` (newest notes of the window within 32,000 characters, the rewrite budget, `leftOut` counts the rest; returns usage; `save` writes `summaries/<until>.md` with the summarized ids in front matter; one at a time on a summary chain that purge also uses, deleting every saved summary that cites the note or holds its words; not shown in the viewer, the path is returned). `rewrite_touched_topics` marks every topic citing a window note `bodyStale` in one organizer step (`planRewrites`), returns `{ queued, overCap }`. `suggest_links` over the topic index (200 most recently updated, `slug | title | N sources`), at most 5 checked pairs with one-line reasons, applies nothing. Ops `linkTopics`/`unlinkTopics` set server-owned `View.related` on both topics without bumping `updatedAt` (no redraw, append count holds); reconcile maps merged-away slugs to the target, drops deleted ones, and restores a one-sided link. Viewer lists related topics as scroll links. Brief names the tools; links only after a yes. Found live: a requested rewrite of an already coherent page came back unchanged 3/3 and failed the extend-only check, leaving the topic stale; fixed in `272822e` (a stale page may come back unchanged). Live (real endpoint, 10 notes, 4 topics): summary 1844 prompt / 135 completion tokens; suggest_links proposed garden-composting and a self-described weak lisbon-garden pair; link applied; rewrite_touched queued garden, composting, lisbon-trip (not car-maintenance) and all three rewrites ran.

Critical files: `src/zephyr.ts`, `src/domain.ts`, `src/kinds/organizer.ts`, `src/store.ts`, `src/server.ts`, plus the mod (now `mods/claude-code/hooks/register.tsx`) and the opencode plugin (now `mods/opencode/zephyr.ts`).

## Verification

Each phase's check is its gate. Unit tests drive a real `Zephyr` with scripted model replies, as the existing tests do. Live checks use scratch data dirs, free ports (never 7317) and the real endpoint. Review flows are checked in a real Claude Code session and a real opencode session.

---

# Evaluation: JSONL or SQLite for `data/` (2026-10-20)

## Context

The user asked whether the JSONL files are good enough or SQLite would be better. Verdict: **keep JSONL.** SQLite solves problems Zephyr doesn't have, and it breaks two guarantees it relies on.

## How storage is used today (`src/store.ts`)

- Every log is read once at start into memory: `entries`, `runs`, `adjustments` and `questions`. After that, appends go through a per-file exclusive section. No query reads the disk on the hot path.
- Three paths re-read a file:
  - the digest re-reads `runs.jsonl`, because memory keeps only 50 runs;
  - purge re-reads `adjustments.jsonl` and `questions.jsonl`.
  - All three are rare and user-triggered.
- Rewrites only happen during a purge and are atomic: a tmp file plus a rename, inside the same exclusive section as appends.
- Views are real files: `.md`, `.svg` and `.txt` bodies plus a JSON sidecar. `writeView` writes the body first, then the metadata. `loadViews` reads a view only through its metadata, so a crash leaves no half-written view. Since `9a5fec2`, a corrupt sidecar is skipped.

## Measured

- Real data: 13 entries at 254 bytes each, 10 runs at 297 bytes each.
- Projected heavy use: 50 notes a day and about 3 runs per note.
  - That is about 1 KB per note.
  - After 4 years: 20k entries (6 MB) and 60k runs (14 MB).
- Parse time in Bun, synthetic lines of the same shape:
  - 60k runs (13.7 MB): 17 ms
  - 20k entries (6.3 MB): 4 ms
  - 300k runs (69 MB): 87 ms
- Start-up and digest cost stay far below anything the person would notice for years.

## What SQLite would buy, and why it doesn't pay

| SQLite gain | Zephyr's situation |
|---|---|
| Indexed queries without loading everything | Everything already lives in memory; the data is tiny. |
| Atomic writes across several files | The single writer per kind and per-file exclusive sections already give the needed atomicity. Metadata-last makes view writes crash-safe. |
| Concurrent writers | Only one process writes. |
| Bounded growth | Not solved by SQLite. The data only grows either way; compaction is a policy question. |

## What SQLite would cost

1. **Plain files (design lesson 6).** Topic pages are `.md` files you can open, grep and keep without Zephyr. They would have to stay files anyway, which would leave two stores to keep in step.
2. **Purge proof.** Purge is verified by `rg -uu -i` finding nothing under `data/`. In SQLite a deleted row lingers in free pages and in the WAL until `VACUUM`, or until `secure_delete` plus a checkpoint. That is one more thing to get right, and harder to check.
3. **Migration work.**
   - Rewriting `Store` for SQLite.
   - Migrating existing data dirs.
   - Updating the tests that seed or read `data/` files (`test/helpers.ts` `seedDataDir`, `filesUnder`, `metaOnDisk`).
   - `bun:sqlite` would add no dependency (the opencode adapter already uses it), so that part costs nothing.

## When to revisit

Any of these makes the case for SQLite:

- More than one process writes `data/`. For example, a second server or a CLI that edits while the server runs.
- A query has to run over data too big to keep in memory, such as full-text search over 100k+ notes.
- Start-up parsing passes about 500 ms. At today's rate that's around 1M runs, decades away.

## Plan (small)

1. **Record the decision.** In `docs/design.md`, add a "Storage: plain files" section with the numbers above, the purge argument and the revisit triggers.
2. **Leave the growth issue open.** The state.md open issue about `adjustments.jsonl`, `questions.jsonl` and `runs.jsonl` only growing stays open as a low-priority item. Fix it with compaction in the sweep only if one of the triggers above shows up, not by switching storage.
3. **Commit** the doc change.

Verification: the doc renders, and its numbers match this evaluation. No code changes.
