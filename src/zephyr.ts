import { adapters } from './adapters'
import { hintsFor, type HintReply } from './hints'
import { isNote, noteEntry, type AgentKind, type Entry, type EntryId, type ModelBackend, type Run, type Session, type View, type ViewWrite, type World, type ZephyrEvent } from './domain'
import { kinds as defaultKinds, sanitizeSlug } from './kinds'
import { relevanceBackends, type Compaction, type RelevanceBackend, type RelevanceDoc } from './relevance'
import { buildDigest, closeWindow, type Digest, type WindowClose } from './review'
import { Store } from './store'
import { Tailer } from './tailer'

const RUN_HISTORY = 50
/** Wait before attempts 2, 3 and 4 of a failed run, or of the entries a done run left uncovered; after the last, they wait for a restart. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

/** What one queued run covers: the new entries for an entry-triggered kind, one source view for a view-triggered kind. */
type Work = { entryIds: EntryId[] } | { viewId: string }

interface KindQueue {
  /**
   * Keyed by attempt and what a run covers, so work on the same thing at the same attempt coalesces: one key for all
   * entries, one per source view. Work of different attempts never merges, so each keeps its own retries.
   */
  waiting: Map<string, Run>
  /** The run executing now, if any. */
  current: Run | null
  draining: Promise<void> | null
}

interface ScheduledRetry {
  kind: string
  /** The view the retried work is keyed by; absent for entry work. */
  viewId?: string
  /** Settles when the retry is enqueued or cancelled, so idle() can wait on it. */
  done: Promise<void>
  cancel(): void
}

export interface ZephyrOptions {
  dataDir: string
  backend: ModelBackend
  kinds?: Record<string, AgentKind>
  /** Ranks entries for organizer runs and for hints; tfidf when absent. */
  relevance?: RelevanceBackend
  pollMs?: number
  retryDelaysMs?: readonly number[]
  /** How often the sweep runs after the one on start; absent, it runs on start only. */
  sweepMs?: number
}

const sessionKey = (harness: string, sessionId: string) => `${harness}:${sessionId}`

export class Zephyr {
  readonly store: Store
  private backend: ModelBackend
  private kinds: Record<string, AgentKind>
  private relevance: RelevanceBackend
  private pollMs: number
  private retryDelaysMs: readonly number[]
  private sweepMs?: number
  private sweepTimer?: Timer

  private entries: Entry[] = []
  private entryIds = new Set<EntryId>()
  /** Ids whose append is in flight. Tailers run concurrently, and two can read the same rows: a re-registered session's old poke is not aborted. */
  private appending = new Set<EntryId>()
  private views = new Map<string, View>()
  private sessions = new Map<string, Session>()
  private tailers = new Map<string, Tailer>()
  private runs: Run[] = []
  private queues = new Map<string, KindQueue>()
  private listeners = new Set<(e: ZephyrEvent) => void>()
  private runSeq = 0
  private retries = new Set<ScheduledRetry>()
  /**
   * `${kind} ${viewId}` of view work whose last attempt failed, with the view's updatedAt then. The sweep skips it
   * until the view changes, so a page the model cannot rewrite costs no calls every sweep. Lost on restart.
   */
  private exhausted = new Map<string, string | undefined>()
  private lastStamp = 0
  /** The until of the last finished review; persisted in review.json. */
  private lastReviewedAt: string | null = null
  /** Compactions of the relevance backend's disk cache since start, and the latest one. */
  private compactions: { count: number; last: Compaction | null } = { count: 0, last: null }
  /** Readying every doc the relevance backend will be asked about, started by start() and never awaited by it. */
  private warmup: 'idle' | 'running' | 'done' | 'failed' = 'idle'

  constructor(opts: ZephyrOptions) {
    this.store = new Store(opts.dataDir)
    this.backend = opts.backend
    this.kinds = opts.kinds ?? defaultKinds
    this.relevance = opts.relevance ?? relevanceBackends.tfidf()
    this.pollMs = opts.pollMs ?? 1000
    this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS
    this.sweepMs = opts.sweepMs
  }

