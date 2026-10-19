import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdjustmentLine, Entry, Run, Session, View, ViewFormat } from './domain'

const EXT: Record<ViewFormat, string> = { md: 'md', svg: 'svg', ascii: 'txt' }

let tmpSeq = 0
async function writeAtomic(path: string, data: string) {
  const tmp = `${path}.tmp-${process.pid}-${tmpSeq++}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function parseJsonl<T>(text: string | null): T[] {
  const out: T[] = []
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A crash mid-append can leave a torn last line. A lost entry is re-read from its transcript, a lost run re-runs.
    }
  }
  return out
}

/** Plain-file persistence under one data dir. The server is its only writer. */
export class Store {
  constructor(readonly dir: string) {}

  /** Per jsonl file, the tail of its exclusive section. */
  private sections = new Map<string, Promise<unknown>>()

  /** One file's exclusive section: an append and a rewrite of the same file never overlap, so no append is lost. */
  private exclusive<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.sections.get(path) ?? Promise.resolve()).then(fn)
    this.sections.set(path, run.catch(() => {}))
    return run
  }

  private appendLines(path: string, records: unknown[]) {
    return this.exclusive(path, () => appendFile(path, records.map((r) => JSON.stringify(r) + '\n').join('')))
  }

  /**
   * Rewrites a jsonl file record by record, through a tmp file and a rename, inside its exclusive section. edit
   * returns the record, a changed copy, or null to drop it. Writes nothing when nothing changed, so a repeat is a
   * no-op. Returns how many records changed or were dropped.
   */
  private rewriteLines<T>(path: string, edit: (record: T) => T | null): Promise<number> {
    return this.exclusive(path, async () => {
      const text = await readText(path)
      if (text === null) return 0
      let changed = 0
      const out: string[] = []
      for (const record of parseJsonl<T>(text)) {
        const next = edit(record)
        const line = next === null ? null : JSON.stringify(next)
        if (line !== JSON.stringify(record)) changed++
        if (line !== null) out.push(line + '\n')
      }
      if (changed > 0) await writeAtomic(path, out.join(''))
      return changed
    })
  }

  private get entriesPath() {
    return join(this.dir, 'entries.jsonl')
  }
  private get sessionsPath() {
    return join(this.dir, 'sessions.json')
  }
  private viewDir(kind: string) {
    return join(this.dir, 'views', kind)
  }

  async init() {
    await mkdir(join(this.dir, 'views'), { recursive: true })
  }

  private get runsPath() {
    return join(this.dir, 'runs.jsonl')
  }

  async loadEntries(): Promise<Entry[]> {
    return parseJsonl<Entry>(await readText(this.entriesPath))
  }

  async appendEntries(entries: Entry[]) {
    if (entries.length === 0) return
    await this.appendLines(this.entriesPath, entries)
  }

  rewriteEntries(edit: (e: Entry) => Entry | null) {
    return this.rewriteLines(this.entriesPath, edit)
  }

  private get purgedPath() {
    return join(this.dir, 'purged.json')
  }

  /** Ids of purged notes, never their text. */
  async loadPurged(): Promise<string[]> {
    const text = await readText(this.purgedPath)
    return text ? (JSON.parse(text) as { ids: string[] }).ids : []
  }

  async savePurged(ids: string[]) {
    await writeAtomic(this.purgedPath, JSON.stringify({ ids }, null, 2))
  }

  /** Every finished run, oldest first; null when the data dir predates runs.jsonl. */
  async loadRuns(): Promise<Run[] | null> {
    const text = await readText(this.runsPath)
    return text === null ? null : parseJsonl<Run>(text)
  }

  async appendRun(run: Run) {
    await this.appendLines(this.runsPath, [run])
  }

  rewriteRuns(edit: (r: Run) => Run | null) {
    return this.rewriteLines(this.runsPath, edit)
  }

  private get reviewPath() {
    return join(this.dir, 'review.json')
  }

  /** When the last review finished; null when there was none. */
  async loadReviewCursor(): Promise<string | null> {
    const text = await readText(this.reviewPath)
    return text ? (JSON.parse(text) as { lastReviewedAt: string }).lastReviewedAt : null
  }

  async saveReviewCursor(lastReviewedAt: string) {
    await writeAtomic(this.reviewPath, JSON.stringify({ lastReviewedAt }, null, 2))
  }

  async loadSessions(): Promise<Session[]> {
    const text = await readText(this.sessionsPath)
    return text ? JSON.parse(text) : []
  }

  async saveSessions(sessions: Session[]) {
    await writeAtomic(this.sessionsPath, JSON.stringify(sessions, null, 2))
  }

  async loadViews(): Promise<View[]> {
    const root = join(this.dir, 'views')
    const views: View[] = []
    for (const kind of await readdir(root).catch(() => [] as string[])) {
      const dir = this.viewDir(kind)
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.json')) continue
        const meta = JSON.parse(await readFile(join(dir, name), 'utf8')) as Omit<View, 'body'>
        const body = await readText(join(dir, `${meta.slug}.${EXT[meta.format]}`))
        if (body !== null) views.push({ ...meta, body })
      }
    }
    return views
  }

  /** The view as it is now, kept as views/<kind>/.history/<slug>/<updatedAt>.<ext>; loadViews never reads it back. */
  async archiveView(view: View) {
    const dir = this.historyDir(view)
    await mkdir(dir, { recursive: true })
    await writeAtomic(join(dir, `${view.updatedAt}.${EXT[view.format]}`), view.body)
  }

  /** Metadata first: loadViews reads a view only through it, so a crash between the two leaves no half view. */
  async deleteView(view: View) {
    const dir = this.viewDir(view.kind)
    await rm(join(dir, `${view.slug}.json`), { force: true })
    for (const ext of Object.values(EXT)) await rm(join(dir, `${view.slug}.${ext}`), { force: true })
  }

  private get adjustmentsPath() {
    return join(this.dir, 'adjustments.jsonl')
  }

  async loadAdjustments(): Promise<AdjustmentLine[]> {
    return parseJsonl<AdjustmentLine>(await readText(this.adjustmentsPath))
  }

  async appendAdjustment(line: AdjustmentLine) {
    await this.appendLines(this.adjustmentsPath, [line])
  }

  rewriteAdjustments(edit: (l: AdjustmentLine) => AdjustmentLine | null) {
    return this.rewriteLines(this.adjustmentsPath, edit)
  }

  private historyDir(view: Pick<View, 'kind' | 'slug'>) {
    return join(this.viewDir(view.kind), '.history', view.slug)
  }

  /** Deletes every archived body that holds matching text. Returns how many it deleted. */
  async deleteHistoryWhere(holds: (text: string) => boolean): Promise<number> {
    let deleted = 0
    for (const kind of await readdir(join(this.dir, 'views')).catch(() => [] as string[])) {
      const root = join(this.viewDir(kind), '.history')
      for (const slug of await readdir(root).catch(() => [] as string[])) {
        for (const name of await readdir(join(root, slug)).catch(() => [] as string[])) {
          const path = join(root, slug, name)
          // A tmp file can vanish under the read, renamed into place by an archive in flight; the next pass sees it.
          const text = await readText(path)
          if (text === null || !holds(text)) continue
          await rm(path, { force: true })
          deleted++
        }
      }
    }
    return deleted
  }

  /** Every archived version of the view. */
  async deleteHistory(view: Pick<View, 'kind' | 'slug'>) {
    await rm(this.historyDir(view), { recursive: true, force: true })
  }

  async writeView(view: View) {
    const dir = this.viewDir(view.kind)
    await mkdir(dir, { recursive: true })
    const { body, ...meta } = view
    await writeAtomic(join(dir, `${view.slug}.${EXT[view.format]}`), body)
    await writeAtomic(join(dir, `${view.slug}.json`), JSON.stringify(meta, null, 2))
    // A view that changed format, such as a diagram redrawn as ASCII, leaves no stale body behind.
    for (const ext of Object.values(EXT)) if (ext !== EXT[view.format]) await rm(join(dir, `${view.slug}.${ext}`), { force: true })
  }
}
