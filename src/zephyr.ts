import { adapters } from './adapters'
import type { AgentKind, Entry, EntryId, ModelBackend, Run, Session, View, ZephyrEvent } from './domain'
import { kinds as defaultKinds } from './kinds'
import { Store } from './store'
import { Tailer, type Chunk } from './tailer'

const RUN_HISTORY = 50
const RECENT_CONTEXT = 30

interface KindQueue {
  waiting: Run | null
  draining: Promise<void> | null
}

export interface ZephyrOptions {
  dataDir: string
  backend: ModelBackend
  kinds?: Record<string, AgentKind>
  pollMs?: number
}

const sessionKey = (harness: string, sessionId: string) => `${harness}:${sessionId}`

export class Zephyr {
  readonly store: Store
  private backend: ModelBackend
  private kinds: Record<string, AgentKind>
  private pollMs: number

  private entries: Entry[] = []
  private entryIds = new Set<EntryId>()
  private views = new Map<string, View>()
  private sessions = new Map<string, Session>()
  private tailers = new Map<string, Tailer>()
  private runs: Run[] = []
  private queues = new Map<string, KindQueue>()
  private listeners = new Set<(e: ZephyrEvent) => void>()
  private runSeq = 0

  constructor(opts: ZephyrOptions) {
    this.store = new Store(opts.dataDir)
    this.backend = opts.backend
    this.kinds = opts.kinds ?? defaultKinds
    this.pollMs = opts.pollMs ?? 1000
  }

  async start() {
    await this.store.init()
    for (const e of await this.store.loadEntries()) {
      if (this.entryIds.has(e.id)) continue
      this.entryIds.add(e.id)
      this.entries.push(e)
    }
    for (const v of await this.store.loadViews()) this.views.set(v.id, v)
    for (const s of await this.store.loadSessions()) this.sessions.set(sessionKey(s.harness, s.sessionId), s)
    await Promise.all([...this.sessions.values()].map((s) => this.tail(s)))
  }

  stop() {
    for (const t of this.tailers.values()) t.stop()
    this.tailers.clear()
  }

  subscribe(fn: (e: ZephyrEvent) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: ZephyrEvent) {
    for (const fn of this.listeners) fn(e)
  }

  listEntries() {
    return this.entries
  }
  listViews() {
    return [...this.views.values()]
  }
  listRuns() {
    return this.runs
  }

  status() {
    let lastViewAt: string | null = null
    for (const v of this.views.values()) if (!lastViewAt || v.updatedAt > lastViewAt) lastViewAt = v.updatedAt
    return {
      up: true as const,
      entries: this.entries.length,
      runsInFlight: this.runs.filter((r) => r.status === 'queued' || r.status === 'running').length,
      lastViewAt,
      sessions: this.sessions.size,
    }
  }

  /** Idempotent: a known session keeps its offset unless its transcript path changed. */
  async registerSession(harness: string, sessionId: string, transcriptPath: string) {
    if (!adapters[harness]) throw new Error(`unknown harness: ${harness}`)
    const key = sessionKey(harness, sessionId)
    const existing = this.sessions.get(key)
    if (existing && existing.transcriptPath === transcriptPath) return
    this.tailers.get(key)?.stop()
    const session: Session = { harness, sessionId, transcriptPath, offset: 0 }
    this.sessions.set(key, session)
    await this.saveSessions()
    await this.tail(session)
  }

  private saveSessions() {
    return this.store.saveSessions([...this.sessions.values()])
  }

  private async tail(session: Session) {
    const key = sessionKey(session.harness, session.sessionId)
    const adapter = adapters[session.harness]
    if (!adapter) return
    const tailer = new Tailer(
      session.transcriptPath,
      session.offset,
      async (chunk: Chunk) => {
        const parsed = chunk.lines.map((l) => adapter.parseLine(l)).filter((e): e is Entry => e !== null)
        await this.ingest(parsed)
        // Offset is persisted only after the entries are on disk; a crash in between replays and dedupes.
        session.offset = chunk.offset
        await this.saveSessions()
      },
      this.pollMs,
    )
    this.tailers.set(key, tailer)
    await tailer.start()
  }

