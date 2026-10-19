import type { RelevanceBackend, RelevanceDoc } from './relevance'

export type EntryId = string
export type Harness = string

export interface Entry {
  id: EntryId
  harness: Harness
  sessionId: string
  at: string
  text: string
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
  /** The task list as data, on the tasks view only; body is its markdown rendering for plain-file readers. */
  tasks?: Task[]
  /** The view this one was derived from, at the version it was derived from; it is stale once that view moves on. */
  derivedFrom?: { id: string; updatedAt: string }
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
}

export interface Session {
  harness: Harness
  sessionId: string
  transcriptPath: string
  offset: number
}

export interface TranscriptAdapter {
  harness: Harness
  parseLine(line: string): Entry | null
}

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

/** A view as a kind returns it; the server adds id, kind and updatedAt, so a kind can only write its own views. */
export type ViewWrite = Omit<View, 'id' | 'kind' | 'updatedAt'>

export type Settled = { ok: true; writes: ViewWrite[]; dropped: string[] } | { ok: false; error: string }

/** One run's prompt, and how the reply to exactly that prompt becomes views. */
export interface Plan {
  messages: ChatMessage[]
  settle(json: unknown): Settled
}

/**
 * entry: every new entry is queued for the kind, and on start every entry no done run covered.
 * view: a written view of `kind` is queued when `wants` says so, and on start every view it wants.
 */
export type Trigger = { on: 'entry' } | { on: 'view'; kind: string; wants(source: View, own: readonly View[]): boolean }

export interface AgentKind {
  kind: string
  trigger: Trigger
  /** null when there is nothing to ask the model; the run is then done without a call. */
  plan(run: Run, world: World): Promise<Plan | null>
  /** The docs, drawn from these views, that this kind's runs will ask the relevance backend to rank. */
  relevanceDocs?(views: readonly View[]): RelevanceDoc[]
}

export type ZephyrEvent =
  | { type: 'entry'; data: Entry }
  | { type: 'run'; data: Run }
  | { type: 'view'; data: View }

export const NOTE_MARKER = '[zephyr] '
