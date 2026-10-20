import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdjustmentLine, Entry, QuestionLine, Run, Session, View, ViewFormat } from './domain'
import type { PurgeScope } from './purge'

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

/** An ISO timestamp as views and summaries carry it; the only shape a version or summary name read from a request may take. */
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const VIEW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A kind and slug from a request name a folder under views/ and nothing else. */
const validViewName = (v: Pick<View, 'kind' | 'slug'>) => VIEW_NAME.test(v.kind) && VIEW_NAME.test(v.slug)

export interface ArchivedVersion {
  at: string
  format: ViewFormat
}

function parseArchivedName(name: string): ArchivedVersion | null {
  const dot = name.lastIndexOf('.')
  const at = name.slice(0, dot)
  const format = (Object.entries(EXT) as [ViewFormat, string][]).find(([, ext]) => ext === name.slice(dot + 1))?.[0]
  return format && ISO_AT.test(at) ? { at, format } : null
}

export interface SavedSummary {
  since: string | null
  until: string
  noteCount: number
}

function parseSummaryFile(text: string | null): { meta: SavedSummary; summary: string } | null {
  const m = text && /^---\nsince: (.*)\nuntil: (.*)\nnotes: (.*)\n---\n\n([\s\S]*)$/.exec(text)
  if (!m) return null
  let ids: unknown
  try {
    ids = JSON.parse(m[3]!)
  } catch {
    return null
  }
  return { meta: { since: m[1] === 'null' ? null : m[1]!, until: m[2]!, noteCount: Array.isArray(ids) ? ids.length : 0 }, summary: m[4]!.trimEnd() }
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

  private get purgeScopesPath() {
    return join(this.dir, 'purge-scopes.json')
  }

  /**
   * The scope of each purge in progress, by note id. A purge saves it before it scrubs anything, since scrubbing
   * removes the citations it is computed from, and a purge resumed after a crash must match as the first try did.
   */
  async loadPurgeScope(noteId: string): Promise<PurgeScope | null> {
    const text = await readText(this.purgeScopesPath)
    return text ? ((JSON.parse(text) as Record<string, PurgeScope>)[noteId] ?? null) : null
  }

  async savePurgeScope(noteId: string, scope: PurgeScope | null) {
    const text = await readText(this.purgeScopesPath)
    const { [noteId]: _, ...rest } = text ? (JSON.parse(text) as Record<string, PurgeScope>) : {}
    const next = scope ? { ...rest, [noteId]: scope } : rest
    if (Object.keys(next).length > 0) await writeAtomic(this.purgeScopesPath, JSON.stringify(next, null, 2))
    else await rm(this.purgeScopesPath, { force: true })
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
        let meta: Omit<View, 'body'>
        try {
          meta = JSON.parse(await readFile(join(dir, name), 'utf8'))
        } catch (err) {
          console.warn(`[zephyr] skipping view ${kind}/${name}: ${(err as Error).message}`)
          continue
        }
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

  private get questionsPath() {
    return join(this.dir, 'questions.jsonl')
  }

  async loadQuestions(): Promise<QuestionLine[]> {
    return parseJsonl<QuestionLine>(await readText(this.questionsPath))
  }

  async appendQuestions(lines: QuestionLine[]) {
    await this.appendLines(this.questionsPath, lines)
  }

  rewriteQuestions(edit: (l: QuestionLine) => QuestionLine | null) {
    return this.rewriteLines(this.questionsPath, edit)
  }

  private historyDir(view: Pick<View, 'kind' | 'slug'>) {
    return join(this.viewDir(view.kind), '.history', view.slug)
  }

  /** Deletes every archived body that holds matching text, given the view's kind and slug too. Returns how many it deleted. */
  async deleteHistoryWhere(holds: (text: string, kind: string, slug: string) => boolean): Promise<number> {
    let deleted = 0
    for (const kind of await readdir(join(this.dir, 'views')).catch(() => [] as string[])) {
      const root = join(this.viewDir(kind), '.history')
      for (const slug of await readdir(root).catch(() => [] as string[])) {
        for (const name of await readdir(join(root, slug)).catch(() => [] as string[])) {
          const path = join(root, slug, name)
          // A tmp file can vanish under the read, renamed into place by an archive in flight; the next pass sees it.
          const text = await readText(path)
          if (text === null || !holds(text, kind, slug)) continue
          await rm(path, { force: true })
          deleted++
        }
      }
    }
    return deleted
  }

  /** The archived versions of a view, newest first, by the updatedAt each was saved under; none for a name that is not one. */
  async listHistory(view: Pick<View, 'kind' | 'slug'>): Promise<ArchivedVersion[]> {
    if (!validViewName(view)) return []
    const versions: ArchivedVersion[] = []
    for (const name of await readdir(this.historyDir(view)).catch(() => [] as string[])) {
      const version = parseArchivedName(name)
      if (version) versions.push(version)
    }
    return versions.sort((a, b) => b.at.localeCompare(a.at))
  }

  /** One archived version's body, or null when there is none by that name. */
  async readHistory(view: Pick<View, 'kind' | 'slug'>, at: string): Promise<{ at: string; format: ViewFormat; body: string } | null> {
    if (!validViewName(view) || !ISO_AT.test(at)) return null
    for (const [format, ext] of Object.entries(EXT) as [ViewFormat, string][]) {
      const body = await readText(join(this.historyDir(view), `${at}.${ext}`))
      if (body !== null) return { at, format, body }
    }
    return null
  }

  /** Every archived version of the view. */
  async deleteHistory(view: Pick<View, 'kind' | 'slug'>) {
    await rm(this.historyDir(view), { recursive: true, force: true })
  }

  private get summariesDir() {
    return join(this.dir, 'summaries')
  }

  /**
   * Saves a review summary as markdown, with the window and the ids of the notes it summarized in its front matter,
   * keyed by the window's until, so saving the same window again replaces it. Returns its path.
   */
  async saveSummary(s: { since: string | null; until: string; noteIds: string[]; summary: string }): Promise<string> {
    await mkdir(this.summariesDir, { recursive: true })
    const path = join(this.summariesDir, `${s.until.replace(/:/g, '-')}.md`)
    const front = [`since: ${s.since ?? 'null'}`, `until: ${s.until}`, `notes: ${JSON.stringify(s.noteIds)}`]
    await writeAtomic(path, `---\n${front.join('\n')}\n---\n\n${s.summary}\n`)
    return path
  }

  /** The saved summaries, newest first, read from their front matter. */
  async listSummaries(): Promise<SavedSummary[]> {
    const out: SavedSummary[] = []
    for (const name of await readdir(this.summariesDir).catch(() => [] as string[])) {
      if (!name.endsWith('.md')) continue
      const parsed = parseSummaryFile(await readText(join(this.summariesDir, name)))
      if (parsed) out.push(parsed.meta)
    }
    return out.sort((a, b) => b.until.localeCompare(a.until))
  }

  /** One saved summary by its window's until, or null when there is none. */
  async readSummary(until: string): Promise<(SavedSummary & { summary: string }) | null> {
    if (!ISO_AT.test(until)) return null
    const parsed = parseSummaryFile(await readText(join(this.summariesDir, `${until.replace(/:/g, '-')}.md`)))
    return parsed && parsed.meta.until === until ? { ...parsed.meta, summary: parsed.summary } : null
  }

  /** Deletes every saved summary for which `drop` holds, given the note ids it summarized and its text. Returns how many. */
  async deleteSummariesWhere(drop: (noteIds: string[], text: string) => boolean): Promise<number> {
    let deleted = 0
    for (const name of await readdir(this.summariesDir).catch(() => [] as string[])) {
      const path = join(this.summariesDir, name)
      const text = await readText(path)
      if (text === null) continue
      const ids = /^notes: (.*)$/m.exec(text)?.[1]
      if (!drop(ids ? JSON.parse(ids) : [], text)) continue
      await rm(path, { force: true })
      deleted++
    }
    return deleted
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
