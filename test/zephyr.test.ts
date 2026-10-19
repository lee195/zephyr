import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, Entry, ModelBackend } from '../src/domain'
import { Zephyr } from '../src/zephyr'

const entry = (id: string, text = id): Entry => ({ id, harness: 'claude-code', sessionId: 's', at: '2026-10-19T00:00:00Z', text })

const noteRow = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', isMeta: true, uuid, timestamp: '2026-10-19T00:00:00Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: `[zephyr] ${text}` }] } }) + '\n'

/** Groups every entry it is shown into one "all" topic; optionally holds each call until released. */
function fakeBackend() {
  const calls: string[][] = []
  const gates: Array<() => void> = []
  let hold = false
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = JSON.parse(messages.at(-1)!.content)
      const ids: string[] = payload.newEntries.map((e: any) => e.id)
      calls.push(ids)
      if (hold) await new Promise<void>((r) => gates.push(r))
      return { json: { ops: [{ op: 'write', slug: 'all', title: 'All', sources: ids, body: ids.join(',') }] } }
    },
  }
  return {
    backend,
    calls,
    holdCalls: () => (hold = true),
    release: () => {
      hold = false
      gates.splice(0).forEach((r) => r())
    },
  }
}

const tempDir = () => mkdtemp(join(tmpdir(), 'zephyr-test-'))

async function eventually(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error('condition not met in time')
}

test('entries arriving during a run coalesce into exactly one next run', async () => {
  const fake = fakeBackend()
  const z = new Zephyr({ dataDir: await tempDir(), backend: fake.backend })
  await z.start()
  fake.holdCalls()

  await z.ingest([entry('e1')])
  await eventually(() => fake.calls.length === 1)
  await z.ingest([entry('e2')])
  await z.ingest([entry('e3')])
  fake.release()
  await z.idle()

  expect(fake.calls).toEqual([['e1'], ['e2', 'e3']])
  expect(z.listRuns().map((r) => [r.entryIds, r.status])).toEqual([
    [['e1'], 'done'],
    [['e2', 'e3'], 'done'],
  ])
  expect(z.listViews().map((v) => [v.slug, v.sources])).toEqual([['all', ['e1', 'e2', 'e3']]])
})

const fastRetries = [1, 1, 1]

const runLines = async (dir: string) =>
  (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))

test('a bad model reply fails the run and writes nothing', async () => {
  const dir = await tempDir()
  const z = new Zephyr({ dataDir: dir, backend: { complete: async () => ({ json: { nope: true } }) }, retryDelaysMs: [] })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(z.listRuns()[0]?.status).toBe('failed')
  expect(z.listViews()).toEqual([])
  expect(await readdir(join(dir, 'views'))).toEqual([])
})

test('a run that fails once is retried, and both outcomes are persisted', async () => {
  const dir = await tempDir()
  const fake = fakeBackend()
  let failures = 1
  const backend: ModelBackend = {
    async complete(messages, opts) {
      if (failures-- > 0) throw new Error('vllm 503: overloaded')
      return fake.backend.complete(messages, opts)
    },
  }
  const z = new Zephyr({ dataDir: dir, backend, retryDelaysMs: fastRetries })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()

  expect(z.listViews().map((v) => [v.slug, v.sources])).toEqual([['all', ['e1']]])
  const [failed, done] = await runLines(dir)
  expect(failed).toMatchObject({ kind: 'organizer', entryIds: ['e1'], status: 'failed', attempt: 1, error: 'vllm 503: overloaded' })
  expect(done).toMatchObject({ kind: 'organizer', entryIds: ['e1'], status: 'done', attempt: 2, retryOf: failed.id })
  expect(z.status().runsInFlight).toBe(0)

  const reloaded = new Zephyr({ dataDir: dir, backend: fake.backend })
  await reloaded.start()
  expect(reloaded.listRuns().map((r) => [r.status, r.attempt])).toEqual([['failed', 1], ['done', 2]])
})

test('a run that always fails stops after four attempts', async () => {
  const dir = await tempDir()
  let calls = 0
  const z = new Zephyr({
    dataDir: dir,
    backend: { complete: async () => (calls++, Promise.reject(new Error('unreachable'))) },
    retryDelaysMs: fastRetries,
  })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(calls).toBe(4)
  expect((await runLines(dir)).map((r) => [r.status, r.attempt])).toEqual([['failed', 1], ['failed', 2], ['failed', 3], ['failed', 4]])
  expect(z.status().runsInFlight).toBe(0)
})

