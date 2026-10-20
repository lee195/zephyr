import type { RelevanceBackend, RelevanceDoc } from './relevance'

export type EntryId = string
export type Harness = string

export interface Entry {
  id: EntryId
  harness: Harness
  sessionId: string
  at: string
  text: string
  /**
   * When this server first stored the entry, on its own clock. A note backfilled late carries an old `at`, so only
   * this says whether it arrived after a review. Absent on entries stored before it was recorded.
   */
  receivedAt?: string
}

export type ViewFormat = 'md' | 'svg' | 'ascii'

export type TaskId = string

export interface Task {
  id: TaskId
  text: string
  /** An ISO date when the model resolved one against the note's time, else the note's own words. */
  due?: string
  done: boolean
  sources: EntryId[]
}

export interface View {
  id: string
  kind: string
  slug: string
  title: string
  sources: EntryId[]
  format: ViewFormat
  body: string
  updatedAt: string
  /** The updatedAt of the view's first write. Absent on views first written before it was recorded. */
  createdAt?: string
  /** The first write was an adjustment's, such as a split: the person made this view, so no digest lists it as new. */
  createdByPerson?: true
  /** The task list as data, on the tasks view only; body is its markdown rendering for plain-file readers. */
  tasks?: Task[]
  /** The topics grouped into areas, on the map view only; body is its markdown rendering for plain-file readers. */
  areas?: Area[]
  /** The view this one was derived from, at the version it was derived from; it is stale once that view moves on. */
  derivedFrom?: { id: string; updatedAt: string }
  /** Titles the view had before its current one, oldest first; until is the updatedAt of the write that replaced it. */
  pastTitles?: PastTitle[]
  /**
   * Writes in a row, since the last one that was not, whose body strictly extended the body before it. Measured by
   * the server from the bodies, so no kind can report it; absent when 0.
   */
  appendsSinceWrite?: number
  /** What the person fixed on this view, which no kind's run may undo. Set only by adjustments; absent when nothing is. */
  pins?: Pins
  /**
   * The page's notes changed under it (moved away, edited, removed, merged in), so its body may say what they no
   * longer support. Set by an adjustment, cleared by the rewrite run it queues; until then the topic is not drawn.
   */
  bodyStale?: true
  /**
   * Slugs of other topics the person linked to this one as related but separate, sorted. A link is always on both
   * topics. Set only by adjustments; a slug merged away follows its alias, and a deleted topic leaves every list.
   */
  related?: string[]
}

/** A topic as other views name it: by slug, with its title at the time. */
export type TopicRef = { slug: string; title: string }

/**
 * One group of the map, shown as a space: topics that belong together. The slug is the space's id, kept for as long
 * as the space exists, whatever its title becomes. createdAt is when a run first drew it; a space the person made has none.
 */
export type Area = { slug: string; title: string; topics: TopicRef[]; createdAt?: string }

/** What the person fixed on the map: space titles they chose, and the space they put a topic in, by topic slug. */
export interface SpacePins {
  titles?: Record<string, string>
  placed?: Record<string, string>
}

export interface Pins {
  /** The person chose the title; no run may change it. */
  title?: true
  /** Notes the person took off this page; no run may cite them here again. */
  excluded?: EntryId[]
  /** Slugs of topics merged into this one; a run's op on one of them lands here. */
  aliases?: string[]
  /** On the map only: what no map run may undo. */
  spaces?: SpacePins
}

