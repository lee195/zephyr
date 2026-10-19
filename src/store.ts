import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Entry, Session, View, ViewFormat } from './domain'

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

  async loadEntries(): Promise<Entry[]> {
    const text = await readText(this.entriesPath)
    if (!text) return []
    const out: Entry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A crash mid-append can leave a torn last line; the entry is re-read from its transcript.
      }
    }
    return out
  }

  async appendEntries(entries: Entry[]) {
    if (entries.length === 0) return
    await appendFile(this.entriesPath, entries.map((e) => JSON.stringify(e) + '\n').join(''))
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

  async writeView(view: View) {
    const dir = this.viewDir(view.kind)
    await mkdir(dir, { recursive: true })
    const { body, ...meta } = view
    await writeAtomic(join(dir, `${view.slug}.${EXT[view.format]}`), body)
    await writeAtomic(join(dir, `${view.slug}.json`), JSON.stringify(meta, null, 2))
  }
}
