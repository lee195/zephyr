# Exploration: real-time collaboration

A possible future extension, explored on 2026-10-20. Nothing here is built or planned yet; it records the options and a recommendation so a later decision starts from them. For what Zephyr is today, see [design.md](design.md) and [state.md](state.md).

## What today's design assumes

Any collaboration design has to change or keep these:

- **Input is each person's harness transcript, read from local disk.** A harness registers a session with `POST /sessions { harness, sessionId, transcriptPath }`, and the server tails that file (`src/tailer.ts`). A server on another machine cannot read anyone's transcript.
- **Entries are immutable, and their id is the harness's message id** (`noteEntry` in `src/domain.ts`). Reading the same row twice changes nothing. This is what makes notes from several people easy to merge.
- **One process, one writer per kind.** Each kind runs through its own serial queue, and adjustments run as steps on the owning kind's queue (`step` in `src/zephyr.ts`), so no update is lost.
- **Local-only security.** Mutating routes refuse a foreign `Origin` and need a JSON content type (`refuseMutation` in `src/server.ts`). There is no login, no token, and no author on an entry.
- **One person.** The review cursor (`data/review.json`), the pins a review sets and the purge confirmation all assume a single owner, who can also clean their own transcript.
- **Plain files** under `data/`, so the notes outlive the tool.

## What "collaboration" could mean

Three scenarios, told apart by who types, who sees and who corrects:

| Scenario | Who types | Who sees | Who corrects |
|---|---|---|---|
| A. Shared viewing | the owner | others, live | the owner |
| B. Shared notebook, such as meeting notes | several people, each in their own harness | everyone, one set of topics and one map | the owner, or one moderator |
| C. Shared corrections | several | everyone | several, possibly at once |

## Architecture options

### Hub: one server owns each shared notebook

One hosted Zephyr per shared notebook. Instead of handing over a transcript path, the mod and the opencode plugin push each note row over HTTP, say `POST /notes`. The message id stays the entry id, so a push is idempotent and a retry costs nothing.

What it keeps: one writer per kind still holds, because there is still one process, and the viewer already streams updates over SSE (`GET /events`). One organizer run serves everyone, on the shared vLLM endpoint.

What it needs: a token per person, kept in a password manager and never put on a command line; TLS; and an author on each entry. This is the server-authoritative model that multiplayer design tools such as Figma use: clients send changes, and one server puts them in order.

### Local-first sync: everyone runs their own Zephyr

Each person keeps a local server, and the servers sync. Entries merge trivially: they are a grow-only set keyed by id. Everything derived does not. Each person's organizer files the same notes differently, so either the topic pages diverge per person, or one replica is chosen to write them, which is a hub again. Adjustments would need a causal order (Lamport clocks, or a CRDT log as Yjs and Automerge provide), and two people's pins would collide.

High cost for a result the hub gets more simply.

### Git-synced data folder

`entries.jsonl` merges as a union of lines, but views, pins and sidecars conflict on almost every merge, and it is not real time. Listed only for completeness.

## Privacy and scope

Notes are personal by default, so sharing has to be a choice made per space, never a global switch. This ties into the parked spaces phase 3: `/zephyr space <name>` becomes the routing switch. A personal space stays on the local server; a shared space sends its notes to that space's hub. One note never goes to both.

## What changes under the hub

- **Ingestion.** Push instead of tail, with the same dedupe by id. The local transcript stays the person's own record.
- **Identity.** An author on entries and on adjustment lines, and a token per person.
- **Review.** A cursor per person, so each sees their own "since last review".
- **Concurrent corrections.** The serial queues already prevent lost updates. Conflicting intent remains, such as two people renaming one topic: the later write wins, pins keep it, and the digest names who changed what.
- **Purge.** A purge reaches the hub's data, but not the transcripts on other people's machines. Who may purge someone else's note is a policy decision, not a technical one.
- **Hints across people.** "Anna noted this 5 minutes ago" while you type. In a meeting this surfaces duplicate notes as they happen, which is value collaboration adds beyond sharing.

## Real-time aspects

The viewer already updates live over SSE. A note shows up for everyone once the organizer has filed it, so the delay is one organizer call. Presence, such as who is typing in this space, could ride on the hint request the mod already sends after a second of quiet; it should be opt-in.

## Recommendation

The hub, scoped to shared spaces, is the only direction worth an implementation plan. Start with scenario B for one small team: scenario A comes with it for free, and scenario C follows once adjustments carry an author. Local-first sync is not worth it, because it works only once one replica writes the views, which is a hub again.

## Open decisions

- Which scenario matters first.
- Hosting: a Coolify deployment in-house, so the data never leaves the team.
- Purge across people: only the author, a moderator, or anyone in the space.
- Whether presence is wanted at all.

## What it would take

Rough order, not a plan:

1. Push ingestion with per-person tokens.
2. Shared spaces as the routing switch (spaces phase 3).
3. Authors on entries and adjustments.
4. A review cursor per person.
5. Hints across people.
