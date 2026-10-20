import { expect, test } from 'bun:test'
import type { Adjustment, Entry, ModelBackend, Run, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { buildDigest, type Digest } from '../src/review'
import { serve } from '../src/server'
import { Store } from '../src/store'
import { Zephyr } from '../src/zephyr'
import { started } from './desk'
import { entry, scripted, seedDataDir, tempDir } from './helpers'

const at = (hhmm: string) => `2026-10-01T${hhmm}:00.000Z`
const SINCE = at('10:00')
const UNTIL = at('12:00')

const received = (id: string, hhmm: string): Entry => ({ ...entry(id, `note ${id}`, at(hhmm)), receivedAt: at(hhmm) })

const ENTRIES: Entry[] = [
  received('old1', '09:00'),
  entry('legacy', 'stored before receivedAt existed', at('08:00')),
  received('n1', '10:30'),
  received('n2', '10:40'),
  received('n3', '10:50'),
  received('n4', '11:00'),
  received('late', '12:30'),
]

const topic = (slug: string, title: string, sources: string[], extra: Partial<View> = {}): View => ({
  id: `organizer/${slug}`,
  kind: 'organizer',
  slug,
  title,
  sources,
  format: 'md',
  body: `about ${slug}`,
  updatedAt: at('11:50'),
  ...extra,
})

const VIEWS: View[] = [
  topic('garden', 'Garden', ['old1', 'n1', 'n2'], {
    createdAt: at('09:30'),
    pastTitles: [
      { title: 'Yard', until: at('09:45') },
      { title: 'Plants', until: at('11:15') },
    ],
  }),
  topic('trip', 'Trip', ['n2'], {
    createdAt: at('10:35'),
    pastTitles: [
      { title: 'Travel', until: at('10:37') },
      { title: 'Holiday', until: at('11:10') },
    ],
  }),
  topic('legacy', 'Legacy', ['legacy']),
  { id: 'visualizer/garden', kind: 'visualizer', slug: 'garden', title: 'Garden diagram', sources: ['n1'], format: 'svg', body: '<svg/>', updatedAt: at('11:20'), createdAt: at('10:45') },
  {
    id: 'tasks/tasks',
    kind: 'tasks',
    slug: 'tasks',
    title: 'Tasks',
    sources: ['old1', 'n1'],
    format: 'md',
    body: '',
    updatedAt: at('11:00'),
    tasks: [
      { id: 't1', text: 'Buy seeds', due: '2026-10-25', done: false, sources: ['n1'] },
      { id: 't2', text: 'Water the lawn', done: true, sources: ['old1'] },
    ],
  },
  {
    id: 'map/contents',
    kind: 'map',
    slug: 'contents',
    title: 'Map',
    sources: [],
    format: 'md',
    body: '',
    updatedAt: at('11:20'),
    areas: [
      { slug: 'home', title: 'Home', topics: [{ slug: 'garden', title: 'Garden' }], createdAt: at('09:00') },
      { slug: 'travel', title: 'Travel', topics: [{ slug: 'trip', title: 'Trip' }], createdAt: at('10:40') },
      { slug: 'mine', title: 'Mine', topics: [{ slug: 'legacy', title: 'Legacy' }] },
    ],
  },
]

const run = (id: string, kind: string, fields: Partial<Run>): Run => ({ id, kind, entryIds: [], status: 'done', attempt: 1, ...fields })

/** Finished runs as runs.jsonl holds them, oldest first. */
const RUNS: Run[] = [
  run('org-n1-failed', 'organizer', { entryIds: ['n1'], status: 'failed', error: 'timeout', endedAt: at('10:31') }),
  run('org-batch', 'organizer', { entryIds: ['n1', 'n2', 'n3'], uncovered: ['n3'], endedAt: at('10:51') }),
  run('org-n4', 'organizer', { entryIds: ['n4'], status: 'failed', error: 'invalid reply: reply has no ops array', endedAt: at('11:01') }),
  run('tasks-all', 'tasks', { entryIds: ['n1', 'n2', 'n3', 'n4'], endedAt: at('11:02') }),
  run('rewrite-before', 'organizer', { viewIds: ['organizer/garden'], endedAt: at('09:50') }),
  run('rewrite-garden', 'organizer', { viewIds: ['organizer/garden'], endedAt: at('11:30') }),
  run('diagram-garden', 'visualizer', { viewIds: ['organizer/garden'], endedAt: at('11:40') }),
]

const UNFILED: Digest['unfiled'] = [
  { noteId: 'n3', kind: 'organizer', reason: 'uncovered' },
  { noteId: 'n4', kind: 'organizer', reason: 'failed', error: 'invalid reply: reply has no ops array' },
]

test('the digest covers exactly the notes received in the window and what was written about them', () => {
  expect(buildDigest(ENTRIES, VIEWS, RUNS, SINCE, UNTIL, [])).toEqual({
    since: SINCE,
    until: UNTIL,
    notes: { count: 4, ids: ['n1', 'n2', 'n3', 'n4'] },
    newTopics: [{ slug: 'trip', title: 'Trip' }],
    newSpaces: [{ slug: 'travel', title: 'Travel', topics: ['trip'] }],
    topics: [
      { slug: 'garden', title: 'Garden', noteIds: ['n1', 'n2'] },
      { slug: 'trip', title: 'Trip', noteIds: ['n2'] },
    ],
    sharedNotes: [{ noteId: 'n2', slugs: ['garden', 'trip'] }],
    renames: [
      { slug: 'trip', from: 'Travel', to: 'Holiday', at: at('10:37') },
      { slug: 'trip', from: 'Holiday', to: 'Trip', at: at('11:10') },
      { slug: 'garden', from: 'Plants', to: 'Garden', at: at('11:15') },
    ],
    tasks: [{ id: 't1', text: 'Buy seeds', done: false, due: '2026-10-25', noteIds: ['n1'] }],
    unfiled: UNFILED,
    rewrites: [{ slug: 'garden', at: at('11:30') }],
    questions: [],
  })
})

test('before the first review, notes and topics from before the timestamps were recorded are in the window', () => {
  const d = buildDigest(ENTRIES, VIEWS, [], null, UNTIL, [])
  expect(d.notes.ids).toEqual(['old1', 'legacy', 'n1', 'n2', 'n3', 'n4'])
  expect(d.newTopics.map((t) => t.slug)).toEqual(['garden', 'legacy', 'trip'])
  expect(d.renames.map((r) => r.from)).toEqual(['Yard', 'Travel', 'Holiday', 'Plants'])
})

/** Never answers, so the runs a start queues stay in flight and runs.jsonl keeps only what the test wrote. */
const silent: ModelBackend = { complete: () => new Promise(() => {}) }

test('a started server builds the digest from runs.jsonl, beyond the runs it keeps in memory', async () => {
  const filler = Array.from({ length: 60 }, (_, i) => run(`filler-${i}`, 'tasks', { entryIds: ['old1'], endedAt: at('11:45') }))
  const dir = await seedDataDir({ entries: ENTRIES, runs: [...RUNS, ...filler], views: VIEWS })
  await new Store(dir).saveReviewCursor(SINCE)
  const z = new Zephyr({ dataDir: dir, backend: silent })
  await z.start()
  try {
    expect(z.listRuns().some((r) => r.id === 'org-batch')).toBe(false)
    const d = await z.review()
    expect(d.since).toBe(SINCE)
    expect(d.notes.ids).toEqual(['n1', 'n2', 'n3', 'n4', 'late'])
    expect(d.unfiled).toEqual(UNFILED)
  } finally {
    z.stop()
  }
})

/** Only the organizer runs, so a scripted reply always reaches it. */
async function running(backend: ModelBackend = scripted({ ops: [] }).backend) {
  const z = new Zephyr({ dataDir: await tempDir(), backend, kinds: { organizer: kinds.organizer! }, retryDelaysMs: [] })
  await z.start()
  const server = serve(z, { port: 0, distDir: await tempDir() })
  const base = `http://127.0.0.1:${server.port}`
  const digest = async () => (await (await fetch(`${base}/api/review`)).json()) as Digest
  const done = (until: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(`${base}/api/review/done`, { method: 'POST', headers, body: JSON.stringify({ until }) })
  const close = async () => {
    server.stop(true)
    z.stop()
    await z.idle()
  }
  return { z, base, digest, done, close }
}

test('done advances the cursor, the next digest is empty, and a restart keeps the cursor', async () => {
  const s = await running()
  try {
    await s.z.ingest([entry('a'), entry('b')])
    const first = await s.digest()
    expect(first.since).toBeNull()
    expect(first.notes).toEqual({ count: 2, ids: ['a', 'b'] })
    expect(await (await s.done(first.until)).json()).toEqual({ ok: true, lastReviewedAt: first.until })

    const next = await s.digest()
    expect(next.since).toBe(first.until)
    expect({ ...next, since: null, until: null }).toEqual({
      since: null,
      until: null,
      notes: { count: 0, ids: [] },
      newTopics: [],
      newSpaces: [],
      topics: [],
      sharedNotes: [],
      renames: [],
      tasks: [],
      unfiled: [],
      rewrites: [],
      questions: [],
    })

    const restarted = new Zephyr({ dataDir: s.z.store.dir, backend: silent })
    await restarted.start()
    expect((await restarted.review()).since).toBe(first.until)
    restarted.stop()
  } finally {
    await s.close()
  }
})

test('a topic is new in the review after its first write, and not after a later write to it', async () => {
  const write = (id: string) => ({ ops: [{ op: 'write', slug: 'garden', title: 'Garden', sources: [id], body: `about ${id}` }] })
  const s = await running(scripted(write('a'), write('b')).backend)
  try {
    await s.z.ingest([entry('a')])
    await s.z.idle()
    const first = await s.digest()
    expect(first.newTopics).toEqual([{ slug: 'garden', title: 'Garden' }])
    await s.done(first.until)

    await s.z.ingest([entry('b')])
    await s.z.idle()
    const next = await s.digest()
    expect(next.topics).toEqual([{ slug: 'garden', title: 'Garden', noteIds: ['b'] }])
    expect(next.newTopics).toEqual([])
  } finally {
    await s.close()
  }
})

test('a note received between reading the digest and finishing the review is in the next digest', async () => {
  const s = await running()
  try {
    await s.z.ingest([entry('a')])
    const read = await s.digest()
    await s.z.ingest([entry('mid-review')])
    expect((await s.done(read.until)).status).toBe(200)
    expect((await s.digest()).notes.ids).toEqual(['mid-review'])
  } finally {
    await s.close()
  }
})

test('done refuses an until in the future, before the cursor, or not a timestamp, and the cursor stays', async () => {
  const s = await running()
  try {
    const earlier = (await s.digest()).until
    const later = (await s.digest()).until
    expect((await s.done(later)).status).toBe(200)

    const future = new Date(Date.now() + 3_600_000).toISOString()
    for (const [until, error] of [
      [future, 'until is in the future'],
      [earlier, 'until is before the last review'],
      ['yesterday', 'until must be an ISO timestamp as GET /api/review returns it'],
      [undefined, 'until must be an ISO timestamp as GET /api/review returns it'],
    ] as const) {
      const res = await s.done(until)
      expect([res.status, await res.json()]).toEqual([400, { ok: false, error }])
    }
    expect((await s.digest()).since).toBe(later)
    expect((await s.done(later)).status).toBe(200)
  } finally {
    await s.close()
  }
})

test('every mutating route refuses a foreign Origin, another local port included, with 403 and a non-JSON body with 415; its own, the viewer dev and absent Origins pass', async () => {
  const s = await running()
  try {
    const { until } = await s.digest()
    const json = { 'content-type': 'application/json' }
    const post = (path: string, headers: Record<string, string>, body: unknown) =>
      fetch(`${s.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    for (const [path, body, passed] of [
      ['/api/review/done', { until }, 200],
      ['/sessions', {}, 400],
      ['/api/adjustments', { op: 'renameTopic', slug: 'nowhere', title: 'X' }, 409],
      ['/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rename_topic', arguments: { slug: 'nowhere', title: 'X' } } }, 200],
    ] as const) {
      expect((await post(path, { ...json, origin: 'http://evil.example' }, body)).status).toBe(403)
      expect((await post(path, { ...json, origin: 'http://127.0.0.1.evil.example:7317' }, body)).status).toBe(403)
      expect((await post(path, { ...json, origin: 'http://127.0.0.1:8080' }, body)).status).toBe(403)
      expect((await post(path, { ...json, origin: 'http://localhost' }, body)).status).toBe(403)
      expect((await post(path, { 'content-type': 'text/plain' }, body)).status).toBe(415)
      expect((await post(path, {}, body)).status).toBe(415)
      expect((await post(path, json, body)).status).toBe(passed)
      expect((await post(path, { ...json, origin: s.base }, body)).status).toBe(passed)
      expect((await post(path, { 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:5173' }, body)).status).toBe(passed)
    }
  } finally {
    await s.close()
  }
})

test('POST /api/adjustments answers 200 with the result, 400 for a malformed op, 409 when the data refuses it', async () => {
  const write = { ops: [{ op: 'write', slug: 'garden', title: 'Garden', sources: ['a'], body: 'about a' }] }
  const s = await running(scripted(write).backend)
  try {
    await s.z.ingest([entry('a')])
    await s.z.idle()
    const post = (body: unknown) => fetch(`${s.base}/api/adjustments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const renamed = await post({ op: 'renameTopic', slug: 'garden', title: 'Vegetable garden' })
    expect([renamed.status, await renamed.json()]).toEqual([200, { id: expect.any(String), ok: true, written: ['organizer/garden'], deleted: [], rewrites: [], warnings: [] }])
    expect(s.z.listViews()[0]!.title).toBe('Vegetable garden')

    const malformed = await post({ op: 'renameTopic', slug: 'garden' })
    expect([malformed.status, await malformed.json()]).toEqual([400, { ok: false, error: 'renameTopic needs non-empty strings: title' }])
    expect((await post({ op: 'shred' })).status).toBe(400)

    const refused = await post({ op: 'mergeTopics', from: 'garden', into: 'nowhere' })
    expect([refused.status, await refused.json()]).toEqual([409, { id: expect.any(String), ok: false, error: 'no topic nowhere' }])
    const tasks = await post({ op: 'completeTask', taskId: 't1' })
    expect([tasks.status, (await tasks.json()).error]).toEqual([409, 'no tasks kind runs on this server'])
  } finally {
    await s.close()
  }
})

test("the next digest leaves out the person's own renames and split topics, and marks the rewrites their changes forced as yours", async () => {
  const s = await started({ kinds: { organizer: kinds.organizer! } })
  try {
    await s.note('party: venue', 'party: cake', 'party: budget', 'garden: beans', 'garden: peas')
    const reviewed = await s.z.review()
    for (const a of [
      { op: 'renameTopic', slug: 'party', title: 'Summer Party' },
      { op: 'splitTopic', slug: 'party', noteIds: ['e3'], into: { slug: 'party-budget', title: 'Party budget' } },
      { op: 'moveNote', noteId: 'e2', from: 'party', to: 'garden' },
    ] satisfies Adjustment[])
      expect((await s.adjust(a)).ok).toBe(true)
    expect((await s.z.finishReview(reviewed.until)).ok).toBe(true)

    await s.note('garden: tomatoes => Vegetables')
    for (const x of ['a', 'b', 'c', 'd', 'e', 'f']) await s.note(`trip: ${x}`)
    await s.z.sweep()
    await s.z.idle()
    const next = await s.z.review()
    expect(next.newTopics).toEqual([{ slug: 'trip', title: 'TRIP' }])
    expect(next.renames.map(({ at, ...r }) => r)).toEqual([{ slug: 'garden', from: 'GARDEN', to: 'Vegetables' }])
    expect(next.rewrites.map(({ at, ...r }) => r)).toEqual([
      { slug: 'party', yours: true },
      { slug: 'party-budget', yours: true },
      { slug: 'party', yours: true },
      { slug: 'garden', yours: true },
      { slug: 'trip' },
    ])
  } finally {
    s.z.stop()
  }
})