test('a scheduled retry counts as in flight until it runs', async () => {
  const z = new Zephyr({ dataDir: await tempDir(), backend: { complete: async () => ({ json: { nope: true } }) }, retryDelaysMs: [60_000] })
  await z.start()
  await z.ingest([entry('e1')])
  await eventually(() => z.listRuns()[0]?.status === 'failed')
  expect(z.status().runsInFlight).toBe(1)
  z.stop()
  await z.idle()
  expect(z.status().runsInFlight).toBe(0)
})

test('a retry coalesces with the waiting run and keeps the higher attempt', async () => {
  const gates: Array<() => void> = []
  const calls: string[][] = []
  const backend: ModelBackend = {
    async complete(messages) {
      const ids: string[] = JSON.parse(messages.at(-1)!.content).newEntries.map((e: any) => e.id)
      calls.push(ids)
      await new Promise<void>((r) => gates.push(r))
      if (calls.length === 1) throw new Error('boom')
      return { json: { ops: [{ op: 'write', slug: 'all', title: 'All', sources: ids, body: '' }] } }
    },
  }
  const z = new Zephyr({ dataDir: await tempDir(), backend, retryDelaysMs: [200] })
  await z.start()
  await z.ingest([entry('e1')])
  await eventually(() => calls.length === 1)
  await z.ingest([entry('e2')])
  gates.shift()!()
  await eventually(() => calls.length === 2)
  await z.ingest([entry('e3')])
  await eventually(() => z.listRuns().some((r) => r.status === 'queued' && r.entryIds.includes('e1')))
  while (gates.length || z.status().runsInFlight) {
    gates.shift()?.()
    await Bun.sleep(5)
  }
  await z.idle()

  expect(calls).toEqual([['e1'], ['e2'], ['e1', 'e3']])
  expect(z.listRuns().map((r) => [r.entryIds, r.status, r.attempt])).toEqual([
    [['e1'], 'failed', 1],
    [['e2'], 'done', 1],
    [['e3', 'e1'], 'done', 2],
  ])
})