  /** Appends unseen entries and queues them for every kind. Returns the entries that were new. */
  async ingest(candidates: Entry[]): Promise<Entry[]> {
    const fresh: Entry[] = []
    for (const e of candidates) {
      if (this.entryIds.has(e.id)) continue
      this.entryIds.add(e.id)
      fresh.push(e)
    }
    if (fresh.length === 0) return fresh
    await this.store.appendEntries(fresh)
    this.entries.push(...fresh)
    for (const e of fresh) this.emit({ type: 'entry', data: e })
    for (const kind of Object.keys(this.kinds)) this.enqueue(kind, fresh.map((e) => e.id))
    return fresh
  }

  /** Resolves once every kind's queue has drained. */
  async idle() {
    while (true) {
      const pending = [...this.queues.values()].map((q) => q.draining).filter(Boolean)
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  private queue(kind: string): KindQueue {
    let q = this.queues.get(kind)
    if (!q) {
      q = { waiting: null, draining: null }
      this.queues.set(kind, q)
    }
    return q
  }

  private enqueue(kind: string, ids: EntryId[]) {
    const q = this.queue(kind)
    if (q.waiting) {
      q.waiting.entryIds.push(...ids)
    } else {
      q.waiting = { id: `run-${Date.now()}-${this.runSeq++}`, kind, entryIds: [...ids], status: 'queued' }
      this.recordRun(q.waiting)
    }
    this.emit({ type: 'run', data: q.waiting })
    if (!q.draining) q.draining = this.drain(kind, q)
  }

  private async drain(kind: string, q: KindQueue) {
    while (q.waiting) {
      const run = q.waiting
      q.waiting = null
      await this.execute(this.kinds[kind]!, run)
    }
    // Cleared in the same tick as the empty check, so an enqueue can never land between them unseen.
    q.draining = null
  }

  private recordRun(run: Run) {
    this.runs.push(run)
    if (this.runs.length > RUN_HISTORY) this.runs.splice(0, this.runs.length - RUN_HISTORY)
  }

  private async execute(kind: AgentKind, run: Run) {
    run.status = 'running'
    run.startedAt = new Date().toISOString()
    this.emit({ type: 'run', data: run })
    try {
      const runIds = new Set(run.entryIds)
      const newEntries = this.entries.filter((e) => runIds.has(e.id))
      const recent = this.entries.filter((e) => !runIds.has(e.id)).slice(-RECENT_CONTEXT)
      const ownViews = this.listViews().filter((v) => v.kind === kind.kind)
      const reply = await this.backend.complete(kind.buildMessages(newEntries, ownViews, recent), { json: true })
      const result = kind.validate(reply, this.entryIds)
      if (!result.ok) throw new Error(`invalid reply: ${result.error}`)
      for (const u of result.upserts) await this.applyUpsert(kind, u)
      run.status = 'done'
    } catch (err) {
      run.status = 'failed'
      run.error = (err as Error).message
      console.error(`[zephyr] ${kind.kind} ${run.id} failed: ${run.error}`)
    }
    run.endedAt = new Date().toISOString()
    this.emit({ type: 'run', data: run })
  }

  private async applyUpsert(kind: AgentKind, u: { slug: string; title: string; sources: EntryId[]; body: string }) {
    const id = `${kind.kind}/${u.slug}`
    const prior = this.views.get(id)
    // Union with prior sources: a page update should never silently orphan an entry it already cited.
    const cited = new Set([...(prior?.sources ?? []), ...u.sources])
    const view: View = {
      id,
      kind: kind.kind,
      slug: u.slug,
      title: u.title,
      sources: this.entries.filter((e) => cited.has(e.id)).map((e) => e.id),
      format: kind.format,
      body: u.body,
      updatedAt: new Date().toISOString(),
    }
    await this.store.writeView(view)
    this.views.set(id, view)
    this.emit({ type: 'view', data: view })
  }
}