export interface PastTitle {
  title: string
  until: string
  /** The person replaced this title with an adjustment, so no digest lists the rename back to them. */
  byPerson?: true
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Run {
  id: string
  kind: string
  entryIds: EntryId[]
  /** For a kind triggered by views: the view this run derives from. Absent for runs triggered by entries. */
  viewIds?: string[]
  status: RunStatus
  /** 1-based; a retry of a failed run is the next attempt. */
  attempt: number
  retryOf?: string
  startedAt?: string
  endedAt?: string
  error?: string
  /** Ops the reply asked for that validation refused, one reason each; the rest of the reply still applied. */
  dropped?: string[]
  /** On a done run, the entries its reply did not cover; they are retried like a failed run. Absent when it covered all. */
  uncovered?: EntryId[]
  /** View work on a view an adjustment marked bodyStale: the run carries out a change the person made. */
  forced?: true
  /** Done without a model call, because there was nothing left to do, such as a map another run already brought up to date. */
  noCall?: true
  /** On failed view work that gets no further attempt: the view's updatedAt then. The sweep skips the view until it changes. */
  exhausted?: string
}

export interface Session {
  harness: Harness
  sessionId: string
  /** The file that holds the session's transcript, in the harness's own format. */
  transcriptPath: string
  /** Where the adapter's next read resumes, in the adapter's own unit. */
  offset: number
}

/** One message in a harness transcript, reduced to what notes need. A message with no text is not a row. */
export interface Row {
  /** The harness's own message id; stable across re-reads, so it doubles as the entry id. */
  id: string
  sessionId: string
  at: string
  role: 'user' | 'assistant'
  text: string
}

export interface Batch {
  rows: Row[]
  offset: number
}

/** How one harness's transcript is read. Which rows are notes is the same rule for every harness: isNote. */
export interface TranscriptAdapter {
  harness: Harness
  /** The rows written after `offset`, and the offset the next read resumes from. Rows may repeat across reads. */
  read(transcriptPath: string, sessionId: string, offset: number): Promise<Batch>
  /** Where in the transcript a row is, in words a person can act on. */
  locate(transcriptPath: string, sessionId: string, rowId: string): string
}

export const isNote = (row: Row) => row.role === 'user' && row.text.startsWith(NOTE_MARKER)

export const noteEntry = (harness: Harness, row: Row): Entry => ({
  id: row.id,
  harness,
  sessionId: row.sessionId,
  at: row.at,
  text: row.text.slice(NOTE_MARKER.length),
})

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  /** Prompt tokens the endpoint served from its prefix cache. */
  cachedTokens?: number
}

/** usage is for whoever measures the backend; kinds only ever see json. */
export interface Completion {
  json: unknown
  usage?: Usage
}

export interface ModelBackend {
  complete(messages: ChatMessage[], opts: { json: true }): Promise<Completion>
}

/** What a kind's run may read: every entry and every view, of any kind. */
export interface World {
  entries: readonly Entry[]
  views: readonly View[]
  relevance: RelevanceBackend
}

/**
 * A view as a kind returns it; the server adds id, kind, updatedAt, createdAt, createdByPerson, pastTitles, appendsSinceWrite, pins,
 * bodyStale and related, so a kind can only write its own views and never their history or what the person fixed.
 */
export type ViewWrite = Omit<View, 'id' | 'kind' | 'updatedAt' | 'createdAt' | 'createdByPerson' | 'pastTitles' | 'appendsSinceWrite' | 'pins' | 'bodyStale' | 'related'>

/**
 * covered: the run's entries the reply dealt with, which is the kind's call; the run's other entries are retried.
 * questions: doubts the reply raised about notes it filed, already checked against what the run wrote.
 */
export type Settled = { ok: true; writes: ViewWrite[]; dropped: string[]; covered: EntryId[]; questions?: Question[] } | { ok: false; error: string }

/**
 * A doubt a run raised about a note it filed by its best guess, for the person to settle at review. Every kind of
 * doubt is answered by picking one of its answers, each `keep` or an adjustment, so no answer is free text.
 * - whichTopic: the note is on `chosen` and fits each of `alternatives` about as well; an alternative moves it there.
 * - isTask: task `taskId` was added from the note, which may not ask for one; `deleteTask` deletes it.
 */
export type Question =
  | { kind: 'whichTopic'; noteId: EntryId; chosen: string; alternatives: string[] }
  | { kind: 'isTask'; noteId: EntryId; taskId: TaskId }

/** How a question closed: kept as filed, changed by the adjustment the answer made, or moot because its note moved on. */
export type Closed = { how: 'kept' } | { how: 'applied'; adjustmentId: string } | { how: 'moot'; reason: string }

/** A line of questions.jsonl. Ids, slugs and answers only: a question shows a note's words by reading them when listed. */
export type QuestionLine =
  | { type: 'asked'; id: string; at: string; runId: string; question: Question }
  | { type: 'closed'; id: string; at: string; answer: string; closed: Closed }

/** One run's prompt, and how the reply to exactly that prompt becomes views. */
export interface Plan {
  messages: ChatMessage[]
  settle(json: unknown): Settled
}

/**
 * entry: every new entry is queued for the kind, and on start every entry no done run's reply covered.
 * view: a written view of `kind` is queued when `wants` says so, and on start every view it wants.
 */
export type Trigger = { on: 'entry' } | { on: 'view'; kind: string; wants(source: View, own: readonly View[]): boolean }

