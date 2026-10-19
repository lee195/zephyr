import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Entry, Run, Session, View, ViewFormat } from './domain'

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
    await appendFile(this.entriesPath, entries.map((e) => JSON.stringify(e) + '\n').join(''))
  }

  /** Every finished run, oldest first; null when the data dir predates runs.jsonl. */
  async loadRuns(): Promise<Run[] | null> {
    const text = await readText(this.runsPath)
    return text === null ? null : parseJsonl<Run>(text)
  }

  async appendRun(run: Run) {
    await appendFile(this.runsPath, JSON.stringify(run) + '\n')
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
    const dir = join(this.viewDir(view.kind), '.history', view.slug)
    await mkdir(dir, { recursive: true })
    await writeAtomic(join(dir, `${view.updatedAt}.${EXT[view.format]}`), view.body)
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
