import { adapters } from './adapters'
import type { AgentKind, Entry, EntryId, ModelBackend, Run, Session, View, ViewContext, ViewOp, ZephyrEvent } from './domain'
import { kinds as defaultKinds } from './kinds'
import { relevanceBackends, type RelevanceBackend } from './relevance'
import { Store } from './store'
import { Tailer, type Chunk } from './tailer'

const RUN_HISTORY = 50
const RECENT_CONTEXT = 30
/** Views the model sees in full per run, picked by relevance to the run's entries; the rest are index lines. */
const OPEN_VIEWS = 3
/** Wait before attempts 2, 3 and 4 of a failed run; after the last, the run stays failed. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

interface KindQueue {
  waiting: Run | null
  draining: Promise<void> | null
}

interface ScheduledRetry {
  /** Settles when the retry is enqueued or cancelled, so idle() can wait on it. */
  done: Promise<void>
  cancel(): void
}

export interface ZephyrOptions {
  dataDir: string
  backend: ModelBackend
  kinds?: Record<string, AgentKind>
  relevance?: RelevanceBackend
  pollMs?: number
  retryDelaysMs?: readonly number[]
}

const sessionKey = (harness: string, sessionId: string) => `${harness}:${sessionId}`

export class Zephyr {
  readonly store: Store
  private backend: ModelBackend
  private kinds: Record<string, AgentKind>
  private relevance: RelevanceBackend
  private pollMs: number
  private retryDelaysMs: readonly number[]

  private entries: Entry[] = []
  private entryIds = new Set<EntryId>()
  private views = new Map<string, View>()
  private sessions = new Map<string, Session>()
  private tailers = new Map<string, Tailer>()
  private runs: Run[] = []
  private queues = new Map<string, KindQueue>()
  private listeners = new Set<(e: ZephyrEvent) => void>()
  private runSeq = 0
  private retries = new Set<ScheduledRetry>()

  constructor(opts: ZephyrOptions) {
    this.store = new Store(opts.dataDir)
    this.backend = opts.backend
    this.kinds = opts.kinds ?? defaultKinds
    this.relevance = opts.relevance ?? relevanceBackends.tfidf!()
    this.pollMs = opts.pollMs ?? 1000
    this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS
  }

  async start() {
    await this.store.init()
    for (const e of await this.store.loadEntries()) {
      if (this.entryIds.has(e.id)) continue
      this.entryIds.add(e.id)
      this.entries.push(e)
    }
    for (const v of await this.store.loadViews()) this.views.set(v.id, v)
    const finished = await this.store.loadRuns()
    this.runs = (finished ?? []).slice(-RUN_HISTORY)
    for (const kind of Object.keys(this.kinds)) {
      const covered = finished ? doneEntryIds(finished, kind) : await this.migrateCoverage(kind)
      const uncovered = this.entries.filter((e) => !covered.has(e.id)).map((e) => e.id)
      if (uncovered.length > 0) this.enqueue(kind, uncovered)
    }
    for (const s of await this.store.loadSessions()) this.sessions.set(sessionKey(s.harness, s.sessionId), s)
    await Promise.all([...this.sessions.values()].map((s) => this.tail(s)))
  }

  stop() {
    for (const t of this.tailers.values()) t.stop()
    this.tailers.clear()
    for (const r of this.retries) r.cancel()
    this.retries.clear()
  }