export interface AgentKind {
  kind: string
  trigger: Trigger
  /** null when there is nothing to ask the model; the run is then done without a call, covering all its entries. */
  plan(run: Run, world: World): Promise<Plan | null>
  /** The docs, drawn from these views, that this kind's runs will ask the relevance backend to rank. */
  relevanceDocs?(views: readonly View[]): RelevanceDoc[]
  /** Ids of the kind's own views that the periodic sweep queues as view work on the kind's own queue. */
  sweep?(world: World): string[]
  /** Ids of the kind's own views that should no longer exist; deleted after an adjustment and on start. */
  prune?(world: World): string[]
}

/**
 * A correction the person asked for after the fact. Topics are named by slug, notes and tasks by id. Every op is
 * applied by a step on its owning kind's queue, so it never races that kind's runs.
 * - moveNote: off `from`, onto `to`, which does not cite it yet. detachNote: off `from`, staying on `to`, which
 *   already cites it. Neither may leave `from` without notes, so a note is never left on no topic.
 * - splitTopic: `noteIds`, some but not all of the topic's notes, become the new topic `into`.
 * - editNote and tombstoneNote are overlays on entries.jsonl.
 * - linkTopics marks two topics related but separate, on both; unlinkTopics takes the link off both.
 * - moveTopicToSpace puts a topic in a space of the map, by the space's slug or, for a new space, its title; the
 *   placement is pinned. renameSpace sets a space's title and pins it.
 * - purgeNote is the one op that rewrites entries.jsonl: it removes the note and its words from the data dir.
 *   `confirm` must be exactly `purge <noteId>`.
 */
export type Adjustment =
  | { op: 'renameTopic'; slug: string; title: string }
  | { op: 'mergeTopics'; from: string; into: string }
  | { op: 'splitTopic'; slug: string; noteIds: EntryId[]; into: { slug: string; title: string } }
  | { op: 'moveNote'; noteId: EntryId; from: string; to: string }
  | { op: 'detachNote'; noteId: EntryId; from: string; to: string }
  | { op: 'editNote'; noteId: EntryId; text: string }
  | { op: 'moveTopicToSpace'; slug: string; space: string }
  | { op: 'renameSpace'; space: string; title: string }
  | { op: 'tombstoneNote'; noteId: EntryId }
  | { op: 'editTask'; taskId: TaskId; text?: string; due?: string | null }
  | { op: 'completeTask'; taskId: TaskId }
  | { op: 'deleteTask'; taskId: TaskId }
  | { op: 'linkTopics'; a: string; b: string }
  | { op: 'unlinkTopics'; a: string; b: string }
  | { op: 'purgeNote'; noteId: EntryId; confirm: string }

export type AdjustmentResult =
  | {
      id: string
      ok: true
      /** Ids of the views written and deleted; both empty when the state already matched. */
      written: string[]
      deleted: string[]
      /** Topics queued for a rewrite of their body. */
      rewrites: string[]
      /** What the op could not do and the person should know, such as a page too big to rewrite. */
      warnings: string[]
      purge?: PurgeReport
    }
  | { id: string; ok: false; error: string }

/**
 * What a purge removed before its result returned. The topics in the result's `rewrites` hold none of the note's
 * words already; their rewrite, still queued, makes them read whole again and catches paraphrase.
 */
export interface PurgeReport {
  noteId: EntryId
  tasksDeleted: TaskId[]
  historyFilesDeleted: number
  /** Saved review summaries deleted: each one that summarized the note or holds its words. */
  summariesDeleted: number
  /** Records rewritten or dropped per file. */
  lines: { entries: number; adjustments: number; runs: number; questions: number }
  /** Where the note's text still is, outside Zephyr's data. */
  stillIn: string
  status: string
}

/**
 * A line of adjustments.jsonl. The request is logged before the op applies and the result after, so a request with
 * no result is one a crash interrupted, and the next start applies it again.
 */
export type AdjustmentLine = { type: 'request'; id: string; at: string; adjustment: Adjustment } | { type: 'result'; id: string; result: AdjustmentResult }

export type ZephyrEvent =
  | { type: 'entry'; data: Entry }
  | { type: 'run'; data: Run }
  | { type: 'view'; data: View }
  | { type: 'removed'; data: { of: 'entry' | 'view'; id: string } }

export const NOTE_MARKER = '[zephyr] '