async function seedDataDir(entries: Entry[], runs?: object[]) {
  const dir = await tempDir()
  await writeFile(join(dir, 'entries.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  if (runs) await writeFile(join(dir, 'runs.jsonl'), runs.map((r) => JSON.stringify(r) + '\n').join(''))
  return dir
}

test('on start, entries not covered by a done run are queued and covered ones are not', async () => {
  const dir = await seedDataDir(
    [entry('e1'), entry('e2'), entry('e3')],
    [
      { id: 'r1', kind: 'organizer', entryIds: ['e1'], status: 'done', attempt: 1 },
      { id: 'r2', kind: 'organizer', entryIds: ['e2'], status: 'failed', attempt: 4, error: 'x' },
      { id: 'r3', kind: 'other', entryIds: ['e3'], status: 'done', attempt: 1 },
    ],
  )
  const fake = fakeBackend()
  const z = new Zephyr({ dataDir: dir, backend: fake.backend })
  await z.start()
  await z.idle()
  expect(fake.calls).toEqual([['e2', 'e3']])
  expect(z.listRuns().at(-1)).toMatchObject({ entryIds: ['e2', 'e3'], status: 'done', attempt: 1 })
})

test('a data dir without runs.jsonl treats entries its views cite as organized, once and for good', async () => {
  const dir = await seedDataDir([entry('e1'), entry('e2')])
  await mkdir(join(dir, 'views/organizer'), { recursive: true })
  await writeFile(join(dir, 'views/organizer/a.md'), 'e1')
  const meta = { id: 'organizer/a', kind: 'organizer', slug: 'a', title: 'A', sources: ['e1'], format: 'md', updatedAt: 't' }
  await writeFile(join(dir, 'views/organizer/a.json'), JSON.stringify(meta))

  const fake = fakeBackend()
  const z = new Zephyr({ dataDir: dir, backend: fake.backend })
  await z.start()
  await z.idle()
  expect(fake.calls).toEqual([['e2']])

  const again = fakeBackend()
  const restarted = new Zephyr({ dataDir: dir, backend: again.backend })
  await restarted.start()
  await restarted.idle()
  expect(again.calls).toEqual([])
})

test('a data dir without runs.jsonl or views organizes every entry', async () => {
  const fake = fakeBackend()
  const z = new Zephyr({ dataDir: await seedDataDir([entry('e1'), entry('e2')]), backend: fake.backend })
  await z.start()
  await z.idle()
  expect(fake.calls).toEqual([['e1', 'e2']])
})

test('views persist as files and reload after restart', async () => {
  const dir = await tempDir()
  const z = new Zephyr({ dataDir: dir, backend: fakeBackend().backend })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(await readFile(join(dir, 'views/organizer/all.md'), 'utf8')).toBe('e1')

  const reloaded = new Zephyr({ dataDir: dir, backend: fakeBackend().backend })
  await reloaded.start()
  expect(reloaded.listViews().map((v) => [v.id, v.sources, v.body])).toEqual([['organizer/all', ['e1'], 'e1']])
})

test('a registered transcript is backfilled, tailed, and never duplicated across restarts', async () => {
  const dir = await tempDir()
  const transcript = join(await tempDir(), 'session.jsonl')
  await writeFile(transcript, noteRow('n1', 'first') + JSON.stringify({ type: 'assistant', uuid: 'a1' }) + '\n')

  const z = new Zephyr({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
  await z.start()
  await z.registerSession('claude-code', 's1', transcript)
  await z.registerSession('claude-code', 's1', transcript)
  await eventually(() => z.listEntries().length === 1)

  await appendFile(transcript, noteRow('n2', 'second').slice(0, 20))
  await Bun.sleep(150)
  expect(z.listEntries().map((e) => e.id)).toEqual(['n1'])
  await appendFile(transcript, noteRow('n2', 'second').slice(20))
  await eventually(() => z.listEntries().length === 2)
  await z.idle()
  z.stop()

  // Simulate a crash that lost the offset: the whole transcript is re-read.
  await writeFile(join(dir, 'sessions.json'), JSON.stringify([{ harness: 'claude-code', sessionId: 's1', transcriptPath: transcript, offset: 0 }]))
  const restarted = new Zephyr({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
  await restarted.start()
  await appendFile(transcript, noteRow('n3', 'third'))
  await eventually(() => restarted.listEntries().length === 3)
  restarted.stop()

  const lines = (await readFile(join(dir, 'entries.jsonl'), 'utf8')).trim().split('\n')
  expect(lines.map((l) => JSON.parse(l).id)).toEqual(['n1', 'n2', 'n3'])
  expect(restarted.status().sessions).toBe(1)
})

async function seedViews(dir: string, views: { slug: string; sources: string[]; body: string }[]) {
  await mkdir(join(dir, 'views/organizer'), { recursive: true })
  for (const v of views) {
    await writeFile(join(dir, `views/organizer/${v.slug}.md`), v.body)
    const meta = { id: `organizer/${v.slug}`, kind: 'organizer', slug: v.slug, title: v.slug.toUpperCase(), sources: v.sources, format: 'md', updatedAt: 't' }
    await writeFile(join(dir, `views/organizer/${v.slug}.json`), JSON.stringify(meta))
  }
}

/** Replies with the given ops for every call, and keeps the messages it was sent. */
function scripted(ops: object[]) {
  const sent: ChatMessage[][] = []
  const backend: ModelBackend = {
    async complete(messages) {
      sent.push(messages)
      return { json: { ops } }
    },
  }
  return { backend, sent }
}

/** A data dir where e1 and e2 are organized into topic "a", and e3 is waiting to be organized. */
async function organizedDir() {
  const dir = await seedDataDir([entry('e1'), entry('e2'), entry('e3')], [{ id: 'r1', kind: 'organizer', entryIds: ['e1', 'e2'], status: 'done', attempt: 1 }])
  await seedViews(dir, [{ slug: 'a', sources: ['e1', 'e2'], body: 'First section.\n' }])
  return dir
}

test('append adds a section to an existing topic and unions its sources', async () => {
  const dir = await organizedDir()
  const z = new Zephyr({ dataDir: dir, backend: scripted([{ op: 'append', slug: 'a', sources: ['e3'], body: 'Second section.' }]).backend })
  await z.start()
  await z.idle()
  expect(z.listViews().map((v) => [v.slug, v.title, v.sources, v.body])).toEqual([['a', 'A', ['e1', 'e2', 'e3'], 'First section.\n\nSecond section.']])
  expect(await readFile(join(dir, 'views/organizer/a.md'), 'utf8')).toBe('First section.\n\nSecond section.')
  expect(z.listRuns().at(-1)?.status).toBe('done')
  expect(z.listRuns().at(-1)?.dropped).toBeUndefined()
})

test('append to an unknown topic is dropped with a reason, and the rest of the reply applies', async () => {
  const dir = await organizedDir()
  const reply = [
    { op: 'append', slug: 'ghost', sources: ['e3'], body: 'lost' },
    { op: 'write', slug: 'fresh', title: 'Fresh', sources: ['e3'], body: 'kept' },
  ]
  const z = new Zephyr({ dataDir: dir, backend: scripted(reply).backend })
  await z.start()
  await z.idle()
  expect(z.listViews().map((v) => [v.slug, v.sources, v.body]).sort()).toEqual([
    ['a', ['e1', 'e2'], 'First section.\n'],
    ['fresh', ['e3'], 'kept'],
  ])
  expect(z.listRuns().at(-1)).toMatchObject({ status: 'done', dropped: ['append ghost: no such topic'] })
})