  /** Data dirs from before runs.jsonl: entries a kind's views already cite count as organized, recorded once as a done run. */
  private async migrateCoverage(kind: string): Promise<Set<EntryId>> {
    const cited = new Set(this.listViews().filter((v) => v.kind === kind).flatMap((v) => v.sources))
    if (cited.size === 0) return cited
    const now = new Date().toISOString()
    await this.store.appendRun({ id: `migrated-${kind}`, kind, entryIds: [...cited], status: 'done', attempt: 1, startedAt: now, endedAt: now })
    return cited
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
      runsInFlight: this.runs.filter((r) => r.status === 'queued' || r.status === 'running').length + this.retries.size,
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

  /** Resolves once every kind's queue has drained and no retry is still scheduled. */
  async idle() {
    while (true) {
      const pending = [...[...this.queues.values()].map((q) => q.draining), ...[...this.retries].map((r) => r.done)].filter(Boolean)
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

  /** Coalesces into the kind's waiting run if there is one; the merged run carries the highest attempt of its parts. */
  private enqueue(kind: string, ids: EntryId[], attempt = 1, retryOf?: string) {
    const q = this.queue(kind)
    if (q.waiting) {
      const have = new Set(q.waiting.entryIds)
      q.waiting.entryIds.push(...ids.filter((id) => !have.has(id)))
      q.waiting.attempt = Math.max(q.waiting.attempt, attempt)
      q.waiting.retryOf ??= retryOf
    } else {
      q.waiting = { id: `run-${Date.now()}-${this.runSeq++}`, kind, entryIds: [...ids], status: 'queued', attempt, retryOf }
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
      const views = this.viewContext(ownViews, newEntries)
      const { json: reply } = await this.backend.complete(kind.buildMessages(newEntries, views, recent), { json: true })
      const result = kind.validate(reply, {
        knownIds: this.entryIds,
        existingSlugs: new Set(ownViews.map((v) => v.slug)),
        openSlugs: new Set(views.open.map((v) => v.slug)),
      })
      if (!result.ok) throw new Error(`invalid reply: ${result.error}`)
      for (const op of result.ops) await this.applyOp(kind, op)
      if (result.dropped.length > 0) run.dropped = result.dropped
      run.status = 'done'
    } catch (err) {
      run.status = 'failed'
      run.error = (err as Error).message
      console.error(`[zephyr] ${kind.kind} ${run.id} attempt ${run.attempt} failed: ${run.error}`)
    }
    run.endedAt = new Date().toISOString()
    if (run.status === 'failed') this.scheduleRetry(run)
    this.emit({ type: 'run', data: run })
    await this.store.appendRun(run).catch((err) => console.error(`[zephyr] could not record ${run.id}: ${(err as Error).message}`))
  }

  private viewContext(ownViews: View[], newEntries: Entry[]): ViewContext {
    const query = newEntries.map((e) => e.text).join('\n')
    const ranked = this.relevance.rank(query, ownViews.map((v) => ({ id: v.id, text: `${v.title}\n${v.body}` })))
    const openIds = new Set(ranked.slice(0, OPEN_VIEWS).map((r) => r.id))
    const byId = new Map(ownViews.map((v) => [v.id, v]))
    return {
      open: [...openIds].map((id) => byId.get(id)!),
      indexed: ownViews.filter((v) => !openIds.has(v.id)),
    }
  }

  private scheduleRetry(run: Run) {
    const delay = this.retryDelaysMs[run.attempt - 1]
    if (delay === undefined) return
    let settle!: () => void
    const done = new Promise<void>((r) => (settle = r))
    const timer = setTimeout(() => {
      this.retries.delete(retry)
      this.enqueue(run.kind, run.entryIds, run.attempt + 1, run.id)
      settle()
    }, delay)
    const retry: ScheduledRetry = {
      done,
      cancel: () => {
        clearTimeout(timer)
        settle()
      },
    }
    this.retries.add(retry)
  }

  /** Validation guarantees an append targets an existing view. */
  private async applyOp(kind: AgentKind, op: ViewOp) {
    const id = `${kind.kind}/${op.slug}`
    const prior = this.views.get(id)
    // Union with prior sources: a page update should never silently orphan an entry it already cited.
    const cited = new Set([...(prior?.sources ?? []), ...op.sources])
    const page = op.op === 'write' ? { title: op.title, body: op.body } : { title: prior!.title, body: appendSection(prior!.body, op.body) }
    const view: View = {
      id,
      kind: kind.kind,
      slug: op.slug,
      ...page,
      sources: this.entries.filter((e) => cited.has(e.id)).map((e) => e.id),
      format: kind.format,
      updatedAt: new Date().toISOString(),
    }
    await this.store.writeView(view)
    this.views.set(id, view)
    this.emit({ type: 'view', data: view })
  }
}

function appendSection(body: string, section: string): string {
  const [head, tail] = [body.trimEnd(), section.trim()]
  return head && tail ? `${head}\n\n${tail}` : head || tail
}

function doneEntryIds(runs: Run[], kind: string): Set<EntryId> {
  return new Set(runs.filter((r) => r.kind === kind && r.status === 'done').flatMap((r) => r.entryIds))
}
