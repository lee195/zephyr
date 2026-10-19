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

export interface View {
  id: string
  kind: string
  slug: string
  title: string
  sources: EntryId[]
  format: ViewFormat
  body: string
  updatedAt: string
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Run {
  id: string
  kind: string
  entryIds: EntryId[]
  status: RunStatus
  /** 1-based; a retry of a failed run is the next attempt. */
  attempt: number
  retryOf?: string
  startedAt?: string
  endedAt?: string
  error?: string
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

export interface ModelBackend {
  complete(messages: ChatMessage[], opts: { json: true }): Promise<unknown>
}

export interface ViewUpsert {
  slug: string
  title: string
  sources: EntryId[]
  body: string
}

export type Validation = { ok: true; upserts: ViewUpsert[] } | { ok: false; error: string }

export interface AgentKind {
  kind: string
  format: ViewFormat
  buildMessages(newEntries: Entry[], ownViews: View[], recentEntries: Entry[]): ChatMessage[]
  validate(json: unknown, knownIds: ReadonlySet<EntryId>): Validation
}

export type ZephyrEvent =
  | { type: 'entry'; data: Entry }
  | { type: 'run'; data: Run }
  | { type: 'view'; data: View }

export const NOTE_MARKER = '[zephyr] '
