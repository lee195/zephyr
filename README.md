# Zephyr

Take notes by typing into your agent harness. The Zephyr mod writes each note into the session transcript as a user row starting with `[zephyr] `. This server tails the registered transcripts, copies each note into `data/entries.jsonl`, runs agent kinds on the vLLM endpoint, and writes the derived views as plain files. A localhost viewer shows them live. The viewer only displays; input always comes from the harness.

Why it is built this way is in [docs/design.md](docs/design.md). What is built, what was checked and what is open is in [docs/state.md](docs/state.md).

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

Other scripts: `bun run dev` (server with reload), `bun run dev:viewer` (Vite, proxied to the server), `bun run build`, `bun test`, and `bun run typecheck` (`tsc` for the server and tests, `vue-tsc` for the viewer's `.vue` files).

## Data

```
data/
  entries.jsonl                 one Entry per line, append-only except for a purge; receivedAt is when the server stored it
  sessions.json                 registered transcripts and where each read resumes
  views/<kind>/<slug>.md        view body (.svg / .txt for other formats)
  views/<kind>/<slug>.json      view metadata: title, sources, updatedAt, createdAt, pastTitles, appendsSinceWrite,
                                pins, bodyStale, related
  views/<kind>/.history/<slug>/<updatedAt>.md
                                a page as it was before a rewrite replaced it or an adjustment deleted it
  embeddings/<backend>.jsonl    cached document vectors; the sweep drops those no ranking can ask about
  runs.jsonl                    every finished run, append-only
  review.json                   { lastReviewedAt }: where the last review ended
  adjustments.jsonl             every adjustment: a request line, then a result line once it applied
  purged.json                   { ids }: purged notes, by id only; a transcript re-read never brings one back
  questions.jsonl               questions runs raised: an asked line, then a closed line once answered; ids and slugs only
  summaries/<until>.md          a review summary saved on request; front matter holds the window and the ids it summarized
```

The viewer shows a topic's `.history` versions under its card and the saved summaries on their own page; the files stay plain markdown next to the page.

## Cleanup sweep

On start and every `ZEPHYR_SWEEP_MINUTES`, the server sweeps:

- A topic an adjustment marked `bodyStale` is queued for a rewrite whatever its append count; see Adjustments.
- A topic whose last 5 writes each only extended its body (`appendsSinceWrite`, counted by the server from the bodies) reads like a log, so it is queued for a rewrite on the organizer's own queue. The model gets the page and every note it cites, in full, and returns the whole page. The rewrite must keep the slug and cite every note the page cites, or the run fails and retries. The old page goes to `.history`, and the diagram is redrawn. A topic whose body and notes exceed 32,000 characters is not rewritten. Notes waiting in the queue are filed before a rewrite. A rewrite whose attempts ran out is not tried again until the page changes, across restarts too: its last run in `runs.jsonl` carries the page version as `exhausted`.
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
| `map` | an organizer topic written under a slug or title the map does not list; a sweep that finds the map's topics differ from the current ones (a merge or delete) | `map/contents.json` holds the topics grouped into at most 9 areas (`areas: [{ slug, title, topics: [{ slug, title }], createdAt? }]`), `map/contents.md` renders them with links to the topic pages. An area is a space: its slug stays while the model names it in its reply, whatever the title becomes. The model is shown the current areas and keeps them where they fit; topics it leaves out go under Other. The person's space pins (`pins.spaces`) win over the reply: a pinned title stays, and a pinned topic goes back to its space, with each overruled change in `run.dropped`. The viewer turns each area into a space |

A kind derived from views starts once every write of the run that triggered it has landed, so the map sees all the topics one run created and costs one call for them.

## Viewer

- **Sidebar.** A sticky left column lists the spaces, one per map area, each with its topic count and expandable to its topics. Below them are All topics, Tasks, Activity and Summaries. Under 760 px wide it folds behind a "☰ Spaces" button and opens as a drawer.
- **Pages.** The URL hash names the page: `#/space/<slug>` shows that space's topic cards, newest first, and narrows the notes column to the notes they cite. `#/all` shows every topic, including ones the map does not list yet. `#/tasks` and `#/activity` are the task list and the run history. `#/summaries` lists the saved review summaries, newest first, each opening to its text. Without a hash, the first space opens.
- **Earlier versions.** Each topic card has an "Earlier versions" disclosure. Opened, it lists the page's `.history` versions, newest first, and shows one in place when picked. It reads the files only while open and again whenever the page changes, so a version a purge deleted is not shown.
- **Activity.** The header shows runs in flight, the 3 newest done runs that called the model, and one chip per failing kind. The activity page pages through `runs.jsonl` with filters for kind and status. Runs that finished without a model call (`noCall`), such as map runs another run already did the work for, are hidden unless asked for.

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
| `linkTopics`, `unlinkTopics` | `a, b` | Marks two topics related but separate, or takes the mark off. The link is on both topics' `related`; see Related topics. |
| `moveTopicToSpace` | `slug, space` | Puts a topic in a space of the map: an existing one by its slug, or a new one by its title, whose title is then pinned. The placement is pinned in `pins.spaces.placed`. Applied on the map's queue; refused before any map exists. |
| `renameSpace` | `space, title` | Sets a space's title and pins it in `pins.spaces.titles`. |
| `purgeNote` | `noteId, confirm` | Removes the note and its words from the data dir; see Purge. `confirm` must be exactly `purge <noteId>`. |

`move`, `detach` and `split` refuse to leave a topic with no notes, so a note is never on no topic while it counts as filed.

- **Pins.** Topic views carry `pins: { title?, excluded?, aliases? }`, which no run can change. A run's op on an alias lands on the merge target as an append, a note taken off a topic is not cited there again, and a pinned title stays. Each refusal is a reason in the run's `dropped`.
- **Stale bodies.** An op that changes a topic's notes marks it `bodyStale` and queues a rewrite, which is told that the notes changed and are the truth. The flag is persisted, so the sweep on start re-queues a rewrite a restart interrupted. A page whose body and notes exceed 32,000 characters is not marked; the result carries a warning instead.
- **Overlay.** Only a purge rewrites `entries.jsonl`. Edits and tombstones are folded from `adjustments.jsonl` on start. A tombstoned note re-read from its transcript stays out.
- **Replay.** Every op converges from whatever state it finds, so applying one twice changes nothing. An op that throws partway, such as on a disk error, is applied again after 5 s, 30 s and 120 s, the run retry delays; once one attempt applies, its result is logged and the pages it left stale are queued for their rewrite. A request with no result line, cut short by a crash or by running out of retries, is applied again on the next start.

## Related topics

A topic's `related` lists the slugs of topics the person linked to it, sorted, and a link is always on both. It is server-owned like pins: no run sets it, and every write keeps it. A link is not a change to the page, so setting it keeps `updatedAt`: no diagram is redrawn and the append count holds. After every adjustment and on start, the lists are put right: a slug merged away is replaced by the topic it was merged into, a slug of a deleted topic leaves every list, and a link found on one side only, as a crash between the two writes leaves it, is put back on the other. The viewer lists a topic's related topics under its page, as links that scroll to their cards.

## Deeper processing

Three MCP tools for the review, each run only when the person asks:

- `summarize_review { save? }` has the model summarize the notes received since the last review and returns `{ since, until, notes, leftOut, summary, usage }`. It is shown at most 32,000 characters of notes, the budget a topic rewrite gets, so one call stays quick and is read in full. Past the cap it is shown the newest notes that fit, and `leftOut` counts the older ones. Nothing is stored unless `save` is true; then it is written to `summaries/<until>.md` and `path` says where. Summaries run one at a time, so two cannot interleave their writes, and a purge deletes saved ones in the same line, after any in flight.
- `rewrite_touched_topics` marks every topic that cites a note received since the last review `bodyStale`, in one step on the organizer's queue, so the rewrite runs rewrite each from its notes. It returns `{ queued, overCap }`; a topic over the 32,000-character cap is not marked.
- `suggest_links` shows the model the topic index (`slug | title | N sources`, the 200 most recently updated topics) and returns up to 5 pairs that are related but should stay separate, each with a one-line reason, plus the ones it dropped and why (an unknown topic, a pair already linked or suggested twice, no usable reason). It applies nothing. The review brief tells the agent to apply a pair with `link_topics` only after the person says yes.

## Purge

For a pasted secret or something private: `purgeNote` removes the note from Zephyr's data, which nothing else does. It runs one purge at a time, in this order, so a crash at any point leaves a request with no result that the next start finishes before it queues any run:

1. The id goes into `purged.json`, which start loads into the dedupe set, so no transcript re-read brings the note back (opencode re-reads every row each poll; a Claude Code transcript is re-read from 0 when it shrinks or its path changes).
2. The note leaves every in-memory list, so no run planned from now on is shown it.
3. Each kind's views are scrubbed on that kind's queue, after any run in flight that was shown the note, topics before diagrams. A topic whose only note it was is deleted with its `.history`. Any other topic citing it loses it from its sources and pins, has the note's words replaced by `[purged]` in its body, title and past titles, and is queued for a rewrite. Of the tasks, one that came only from the note is deleted, since nothing else supports it; others lose the note and its words. Every diagram citing it, or holding its words, is deleted and drawn again from the scrubbed page.
4. Archived bodies under `.history` that hold the note's words are deleted, and so is every saved summary that summarized the note or holds its words. Every question about the note is deleted from `questions.jsonl`, open or answered. `runs.jsonl` keeps note ids, which are opaque harness ids, but loses any of the note's words a reason carried. The embeddings cache is compacted, which drops the vector for the note's text; its key was only a hash.
5. `adjustments.jsonl` loses the note's words: an edit of the note keeps its line, with `[purged]` as its text, so replay still converges.
6. `entries.jsonl` is rewritten without the note, through a tmp file and a rename, in the same exclusive section as appends, so a note arriving meanwhile is not lost.

The note's words are its texts (original and every edit), whole, and each word of four or more characters that no remaining note contains, matched without case at word edges. A page is built only from notes, so such a word there came from the purged one. Scrubbing words is coarse, which is why each scrubbed topic is then rewritten from its remaining notes; the rewrite never sees the note's words. A topic over the 32,000-character cap is scrubbed but not rewritten, and the result warns that a paraphrase may remain. A slug that holds the note's words stays, since it is the page's id; the result counts them.

The result adds `purge: { noteId, tasksDeleted, historyFilesDeleted, summariesDeleted, lines: { entries, adjustments, runs, questions }, stillIn, status }`. Its `rewrites` are the topics whose rewrite is still queued; `GET /api/purge/<noteId>` returns `{ done, scrubbing, pending }` until they finish. `stillIn` names where the harness keeps its own copy (the Claude Code transcript file and line uuid, or the opencode database, session and message), which Zephyr never writes to; the person removes it there.

## Questions

An organizer or tasks run files every note by its best guess. When it doubts a guess it may also return up to 2 questions about the notes of that run, past which a run is guessing rather than doubting. There are two kinds, and every answer is `keep` or one adjustment, so no answer is free text:

| Kind | Raised when | Answers |
| --- | --- | --- |
| `whichTopic { noteId, chosen, alternatives }` | The note fits each alternative topic as well as `chosen`, where it was filed | `keep`, or an alternative's slug: `moveNote` there, `detachNote` if that topic already cites the note, or `mergeTopics` if the note was the only one on `chosen` |
| `isTask { noteId, taskId }` | The run added `taskId` from the note but doubts the note asks for one | `keep`, or `deleteTask` |

The reply is checked like its ops: a question about a note not in the run, a slug that is no topic, a `chosen` that does not cite the note, a second question about one note and every one past the cap are dropped, each with a reason in the run's `dropped`, and the ops still apply. An answer goes through the same `adjust` as any other adjustment and is logged there. An answer to a question whose note was removed, or moved off `chosen`, or whose task was deleted, closes it as moot and changes nothing. Topics are followed through merges: a `chosen` or an answer merged away since names the topic it was merged into, and `list_questions` shows that topic. When both now name the same topic, the note is already where the answer puts it, so the question closes as moot.

## HTTP

| Route | Purpose |
| --- | --- |
| `POST /sessions` `{ harness, sessionId, transcriptPath }` | Register a transcript. Idempotent. A new session is read from the start, so earlier notes are backfilled. |
| `GET /status` | `{ up, entries, runsInFlight, lastViewAt, sessions, lastNote, overCap, relevance: { warmup, pending, compaction } }`. `lastNote` is `{ id, at, topics }` for the newest note, with every topic it is filed under so far (empty until the organizer files it), or `null` before the first note. `overCap` lists the slugs of topics the last sweep found due for a rewrite but over the 32,000-character cap; each is logged once when it joins the list. `warmup` is `running`, `done` or `failed` for the background embedding of stored docs on start; `pending` counts docs being embedded now. `compaction` is `{ count, bytesBefore, bytesAfter }` for the cache compactions since start and the latest one's sizes, or `null` before the first. |
| `GET /hints?q=<draft>&limit=1..10` | `{ hints, backend, partial }`: stored entries related to the draft, each with `topics`, every topic that cites it. Never waits on embedding entries; `partial` is true when some were not embedded yet and so were left out. |
| `GET /api/views`, `/api/entries`, `/api/runs` | Current state; `/api/runs` holds the 50 newest runs |
| `GET /api/runs/history?before=<endedAt>&limit=1..200` | `{ runs, more }`: finished runs from `runs.jsonl`, newest first, ended before `before`; `limit` defaults to 50 |
| `GET /api/review` | The digest since the last review, computed on each request: `{ since, until, notes: { count, ids }, newTopics, newSpaces, topics, sharedNotes, renames, tasks, unfiled, rewrites, questions }`. `questions` holds every open question, whatever window it was asked in. Every list is about the notes the server received after `since` and up to `until`, or about writes in that window. It leaves out the person's own changes, renames and topics an adjustment made; a rewrite their change forced is listed with `yours: true`, since its new body is model text they have not seen. `since` is `null` before the first review. |
| `POST /api/review/done` `{ until }` | Ends a review: the next digest starts after `until`, the value the digest that was reviewed returned. A note received after that digest was read stays in the next one. Refuses an `until` in the future or before the last review. |
| `POST /api/adjustments` `{ op, ... }` | Apply one adjustment (below). 200 with `{ id, ok: true, written, deleted, rewrites, warnings }`; 400 for a malformed op; 409 with `{ id, ok: false, error }` when the data refuses it, such as an unknown topic; 202 with `{ id, ok: false, pending: true, error, retryInMs }` when it failed partway and is applied again, after `retryInMs` or, when that is `null`, on the next start; 503 when the request could not be logged, so nothing changed. |
| `GET /api/purge/<noteId>` | `{ noteId, done, scrubbing, pending }` for a purged note: `scrubbing` until the purge's result is logged, then `pending` lists the topics whose rewrite is still queued. 404 for a note never purged. |
| `GET /api/history/<kind>/<slug>` | `[{ at, format }]`: the view's `.history` versions, newest first; `[]` for a view with none or a name that is not one. `/<at>` returns `{ at, format, body }`, or 404. |
| `GET /api/summaries` | `[{ since, until, noteCount }]`: the saved review summaries, newest first. `/<until>` returns one with its `summary`, or 404. |
| `GET /api/review/brief` | The prompt a harness's review command submits, as text: the review's rules, naming the MCP tools, then the digest as JSON. |
| `POST /mcp` | MCP for the harness agent; see below. `GET /mcp` answers 405, since there is no server-to-client stream. |
| `GET /events` | SSE stream of `entry`, `run`, `view` and `removed` (`{ of: 'entry' \| 'view', id }`) events |
| `GET /` | Viewer |

Every request other than `GET` must send `content-type: application/json` (else 415) and either no `Origin` or a loopback one (else 403). The harness plugins send no `Origin`. A web page on another site, including one reaching this port through a DNS name that resolves to 127.0.0.1, sends its own and is refused.

## MCP

`POST /mcp` speaks MCP over Streamable HTTP, statelessly: each request is one JSON-RPC message and gets one JSON reply, or 202 for a notification. There is no session id and no SSE stream. It answers `initialize`, `ping`, `tools/list` and `tools/call`. Any other method gets -32601, which is also how a client's `server/discover` probe learns to fall back to `initialize`.

| Tool | Does |
| --- | --- |
| `get_review` | The digest, as `GET /api/review` returns it |
| `finish_review` `{ until }` | As `POST /api/review/done` |
| `list_topics` | Every topic: slug, title, note ids, and its space `{ slug, title }` (null until the map lists it) |
| `get_topic` `{ slug }` | The page body and the cited notes with their text |
| `search_notes` `{ query, limit? }` | As `GET /hints`, including which backend ranked |
| `get_purge` `{ noteId }` | As `GET /api/purge/<noteId>` |
| `summarize_review` `{ save? }`, `rewrite_touched_topics`, `suggest_links` | See Deeper processing |
| `list_questions` | The open questions (below), with the note's and topics' current text and the answers each takes |
| `answer_question` `{ questionId, answer }` | Close a question with one of its answers |
| `rename_topic`, `merge_topics`, `split_topic`, `move_note`, `detach_note`, `edit_note`, `tombstone_note`, `edit_task`, `complete_task`, `delete_task`, `link_topics`, `unlink_topics`, `purge_note` | One adjustment op each, with the op's fields as arguments. `purge_note`'s description tells the agent to call it only when the person explicitly asks to purge that note. |

Each op tool's input schema comes from the same field table (`OPS` in `src/adjust.ts`) that `POST /api/adjustments` validates with. A result is the JSON the HTTP route returns, as text. A malformed op or one the data refuses is a tool error carrying the 400 or 409 message. An op that failed partway is a tool error that says it is logged, when it is applied again, and not to send it again. An answer to a question whose adjustment failed partway still closes the question, since the logged adjustment applies later.

Add the server to a harness once:

- Claude Code: `claude mcp add --transport http --scope user zephyr http://127.0.0.1:7317/mcp`
- opencode, in `opencode.json`: `"mcp": { "zephyr": { "type": "remote", "url": "http://127.0.0.1:7317/mcp" } }`

The review commands (`/zephyr review` in Claude Code, `/zephyr-review` in opencode) look for a server named `zephyr`. MCP requests pass the same guard as every other POST; Claude Code 2.1.303 and opencode 1.18.33 send no `Origin`.

## Duplication

Code that appears exactly twice stays duplicated until a third copy appears. [docs/deferred-abstractions.md](docs/deferred-abstractions.md) lists each pair and the shared form to extract once there are three.