  async start() {
    await this.store.init()
    this.lastReviewedAt = await this.store.loadReviewCursor()
    for (const e of await this.store.loadEntries()) {
      if (this.entryIds.has(e.id)) continue
      this.entryIds.add(e.id)
      this.entries.push(e)
    }
    for (const v of await this.store.loadViews()) this.views.set(v.id, v)
    const finished = await this.store.loadRuns()
    this.runs = (finished ?? []).slice(-RUN_HISTORY)
    for (const kind of this.entryKinds()) {
      const covered = finished ? doneEntryIds(finished, kind.kind) : await this.migrateCoverage(kind.kind)
      const uncovered = this.entries.filter((e) => !covered.has(e.id)).map((e) => e.id)
      if (uncovered.length > 0) this.enqueue(kind.kind, { entryIds: uncovered })
    }
    for (const v of this.views.values()) this.deriveFrom(v)
    this.warm()
    void this.sweep()
    if (this.sweepMs) this.sweepTimer = setInterval(() => void this.sweep(), this.sweepMs)
    for (const s of await this.store.loadSessions()) this.sessions.set(sessionKey(s.harness, s.sessionId), s)
    await Promise.all([...this.sessions.values()].map((s) => this.tail(s)))
  }

  stop() {
    clearInterval(this.sweepTimer)
    for (const t of this.tailers.values()) t.stop()
    this.tailers.clear()
    for (const r of this.retries) r.cancel()
    this.retries.clear()
  }

  /** Every doc a ranking can be asked about now: the entries, and each kind's docs from the views. */
  private relevantDocs(): RelevanceDoc[] {
    return [...this.entries, ...Object.values(this.kinds).flatMap((k) => k.relevanceDocs?.(this.listViews()) ?? [])]
  }

  private warm() {
    this.warmup = 'running'
    void (this.relevance.prepare?.(this.relevantDocs()) ?? Promise.resolve()).then(
      () => {
        this.warmup = 'done'
      },
      (err) => {
        this.warmup = 'failed'
        console.warn(`[zephyr] relevance warm-up failed: ${(err as Error).message}`)
      },
    )
  }

  /**
   * Queues the view work each kind's sweep asks for, unless that view is busy in the kind's queue or its last
   * attempt was exhausted at the view's current version. The queueing is synchronous. Then the relevance backend
   * drops what it keeps on disk for docs no ranking can be asked about any more.
   */
  async sweep() {
    const world = this.world()
    let queued = 0
    for (const kind of Object.values(this.kinds)) {
      for (const viewId of kind.sweep?.(world) ?? []) {
        if (this.busy(kind.kind, viewId)) continue
        const key = `${kind.kind} ${viewId}`
        if (this.exhausted.has(key) && this.exhausted.get(key) === this.views.get(viewId)?.updatedAt) continue
        this.exhausted.delete(key)
        this.enqueue(kind.kind, { viewId })
        queued++
      }
    }
    const compaction = await this.relevance.compact?.(this.relevantDocs()).catch((err) => {
      console.warn(`[zephyr] sweep: embeddings cache compaction failed: ${(err as Error).message}`)
      return undefined
    })
    if (compaction) this.compactions = { count: this.compactions.count + 1, last: compaction }
    const cache = compaction && `; embeddings cache ${compaction.before.lines} lines/${compaction.before.bytes} bytes → ${compaction.after.lines} lines/${compaction.after.bytes} bytes`
    if (queued > 0 || cache) console.log(`[zephyr] sweep: queued ${queued} rewrites${cache ?? ''}`)
  }

  /** Work keyed by this view is waiting, running, or scheduled to retry in the kind's queue. */
  private busy(kind: string, viewId: string): boolean {
    const q = this.queue(kind)
    const keyedBy = (r: Run | null) => r?.viewIds?.[0] === viewId
    return keyedBy(q.current) || [...q.waiting.values()].some(keyedBy) || [...this.retries].some((r) => r.kind === kind && r.viewId === viewId)
  }

