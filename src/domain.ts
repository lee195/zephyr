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
  /** The task list as data, on the tasks view only; body is its markdown rendering for plain-file readers. */
  tasks?: Task[]
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
}

export interface Pins {
  /** The person chose the title; no run may change it. */
  title?: true
  /** Notes the person took off this page; no run may cite them here again. */
  excluded?: EntryId[]
  /** Slugs of topics merged into this one; a run's op on one of them lands here. */
  aliases?: string[]
}

export interface PastTitle {
  title: string
  until: string
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
 * A view as a kind returns it; the server adds id, kind, updatedAt, createdAt, pastTitles, appendsSinceWrite, pins
 * and bodyStale, so a kind can only write its own views and never their history or what the person fixed.
 */
export type ViewWrite = Omit<View, 'id' | 'kind' | 'updatedAt' | 'createdAt' | 'pastTitles' | 'appendsSinceWrite' | 'pins' | 'bodyStale'>

/** covered: the run's entries the reply dealt with, which is the kind's call; the run's other entries are retried. */
export type Settled = { ok: true; writes: ViewWrite[]; dropped: string[]; covered: EntryId[] } | { ok: false; error: string }

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
}

export type ZephyrEvent =
  | { type: 'entry'; data: Entry }
  | { type: 'run'; data: Run }
  | { type: 'view'; data: View }

export const NOTE_MARKER = '[zephyr] '
