import { Database } from 'bun:sqlite'
import { appendFile, copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { parseAdjustment } from '../src/adjust'
import type { AdjustmentResult } from '../src/domain'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { ALL, started } from './desk'
import { Store } from '../src/store'
import { entry, eventually, filesUnder, scripted, tempDir } from './helpers'

const SECRET = 'ZEPHYR-TEST-SECRET-7Q4X'
const EDITED = 'EDITED-PASS-9Z3K'
/**
 * e4: filed on party, retitles it, makes a task, and raises a question, so its words reach a body, a title, a diagram
 * and the task list. e2 raises a question too, which a purge of e4 leaves open.
 */
const NOTES = ['party: venue', 'party: cake ask:garden', 'party: music', `party: wifi ${SECRET} todo rotate it ask:garden => Party ${SECRET}`, 'garden: beans']

/** Every file under dir whose text contains any of words, ignoring case, as `rg -i` would list them. */
async function filesHolding(dir: string, words: string[]): Promise<string[]> {
  const out: string[] = []
  for (const name of await readdir(dir, { recursive: true })) {
    const path = join(dir, name)
    if (!(await stat(path)).isFile()) continue
    const text = (await readFile(path, 'utf8')).toLowerCase()
    if (words.some((w) => text.includes(w.toLowerCase()))) out.push(name)
  }
  return out.sort()
}

/**
 * The secret note, spread as far as the desk spreads it: on party's body and title, its diagram, a task, an edit in
 * adjustments.jsonl, a past title, and archived bodies under .history from a move and an edit.
 */
async function spread() {
  const s = await started()
  await s.note(...NOTES)
  expect(s.z.listQuestions().map((q) => q.note.id)).toEqual(['e2', 'e4'])
  expect(await s.adjust({ op: 'moveNote', noteId: 'e1', from: 'party', to: 'garden' })).toMatchObject({ ok: true })
  expect(await s.adjust({ op: 'editNote', noteId: 'e4', text: `party: wifi ${EDITED} todo rotate it` })).toMatchObject({ ok: true })
  expect(await s.adjust({ op: 'renameTopic', slug: 'party', title: 'Summer Party' })).toMatchObject({ ok: true })
  await s.note('party: lights')
  expect(await filesHolding(s.dir, [SECRET])).toEqual(
    expect.arrayContaining(['entries.jsonl', 'views/organizer/party.json', 'views/tasks/tasks.md', 'views/tasks/tasks.json', expect.stringMatching(/^views\/organizer\/\.history\/party\//)]),
  )
  expect(await filesHolding(s.dir, [EDITED])).toEqual(expect.arrayContaining(['adjustments.jsonl', 'views/organizer/party.md']))
  expect((await filesHolding(s.dir, [SECRET])).some((f) => f.startsWith('views/visualizer/'))).toBe(true)
  return s
}

const purge = (noteId: string) => ({ op: 'purgeNote', noteId, confirm: `purge ${noteId}` }) as const

test('a purge leaves no trace of the note under the data dir once its rewrites finish, and the rest stands', async () => {
  const s = await spread()
  s.d.hold('rewrite')
  const result = await s.z.adjust(purge('e4'))
  expect(result).toMatchObject({
    ok: true,
    rewrites: ['organizer/party'],
    purge: { noteId: 'e4', tasksDeleted: ['t1'], lines: { entries: 1 }, stillIn: expect.stringContaining('claude-code transcript of session s') },
  })
  expect((result as any).purge.lines.adjustments).toBeGreaterThan(0)
  expect((result as any).purge.historyFilesDeleted).toBeGreaterThan(0)
  expect((result as any).purge.lines.questions).toBe(1)
  expect(s.z.listQuestions().map((q) => q.note.id)).toEqual(['e2'])
  expect(await readFile(join(s.dir, 'questions.jsonl'), 'utf8')).not.toContain('"e4"')
  expect(await s.z.purgeStatus('e4')).toEqual({ noteId: 'e4', done: false, scrubbing: false, pending: ['organizer/party'] })
  expect(await filesHolding(s.dir, [SECRET, EDITED, '7Q4X'])).toEqual([])

  s.d.release()
  await s.z.idle()
  expect(await s.z.purgeStatus('e4')).toEqual({ noteId: 'e4', done: true, scrubbing: false, pending: [] })
  expect(await filesHolding(s.dir, [SECRET, EDITED, '7Q4X', 'wifi'])).toEqual([])
  expect(s.d.sent.rewrite.at(-1)).toMatchObject({ slug: 'party', notes: [{ id: 'e2' }, { id: 'e3' }, { id: 'e6' }] })
  expect(JSON.stringify(s.d.sent.rewrite.at(-1))).not.toContain('7Q4X')
  expect(s.z.listEntries().map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e5', 'e6'])
  expect(s.view('organizer/party')).toMatchObject({ title: 'Summer Party', sources: ['e2', 'e3', 'e6'] })
  expect(s.view('organizer/garden')!.sources).toEqual(['e1', 'e5'])
  expect(s.view('tasks/tasks')!.tasks).toEqual([])
  expect(JSON.parse(await readFile(join(s.dir, 'purged.json'), 'utf8'))).toEqual({ ids: ['e4'] })
  s.z.stop()
})

test('purging again converges: nothing left to change, and the result says so', async () => {
  const s = await started({ kinds: { organizer: ALL.organizer } })
  await s.note('party: venue', `party: ${SECRET}`)
  expect(await s.adjust(purge('e2'))).toMatchObject({ ok: true, written: ['organizer/party'] })
  expect(await s.adjust(purge('e2'))).toMatchObject({ ok: true, written: [], deleted: [], rewrites: [], purge: { lines: { entries: 0, adjustments: 0, runs: 0 }, historyFilesDeleted: 0 } })
  expect(await s.adjust(purge('nope'))).toMatchObject({ ok: false, error: 'no note nope' })
  s.z.stop()
})

test('a purge a crash cut short finishes on the next start, from whichever step it stopped at', async () => {
  for (const failing of ['writeView', 'rewriteAdjustments', 'rewriteEntries'] as const) {
    const s = await spread()
    const store = s.z.store as any
    store[failing] = async () => {
      throw new Error('disk gone')
    }
    expect(await s.z.adjust(purge('e4'))).toMatchObject({ ok: false, pending: true, error: 'disk gone', retryInMs: null })
    await s.z.idle()
    // A tasks run cut short by the stop, so the restart files e7 again, against the open tasks.
    s.d.hold('tasks')
    await s.z.ingest([entry('e7', 'party: balloons')])
    await eventually(() => s.d.calls.includes('tasks e7'))
    s.z.stop()
    expect(JSON.parse(await readFile(join(s.dir, 'purged.json'), 'utf8'))).toEqual({ ids: ['e4'] })

    const restarted = await started({ dir: s.dir })
    expect(restarted.d.calls).toContain('tasks e7')
    expect(JSON.stringify(restarted.d.sent)).not.toContain('7Q4X')
    expect(restarted.z.listEntries().map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e5', 'e6', 'e7'])
    expect(await filesHolding(s.dir, [SECRET, EDITED, '7Q4X'])).toEqual([])
    const lines = (await readFile(join(s.dir, 'adjustments.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    const request = lines.find((l) => l.type === 'request' && l.adjustment.op === 'purgeNote')
    expect(lines.filter((l) => l.type === 'result' && l.id === request.id)).toMatchObject([{ result: { ok: true } }])
    expect(await restarted.z.purgeStatus('e4')).toMatchObject({ done: true })
    restarted.z.stop()

    const third = await started({ dir: s.dir })
    expect(third.d.calls).toEqual([])
    third.z.stop()
  }
})

test('the confirmation must be exactly "purge <noteId>"; anything else is refused before anything changes', async () => {
  for (const confirm of [true, 'yes', 'purge', 'purge e2', 'PURGE e1', ' purge e1']) {
    expect(parseAdjustment({ op: 'purgeNote', noteId: 'e1', confirm })).toEqual({
      ok: false,
      error: typeof confirm === 'string' ? 'purgeNote needs confirm to be exactly "purge e1"' : 'purgeNote needs non-empty strings: confirm',
    })
  }
  expect(parseAdjustment({ op: 'purgeNote', noteId: 'e1' })).toEqual({ ok: false, error: 'purgeNote needs non-empty strings: confirm' })
  expect(parseAdjustment(purge('e1'))).toEqual({ ok: true, adjustment: purge('e1') })
})

test('HTTP and MCP refuse a wrong confirmation with the same message, and both purge with the right one', async () => {
  const s = await started({ kinds: { organizer: ALL.organizer } })
  const server = serve(s.z, { port: 0, distDir: await tempDir() })
  const base = `http://127.0.0.1:${server.port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const rpc = async (method: string, params: unknown) => (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method, params })).json()).result
  try {
    await s.note('party: venue', `party: ${SECRET}`, `party: again ${SECRET}`)
    const tools = new Map<string, any>((await rpc('tools/list', {})).tools.map((t: any) => [t.name, t]))
    const tool = tools.get('purge_note')
    expect(tool.inputSchema.required).toEqual(['noteId', 'confirm'])
    expect(tool.description).toContain('only when the person explicitly asks to purge that note')

    const http = await post('/api/adjustments', { op: 'purgeNote', noteId: 'e2', confirm: 'yes' })
    expect([http.status, await http.json()]).toEqual([400, { ok: false, error: 'purgeNote needs confirm to be exactly "purge e2"' }])
    expect(await rpc('tools/call', { name: 'purge_note', arguments: { noteId: 'e2', confirm: 'yes' } })).toEqual({
      content: [{ type: 'text', text: 'purgeNote needs confirm to be exactly "purge e2"' }],
      isError: true,
    })
    expect(s.z.listEntries()).toHaveLength(3)

    const viaHttp = await post('/api/adjustments', purge('e2'))
    expect([viaHttp.status, (await viaHttp.json()).purge.noteId]).toEqual([200, 'e2'])
    const viaMcp = await rpc('tools/call', { name: 'purge_note', arguments: { noteId: 'e3', confirm: 'purge e3' } })
    expect(JSON.parse(viaMcp.content[0].text)).toMatchObject({ ok: true, purge: { noteId: 'e3' } })
    await s.z.idle()
    expect(await (await fetch(`${base}/api/purge/e3`)).json()).toEqual({ noteId: 'e3', done: true, scrubbing: false, pending: [] })
    expect(JSON.parse((await rpc('tools/call', { name: 'get_purge', arguments: { noteId: 'e2' } })).content[0].text)).toMatchObject({ done: true })
    expect((await fetch(`${base}/api/purge/e1`)).status).toBe(404)
    expect(await filesHolding(s.dir, ['7Q4X'])).toEqual([])
  } finally {
    server.stop(true)
    s.z.stop()
  }
})

const OC_SESSION = 'ses_fixture0001A'

test('after a purge and a restart, re-polling an opencode database that still has the row ingests nothing', async () => {
  const dir = await tempDir()
  const db = join(await tempDir(), 'opencode.db')
  const sql = new Database(db)
  sql.exec(await Bun.file(new URL('./fixtures/opencode-notes.sql', import.meta.url)).text())
  sql.close()
  const quiet = () => new Zephyr({ dataDir: dir, backend: scripted().backend, kinds: {}, pollMs: 20 })

  const z = quiet()
  await z.start()
  await z.registerSession('opencode', OC_SESSION, db)
  await eventually(() => z.listEntries().length === 2)
  const purged = await z.adjust(purge('msg_fixture0001'))
  expect(purged).toMatchObject({ ok: true, purge: { stillIn: expect.stringContaining(`the opencode database ${db}, message msg_fixture0001`) } })
  await Bun.sleep(100)
  expect(z.listEntries().map((e) => e.id)).toEqual(['msg_fixture0004'])
  z.stop()

  const restarted = quiet()
  await restarted.start()
  await Bun.sleep(150)
  expect(restarted.listEntries().map((e) => e.id)).toEqual(['msg_fixture0004'])
  expect(await filesHolding(dir, ['first note'])).toEqual([])
  restarted.stop()
})

test('after a purge and a restart, a Claude Code transcript re-read from 0, shrunk or at a new path, ingests nothing', async () => {
  const dir = await tempDir()
  const fixture = new URL('./fixtures/claude-code-notes.jsonl', import.meta.url).pathname
  const transcript = join(await tempDir(), 'session.jsonl')
  await copyFile(fixture, transcript)
  const [first, second] = (await readFile(fixture, 'utf8')).trim().split('\n')
  const session = JSON.parse(first!).sessionId
  const firstId = JSON.parse(first!).uuid
  const quiet = () => new Zephyr({ dataDir: dir, backend: scripted().backend, kinds: {}, pollMs: 20 })

  const z = quiet()
  await z.start()
  await z.registerSession('claude-code', session, transcript)
  await eventually(() => z.listEntries().length === 2)
  expect(await z.adjust(purge(firstId))).toMatchObject({ ok: true, purge: { stillIn: expect.stringContaining(`the Claude Code transcript ${transcript}, the line whose uuid is ${firstId}`) } })
  z.stop()

  const restarted = quiet()
  await restarted.start()
  const later = JSON.stringify({ ...JSON.parse(second!), uuid: 'later', message: { role: 'user', content: '[zephyr] later' } })
  await writeFile(transcript, `${first}\n${later}\n`)
  await eventually(() => restarted.listEntries().some((e) => e.id === 'later'))
  const moved = join(await tempDir(), 'moved.jsonl')
  await copyFile(fixture, moved)
  await appendFile(moved, `${later}\n`)
  await restarted.registerSession('claude-code', session, moved)
  await Bun.sleep(100)
  expect(restarted.listEntries().map((e) => e.text)).toEqual(['second note', 'later'])
  expect(await filesHolding(dir, ['first note'])).toEqual([])
  restarted.stop()
})

test('a purge of an edited note removes its original and its edited text', async () => {
  const s = await started({ kinds: { organizer: ALL.organizer } })
  await s.note('party: venue', `party: wifi ${SECRET}`)
  await s.adjust({ op: 'editNote', noteId: 'e2', text: `party: wifi ${EDITED}` })
  expect(await filesHolding(s.dir, [SECRET])).toContain('entries.jsonl')
  expect(await filesHolding(s.dir, [EDITED])).toContain('adjustments.jsonl')
  const result = (await s.adjust(purge('e2'))) as Extract<AdjustmentResult, { ok: true }>
  expect(result.purge!.lines).toMatchObject({ entries: 1, adjustments: 1 })
  expect(await filesHolding(s.dir, [SECRET, EDITED])).toEqual([])
  s.z.stop()
})

test('appends made while entries.jsonl is rewritten all land in the rewritten file', async () => {
  const store = new Store(await tempDir())
  await store.init()
  await store.appendEntries(Array.from({ length: 200 }, (_, i) => entry(`old${i}`)))
  const rewrite = store.rewriteEntries((e) => (e.id === 'old0' ? null : e))
  const appends = Array.from({ length: 20 }, (_, i) => store.appendEntries([entry(`new${i}`)]))
  expect(await rewrite).toBe(1)
  await Promise.all(appends)
  const ids = (await store.loadEntries()).map((e) => e.id)
  expect(ids).toHaveLength(219)
  expect(ids).not.toContain('old0')
  expect(ids.slice(-20)).toEqual(Array.from({ length: 20 }, (_, i) => `new${i}`))
})

test("a topic whose only note is purged goes with every archived version, even one that does not quote the note", async () => {
  const s = await started({ kinds: { organizer: ALL.organizer } })
  await s.note('solo: ok', 'garden: beans')
  await s.z.store.archiveView({ ...s.view('organizer/solo')!, body: 'a paraphrase' })
  expect(await filesUnder(join(s.dir, 'views/organizer/.history/solo'))).toHaveLength(1)
  expect(await s.adjust(purge('e1'))).toMatchObject({ ok: true, deleted: ['organizer/solo'] })
  expect(await filesUnder(join(s.dir, 'views/organizer/.history/solo'))).toEqual([])
  expect(await filesUnder(join(s.dir, 'views/organizer'))).toEqual(['.history', 'garden.json', 'garden.md'])
  s.z.stop()
})

test('a filing run that was shown the note when the purge started cannot write its words back', async () => {
  const s = await started({ kinds: { organizer: ALL.organizer } })
  await s.note('party: venue')
  s.d.hold('file')
  await s.z.ingest([entry('e2', `party: wifi ${SECRET}`)])
  await eventually(() => s.d.calls.includes('file e2'))
  const purged = s.z.adjust(purge('e2'))
  await Bun.sleep(20)
  s.d.release()
  expect(await purged).toMatchObject({ ok: true, written: ['organizer/party'] })
  await s.z.idle()
  expect(await filesHolding(s.dir, ['7Q4X', 'wifi'])).toEqual([])
  s.z.stop()
})