  /** Readies docs that just appeared, so the next ranking has them; never awaited. */
  private prepareRelevance(docs: RelevanceDoc[]) {
    if (docs.length === 0) return
    this.relevance.prepare?.(docs).catch((err) => console.warn(`[zephyr] relevance: could not prepare ${docs.length} docs: ${(err as Error).message}`))
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

  async hints(draft: string, limit: number): Promise<HintReply> {
    const reply = await hintsFor(draft, limit, this.entries, this.listViews(), this.relevance)
    // A partial answer means the endpoint is back while a failed warm-up left docs uncached, so finish the warm-up.
    if (reply.partial && this.warmup === 'failed') this.warm()
    return reply
  }

  /** The digest from the last review up to now. It reads runs.jsonl, since memory keeps only the last few runs. */
  async review(): Promise<Digest> {
    const until = this.stamp()
    return buildDigest(this.entries, this.listViews(), (await this.store.loadRuns()) ?? [], this.lastReviewedAt, until)
  }

  /** Moves the cursor to the until of the digest the review covered, so notes received since then stay unreviewed. */
  async finishReview(until: unknown): Promise<WindowClose> {
    const closed = closeWindow(until, this.lastReviewedAt, new Date(Math.max(Date.now(), this.lastStamp)).toISOString())
    if (!closed.ok) return closed
    this.lastReviewedAt = closed.until
    await this.store.saveReviewCursor(closed.until)
    return closed
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
      relevance: {
        warmup: this.warmup,
        pending: this.relevance.pending?.() ?? 0,
        compaction: this.compactions.last && { count: this.compactions.count, bytesBefore: this.compactions.last.before.bytes, bytesAfter: this.compactions.last.after.bytes },
      },
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
    if (!adapter) return console.warn(`[zephyr] skipping session ${session.sessionId}: no adapter for harness ${session.harness}`)
    const tailer = new Tailer(
      session.transcriptPath,
      session.offset,
      (offset) => adapter.read(session.transcriptPath, session.sessionId, offset),
      async (batch) => {
        await this.ingest(batch.rows.filter(isNote).map((row) => noteEntry(session.harness, row)))
        // Offset is persisted only after the entries are on disk; a crash in between replays and dedupes.
        if (batch.offset === session.offset) return
        session.offset = batch.offset
        await this.saveSessions()
      },
      this.pollMs,
    )
    this.tailers.set(key, tailer)
    await tailer.start()
  }

  /**
   * Appends unseen entries and queues them for every kind. Returns the entries that were new. An id counts as seen
   * only once it is on disk, so a failed append leaves the row for the tailer's re-read.
   */
  async ingest(candidates: Entry[]): Promise<Entry[]> {
    const unseen: Entry[] = []
    for (const e of candidates) {
      if (this.entryIds.has(e.id) || this.appending.has(e.id)) continue
      this.appending.add(e.id)
      unseen.push(e)
    }
    if (unseen.length === 0) return unseen
    const receivedAt = this.stamp()
    const fresh = unseen.map((e) => ({ ...e, receivedAt }))
    try {
      await this.store.appendEntries(fresh)
    } finally {
      for (const e of fresh) this.appending.delete(e.id)
    }
    for (const e of fresh) this.entryIds.add(e.id)
    this.entries.push(...fresh)
    for (const e of fresh) this.emit({ type: 'entry', data: e })
    this.prepareRelevance(fresh)
    for (const kind of this.entryKinds()) this.enqueue(kind.kind, { entryIds: fresh.map((e) => e.id) })
    return fresh
  }

  private entryKinds(): AgentKind[] {
    return Object.values(this.kinds).filter((k) => k.trigger.on === 'entry')
  }

  /** Queues every view-triggered kind that wants to derive from this view. */
  private deriveFrom(source: View) {
    for (const kind of Object.values(this.kinds)) {
      const t = kind.trigger
      if (t.on === 'view' && t.kind === source.kind && t.wants(source, this.listViews().filter((v) => v.kind === kind.kind)))
        this.enqueue(kind.kind, { viewId: source.id })
    }
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
      q = { waiting: new Map(), current: null, draining: null }
      this.queues.set(kind, q)
    }
    return q
  }

  /** Coalesces into the waiting run of the same attempt that covers the same thing. */
  private enqueue(kind: string, work: Work, attempt = 1, retryOf?: string) {
    const q = this.queue(kind)
    const key = `${attempt}:${'viewId' in work ? work.viewId : ''}`
    const ids = 'entryIds' in work ? work.entryIds : []
    let run = q.waiting.get(key)
    if (run) {
      const have = new Set(run.entryIds)
      run.entryIds.push(...ids.filter((id) => !have.has(id)))
      run.retryOf ??= retryOf
    } else {
      run = { id: `run-${Date.now()}-${this.runSeq++}`, kind, entryIds: [...ids], ...('viewId' in work && { viewIds: [work.viewId] }), status: 'queued', attempt, retryOf }
      q.waiting.set(key, run)
      this.recordRun(run)
    }
    this.emit({ type: 'run', data: run })
    if (!q.draining) q.draining = this.drain(kind, q)
  }

