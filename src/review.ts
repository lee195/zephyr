import type { Entry, EntryId, Run, Task, TaskId, View } from './domain'

const TOPIC_KIND = 'organizer'
const TASKS_ID = 'tasks/tasks'

export interface TopicRef {
  slug: string
  title: string
}

/**
 * What happened between two reviews, computed from the data dir on request and never stored. Every list is about
 * the notes received in the window (`since`, `until`], or about writes made in it.
 */
export interface Digest {
  /** Exclusive. null when nothing was ever reviewed, so the window holds every note. */
  since: string | null
  /** Inclusive. The value `POST /api/review/done` takes to close exactly this window. */
  until: string
  notes: { count: number; ids: EntryId[] }
  /** Topics whose first write fell in the window. */
  newTopics: TopicRef[]
  /** Each topic that cites a note of the window, with those notes. */
  topics: (TopicRef & { noteIds: EntryId[] })[]
  /** Notes of the window that two or more topics cite. */
  sharedNotes: { noteId: EntryId; slugs: string[] }[]
  renames: { slug: string; from: string; to: string; at: string }[]
  /** Tasks citing a note of the window; tasks carry no time of their own. */
  tasks: { id: TaskId; text: string; done: boolean; due?: string; noteIds: EntryId[] }[]
  /** Notes of the window that a kind has not filed: its last finished run on them failed or left them uncovered. */
  unfiled: { noteId: EntryId; kind: string; reason: 'failed' | 'uncovered'; error?: string }[]
  /** Topics a rewrite run rewrote in the window. */
  rewrites: { slug: string; at: string }[]
}

/**
 * Whether a server timestamp falls in the window. A record from before that timestamp was kept predates this
 * feature, so it predates every review and is in the window only while nothing has been reviewed.
 */
const inWindow = (at: string | undefined, since: string | null, until: string) =>
  at === undefined ? since === null : (since === null || at > since) && at <= until

const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug)
const byAt = (a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at)

/** Per kind, each note of `ids` that no done run of the kind covered, with the outcome of the last finished run on it. */
function unfiledIn(runs: readonly Run[], ids: ReadonlySet<EntryId>): Map<string, Digest['unfiled'][number]> {
  const covered = new Set<string>()
  const last = new Map<string, Digest['unfiled'][number]>()
  for (const r of runs) {
    if (r.status !== 'done' && r.status !== 'failed') continue
    const uncovered = new Set(r.uncovered)
    for (const noteId of r.entryIds) {
      if (!ids.has(noteId)) continue
      const key = `${r.kind} ${noteId}`
      if (r.status === 'failed') last.set(key, { noteId, kind: r.kind, reason: 'failed', ...(r.error && { error: r.error }) })
      else if (uncovered.has(noteId)) last.set(key, { noteId, kind: r.kind, reason: 'uncovered' })
      else covered.add(key)
    }
  }
  for (const key of covered) last.delete(key)
  return last
}

/** `runs` are every finished run, oldest first, as runs.jsonl holds them. */
export function buildDigest(entries: readonly Entry[], views: readonly View[], runs: readonly Run[], since: string | null, until: string): Digest {
  const notes = entries.filter((e) => inWindow(e.receivedAt, since, until)).map((e) => e.id)
  const inNotes = new Set(notes)
  const order = new Map(notes.map((id, i) => [id, i]))
  const topicViews = views.filter((v) => v.kind === TOPIC_KIND).sort(bySlug)
  const ref = (v: View): TopicRef => ({ slug: v.slug, title: v.title })

  const topics = topicViews.flatMap((v) => {
    const noteIds = v.sources.filter((id) => inNotes.has(id))
    return noteIds.length > 0 ? [{ ...ref(v), noteIds }] : []
  })

  const citing = new Map<EntryId, string[]>()
  for (const t of topics) for (const id of t.noteIds) citing.set(id, [...(citing.get(id) ?? []), t.slug])
  const sharedNotes = notes.flatMap((noteId) => {
    const slugs = citing.get(noteId) ?? []
    return slugs.length >= 2 ? [{ noteId, slugs }] : []
  })

  const renames = topicViews
    .flatMap((v) => {
      const past = v.pastTitles ?? []
      return past.map((p, i) => ({ slug: v.slug, from: p.title, to: past[i + 1]?.title ?? v.title, at: p.until }))
    })
    .filter((r) => inWindow(r.at, since, until))
    .sort(byAt)

  const taskList: Task[] = views.find((v) => v.id === TASKS_ID)?.tasks ?? []
  const tasks = taskList.flatMap((t) => {
    const noteIds = t.sources.filter((id) => inNotes.has(id))
    return noteIds.length > 0 ? [{ id: t.id, text: t.text, done: t.done, ...(t.due && { due: t.due }), noteIds }] : []
  })

  const unfiled = [...unfiledIn(runs, inNotes).values()].sort(
    (a, b) => order.get(a.noteId)! - order.get(b.noteId)! || a.kind.localeCompare(b.kind),
  )

  const ownView = `${TOPIC_KIND}/`
  const rewrites = runs
    .filter((r) => r.kind === TOPIC_KIND && r.status === 'done' && r.viewIds?.[0]?.startsWith(ownView) && inWindow(r.endedAt, since, until))
    .map((r) => ({ slug: r.viewIds![0]!.slice(ownView.length), at: r.endedAt! }))
    .sort(byAt)

  return {
    since,
    until,
    notes: { count: notes.length, ids: notes },
    newTopics: topicViews.filter((v) => inWindow(v.createdAt, since, until)).map(ref),
    topics,
    sharedNotes,
    renames,
    tasks,
    unfiled,
    rewrites,
  }
}

export type WindowClose = { ok: true; until: string } | { ok: false; error: string }

/**
 * Checks the `until` a finished review sends. It must be a time this server could have handed out: canonical ISO,
 * not after `now`, and not before the current cursor. Equal to the cursor closes nothing new and is accepted.
 */
export function closeWindow(until: unknown, cursor: string | null, now: string): WindowClose {
  if (typeof until !== 'string' || Number.isNaN(Date.parse(until)) || new Date(until).toISOString() !== until)
    return { ok: false, error: 'until must be an ISO timestamp as GET /api/review returns it' }
  if (until > now) return { ok: false, error: 'until is in the future' }
  if (cursor !== null && until < cursor) return { ok: false, error: 'until is before the last review' }
  return { ok: true, until }
}
