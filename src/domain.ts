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

/** write replaces a view's body (new slug, or an open one); append adds a section to an existing view. */
export type ViewOp =
  | { op: 'write'; slug: string; title: string; sources: EntryId[]; body: string }
  | { op: 'append'; slug: string; sources: EntryId[]; body: string }

export type Validation = { ok: true; ops: ViewOp[]; dropped: string[] } | { ok: false; error: string }

/** What the model was shown: open views in full, indexed views as one line each. */
export interface ViewContext {
  open: View[]
  indexed: View[]
}

export interface ReplyContext {
  knownIds: ReadonlySet<EntryId>
  existingSlugs: ReadonlySet<string>
  openSlugs: ReadonlySet<string>
}

export interface AgentKind {
  kind: string
  format: ViewFormat
  buildMessages(newEntries: Entry[], views: ViewContext, recentEntries: Entry[]): ChatMessage[]
  validate(json: unknown, ctx: ReplyContext): Validation
}

export type ZephyrEvent =
  | { type: 'entry'; data: Entry }
  | { type: 'run'; data: Run }
  | { type: 'view'; data: View }

export const NOTE_MARKER = '[zephyr] '