  /**
   * Waiting entry work runs before waiting view work, so a note lands on its page within one call of arriving;
   * view work such as a rewrite waits. Note flow is human-paced, so view work cannot starve.
   */
  private async drain(kind: string, q: KindQueue) {
    for (let next = nextWork(q.waiting); next; next = nextWork(q.waiting)) {
      const [key, run] = next
      q.waiting.delete(key)
      q.current = run
      await this.execute(this.kinds[kind]!, run)
      q.current = null
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
      const plan = await kind.plan(run, this.world())
      if (plan) {
        const { json: reply } = await this.backend.complete(plan.messages, { json: true })
        const result = plan.settle(reply)
        if (!result.ok) throw new Error(`invalid reply: ${result.error}`)
        // A run on one of the kind's own views revisits a page, so the page it replaces is kept.
        const revisit = run.viewIds?.[0]?.startsWith(`${kind.kind}/`) === true
        for (const w of result.writes) await this.writeView(kind, w, revisit)
        if (result.dropped.length > 0) run.dropped = result.dropped
        const covered = new Set(result.covered)
        const uncovered = run.entryIds.filter((id) => !covered.has(id))
        if (uncovered.length > 0) run.uncovered = uncovered
      }
      run.status = 'done'
    } catch (err) {
      run.status = 'failed'
      run.error = (err as Error).message
      console.error(`[zephyr] ${kind.kind} ${run.id} attempt ${run.attempt} failed: ${run.error}`)
    }
    run.endedAt = new Date().toISOString()
    if (run.status === 'failed') this.scheduleRetry(run, run.viewIds ? { viewId: run.viewIds[0]! } : { entryIds: run.entryIds })
    else if (run.uncovered) this.scheduleRetry(run, { entryIds: run.uncovered })
    this.emit({ type: 'run', data: run })
    await this.store.appendRun(run).catch((err) => console.error(`[zephyr] could not record ${run.id}: ${(err as Error).message}`))
  }

  private world(): World {
    return { entries: this.entries, views: this.listViews(), relevance: this.relevance }
  }

  /** Queues the work a run left undone as its next attempt, after that attempt's delay; none after the last attempt. */
  private scheduleRetry(run: Run, work: Work) {
    const delay = this.retryDelaysMs[run.attempt - 1]
    const viewId = 'viewId' in work ? work.viewId : undefined
    if (delay === undefined) {
      if (viewId) this.exhausted.set(`${run.kind} ${viewId}`, this.views.get(viewId)?.updatedAt)
      return
    }
    let settle!: () => void
    const done = new Promise<void>((r) => (settle = r))
    const timer = setTimeout(() => {
      this.retries.delete(retry)
      this.enqueue(run.kind, work, run.attempt + 1, run.id)
      settle()
    }, delay)
    const retry: ScheduledRetry = {
      kind: run.kind,
      ...(viewId && { viewId }),
      done,
      cancel: () => {
        clearTimeout(timer)
        settle()
      },
    }
    this.retries.add(retry)
  }

  /** Strictly increasing, so updatedAt orders every write to a view even within one millisecond; derived views compare it. */
  private stamp(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1)
    return new Date(this.lastStamp).toISOString()
  }

  /**
   * The id and directory come from the kind, never from the write, so a kind can only ever write its own views.
   * The title history is kept here, against the stored view, so it holds whichever kind or op changed the title.
   */
  private async writeView(kind: AgentKind, write: ViewWrite, archivePrior = false) {
    if (sanitizeSlug(write.slug) !== write.slug) throw new Error(`${kind.kind} returned an unsafe slug: ${write.slug}`)
    const id = `${kind.kind}/${write.slug}`
    const prior = this.views.get(id)
    if (prior && archivePrior) await this.store.archiveView(prior)
    const updatedAt = this.stamp()
    const pastTitles = prior && prior.title !== write.title ? [...(prior.pastTitles ?? []), { title: prior.title, until: updatedAt }] : prior?.pastTitles
    const appendsSinceWrite = prior && extendsBody(write.body, prior.body) ? (prior.appendsSinceWrite ?? 0) + 1 : 0
    const createdAt = prior ? prior.createdAt : updatedAt
    const view: View = { ...write, id, kind: kind.kind, updatedAt, ...(createdAt && { createdAt }), ...(pastTitles && { pastTitles }), ...(appendsSinceWrite > 0 && { appendsSinceWrite }) }
    await this.store.writeView(view)
    this.views.set(view.id, view)
    this.prepareRelevance(kind.relevanceDocs?.([view]) ?? [])
    this.emit({ type: 'view', data: view })
    this.deriveFrom(view)
  }
}

/** The first waiting entry work, else the first waiting work. */
function nextWork(waiting: Map<string, Run>): [string, Run] | undefined {
  for (const pair of waiting) if (!pair[1].viewIds) return pair
  return waiting.entries().next().value
}

/** The next body keeps all of the prior one, as its start, and adds to it. */
function extendsBody(next: string, prior: string): boolean {
  const head = prior.trimEnd()
  return next.length > head.length && next.startsWith(head)
}

/** Entries some done run of this kind covered. A line from before `uncovered` existed counts as covering all its entries. */
function doneEntryIds(runs: Run[], kind: string): Set<EntryId> {
  const covered = new Set<EntryId>()
  for (const r of runs) {
    if (r.kind !== kind || r.status !== 'done') continue
    const uncovered = new Set(r.uncovered)
    for (const id of r.entryIds) if (!uncovered.has(id)) covered.add(id)
  }
  return covered
}
