import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, ModelBackend, View } from '../src/domain'
import { withFallback, type RelevanceBackend } from '../src/relevance'
import { kinds } from '../src/kinds'
import { Zephyr, type ZephyrOptions } from '../src/zephyr'
import { doneRun, entry, gate, payloadOf, seedDataDir, tempDir } from './helpers'

/** These tests pin core behavior with the organizer as the only kind, so call counts are one kind's. */
class OrganizerOnly extends Zephyr {
  constructor(opts: ZephyrOptions) {
    super({ kinds: { organizer: kinds.organizer! }, ...opts })
  }
}

const noteRow = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', isMeta: true, uuid, timestamp: '2026-10-19T00:00:00Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: `[zephyr] ${text}` }] } }) + '\n'

/** Groups every entry it is shown into one "all" topic; optionally holds each call until released. */
function fakeBackend() {
  const calls: string[][] = []
  const held = gate()
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const ids: string[] = payloadOf(messages).newEntries.map((e: any) => e.id)
      calls.push(ids)
      await held.pass()
      return { json: { ops: [{ op: 'write', slug: 'all', title: 'All', sources: ids, body: ids.join(',') }] } }
    },
  }
  return { backend, calls, holdCalls: () => held.hold(), release: held.release }
}

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
  const z = new OrganizerOnly({ dataDir: await tempDir(), backend: fake.backend })
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

/** An organizer topic on disk, titled after its slug. */
const topic = (slug: string, sources: string[], body: string): Omit<View, 'id'> => ({ kind: 'organizer', slug, title: slug.toUpperCase(), sources, format: 'md', body, updatedAt: 't' })

const runLines = async (dir: string) =>
  (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))

test('a bad model reply fails the run and writes nothing', async () => {
  const dir = await tempDir()
  const z = new OrganizerOnly({ dataDir: dir, backend: { complete: async () => ({ json: { nope: true } }) }, retryDelaysMs: [] })
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
  const z = new OrganizerOnly({ dataDir: dir, backend, retryDelaysMs: fastRetries })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()

  expect(z.listViews().map((v) => [v.slug, v.sources])).toEqual([['all', ['e1']]])
  const [failed, done] = await runLines(dir)
  expect(failed).toMatchObject({ kind: 'organizer', entryIds: ['e1'], status: 'failed', attempt: 1, error: 'vllm 503: overloaded' })
  expect(done).toMatchObject({ kind: 'organizer', entryIds: ['e1'], status: 'done', attempt: 2, retryOf: failed.id })
  expect(z.status().runsInFlight).toBe(0)

  const reloaded = new OrganizerOnly({ dataDir: dir, backend: fake.backend })
  await reloaded.start()
  expect(reloaded.listRuns().map((r) => [r.status, r.attempt])).toEqual([['failed', 1], ['done', 2]])
})

test('a run that always fails stops after four attempts', async () => {
  const dir = await tempDir()
  let calls = 0
  const z = new OrganizerOnly({
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
  const z = new OrganizerOnly({ dataDir: await tempDir(), backend: { complete: async () => ({ json: { nope: true } }) }, retryDelaysMs: [60_000] })
  await z.start()
  await z.ingest([entry('e1')])
  await eventually(() => z.listRuns()[0]?.status === 'failed')
  expect(z.status().runsInFlight).toBe(1)
  z.stop()
  await z.idle()
  expect(z.status().runsInFlight).toBe(0)
})

test('a retry never merges with new work of another attempt; work of the same attempt still coalesces', async () => {
  const gates: Array<() => void> = []
  const calls: string[][] = []
  const backend: ModelBackend = {
    async complete(messages) {
      const ids: string[] = payloadOf(messages).newEntries.map((e: any) => e.id)
      calls.push(ids)
      await new Promise<void>((r) => gates.push(r))
      if (calls.length === 1) throw new Error('boom')
      return { json: { ops: [{ op: 'write', slug: 'all', title: 'All', sources: ids, body: '' }] } }
    },
  }
  const z = new OrganizerOnly({ dataDir: await tempDir(), backend, retryDelaysMs: [200] })
  await z.start()
  await z.ingest([entry('e1')])
  await eventually(() => calls.length === 1)
  await z.ingest([entry('e2')])
  gates.shift()!()
  await eventually(() => calls.length === 2)
  await z.ingest([entry('e3')])
  await z.ingest([entry('e4')])
  await eventually(() => z.listRuns().some((r) => r.status === 'queued' && r.entryIds.includes('e1')))
  while (gates.length || z.status().runsInFlight) {
    gates.shift()?.()
    await Bun.sleep(5)
  }
  await z.idle()

  expect(calls).toEqual([['e1'], ['e2'], ['e3', 'e4'], ['e1']])
  const [failed] = z.listRuns()
  expect(z.listRuns().map((r) => [r.entryIds, r.status, r.attempt, r.retryOf])).toEqual([
    [['e1'], 'failed', 1, undefined],
    [['e2'], 'done', 1, undefined],
    [['e3', 'e4'], 'done', 1, undefined],
    [['e1'], 'done', 2, failed!.id],
  ])
})

test('a note the reply skipped is retried like a failed run, and stays unorganized across a restart', async () => {
  const dir = await tempDir()
  const skipsE2 = scripted([{ op: 'write', slug: 'one', title: 'One', sources: ['e1'], body: 'e1' }])
  const z = new OrganizerOnly({ dataDir: dir, backend: skipsE2.backend, retryDelaysMs: fastRetries })
  await z.start()
  await z.ingest([entry('e1'), entry('e2')])
  await z.idle()

  expect(skipsE2.sent.map((m) => JSON.parse(m.at(-1)!.content).newEntries.map((e: any) => e.id))).toEqual([['e1', 'e2'], ['e2'], ['e2'], ['e2']])
  const lines = await runLines(dir)
  expect(lines.map((r) => [r.entryIds, r.status, r.attempt, r.uncovered])).toEqual([
    [['e1', 'e2'], 'done', 1, ['e2']],
    [['e2'], 'done', 2, ['e2']],
    [['e2'], 'done', 3, ['e2']],
    [['e2'], 'done', 4, ['e2']],
  ])
  expect(lines.slice(1).map((r) => r.retryOf)).toEqual(lines.slice(0, -1).map((r) => r.id))

  const fake = fakeBackend()
  const restarted = new OrganizerOnly({ dataDir: dir, backend: fake.backend })
  await restarted.start()
  await restarted.idle()
  expect(fake.calls).toEqual([['e2']])
})

test('on start, entries not covered by a done run are queued and covered ones are not', async () => {
  const dir = await seedDataDir({
    entries: [entry('e1'), entry('e2'), entry('e3')],
    runs: [
      { id: 'r1', kind: 'organizer', entryIds: ['e1'], status: 'done', attempt: 1 },
      { id: 'r2', kind: 'organizer', entryIds: ['e2'], status: 'failed', attempt: 4, error: 'x' },
      { id: 'r3', kind: 'other', entryIds: ['e3'], status: 'done', attempt: 1 },
    ],
  })
  const fake = fakeBackend()
  const z = new OrganizerOnly({ dataDir: dir, backend: fake.backend })
  await z.start()
  await z.idle()
  expect(fake.calls).toEqual([['e2', 'e3']])
  expect(z.listRuns().at(-1)).toMatchObject({ entryIds: ['e2', 'e3'], status: 'done', attempt: 1 })
})

test('a data dir without runs.jsonl treats entries its views cite as organized, once and for good', async () => {
  const dir = await seedDataDir({ entries: [entry('e1'), entry('e2')], views: [topic('a', ['e1'], 'e1')] })

  const fake = fakeBackend()
  const z = new OrganizerOnly({ dataDir: dir, backend: fake.backend })
  await z.start()
  await z.idle()
  expect(fake.calls).toEqual([['e2']])

  const again = fakeBackend()
  const restarted = new OrganizerOnly({ dataDir: dir, backend: again.backend })
  await restarted.start()
  await restarted.idle()
  expect(again.calls).toEqual([])
})

test('a data dir without runs.jsonl or views organizes every entry', async () => {
  const fake = fakeBackend()
  const z = new OrganizerOnly({ dataDir: await seedDataDir({ entries: [entry('e1'), entry('e2')] }), backend: fake.backend })
  await z.start()
  await z.idle()
  expect(fake.calls).toEqual([['e1', 'e2']])
})

test('views persist as files and reload after restart', async () => {
  const dir = await tempDir()
  const z = new OrganizerOnly({ dataDir: dir, backend: fakeBackend().backend })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(await readFile(join(dir, 'views/organizer/all.md'), 'utf8')).toBe('e1')

  const reloaded = new OrganizerOnly({ dataDir: dir, backend: fakeBackend().backend })
  await reloaded.start()
  expect(reloaded.listViews().map((v) => [v.id, v.sources, v.body])).toEqual([['organizer/all', ['e1'], 'e1']])
})

test('a registered transcript is backfilled, tailed, and never duplicated across restarts', async () => {
  const dir = await tempDir()
  const transcript = join(await tempDir(), 'session.jsonl')
  await writeFile(transcript, noteRow('n1', 'first') + JSON.stringify({ type: 'assistant', uuid: 'a1' }) + '\n')

  const z = new OrganizerOnly({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
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
  const restarted = new OrganizerOnly({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
  await restarted.start()
  await appendFile(transcript, noteRow('n3', 'third'))
  await eventually(() => restarted.listEntries().length === 3)
  restarted.stop()

  const lines = (await readFile(join(dir, 'entries.jsonl'), 'utf8')).trim().split('\n')
  expect(lines.map((l) => JSON.parse(l).id)).toEqual(['n1', 'n2', 'n3'])
  expect(restarted.status().sessions).toBe(1)
})

test('a note whose entry append failed is re-read from its transcript and kept', async () => {
  const dir = await tempDir()
  const transcript = join(await tempDir(), 'session.jsonl')
  await writeFile(transcript, noteRow('n1', 'first'))
  const z = new OrganizerOnly({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
  await z.start()
  const append = z.store.appendEntries.bind(z.store)
  let failures = 1
  z.store.appendEntries = async (entries) => {
    if (failures-- > 0) throw new Error('disk full')
    return append(entries)
  }

  await z.registerSession('claude-code', 's1', transcript)
  await eventually(() => z.listEntries().length === 1)
  await z.idle()
  z.stop()

  expect((await readFile(join(dir, 'entries.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['n1'])
  expect(z.listViews().map((v) => v.sources)).toEqual([['n1']])
})

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
function organizedDir() {
  return seedDataDir({
    entries: [entry('e1'), entry('e2'), entry('e3')],
    runs: [doneRun('organizer', ['e1', 'e2'])],
    views: [topic('a', ['e1', 'e2'], 'First section.\n')],
  })
}

test('append adds a section to an existing topic and unions its sources', async () => {
  const dir = await organizedDir()
  const z = new OrganizerOnly({ dataDir: dir, backend: scripted([{ op: 'append', slug: 'a', sources: ['e3'], body: 'Second section.' }]).backend })
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
  const z = new OrganizerOnly({ dataDir: dir, backend: scripted(reply).backend })
  await z.start()
  await z.idle()
  expect(z.listViews().map((v) => [v.slug, v.sources, v.body]).sort()).toEqual([
    ['a', ['e1', 'e2'], 'First section.\n'],
    ['fresh', ['e3'], 'kept'],
  ])
  expect(z.listRuns().at(-1)).toMatchObject({ status: 'done', dropped: ['append ghost: no such topic'] })
})

/** Scores views by a fixed table, so the expected open set is known without running tfidf. */
function fixedRelevance(scores: Record<string, number>) {
  const queries: string[] = []
  const relevance: RelevanceBackend = {
    async rank(query, docs) {
      queries.push(query)
      return { backend: 'fixed', scored: docs.map((d) => ({ id: d.id, score: scores[d.id] ?? 0 })).sort((a, b) => b.score - a.score), minRelatedScore: 0 }
    },
  }
  return { relevance, queries }
}

/** Five topics a..e over e1..e5, and e6 waiting to be organized. */
function fiveTopicDir() {
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5']
  return seedDataDir({
    entries: [...ids, 'e6'].map((id) => entry(id, `text of ${id}`)),
    runs: [doneRun('organizer', ids)],
    views: ['a', 'b', 'c', 'd', 'e'].map((slug, i) => topic(slug, [ids[i]!], `body of ${slug}`)),
  })
}

const scores = { 'organizer/e': 0.9, 'organizer/c': 0.7, 'organizer/a': 0.5, 'organizer/b': 0.3, 'organizer/d': 0.1 }

test('the three views most relevant to the new entries are open, every other view is one index line', async () => {
  const fake = scripted([])
  const rel = fixedRelevance(scores)
  const z = new OrganizerOnly({ dataDir: await fiveTopicDir(), backend: fake.backend, relevance: rel.relevance, retryDelaysMs: [] })
  await z.start()
  await z.idle()

  expect(rel.queries).toEqual(['text of e6'])
  const content = fake.sent[0]!.map((m) => m.content).join('\n')
  const user = JSON.parse(fake.sent[0]!.at(-1)!.content)
  expect(user.openTopics.map((t: any) => [t.slug, t.body])).toEqual([['e', 'body of e'], ['c', 'body of c'], ['a', 'body of a']])
  expect(user.topicIndex.sort()).toEqual(['b | B | 1 sources', 'd | D | 1 sources'])
  expect(content).not.toContain('body of b')
  expect(content).not.toContain('body of d')
})

test('a write to an existing topic that was not open is dropped; a write to an open one applies', async () => {
  const reply = [
    { op: 'write', slug: 'b', title: 'B', sources: ['e6'], body: 'clobbered' },
    { op: 'write', slug: 'c', title: 'C', sources: ['e6'], body: 'rewritten' },
  ]
  const z = new OrganizerOnly({ dataDir: await fiveTopicDir(), backend: scripted(reply).backend, relevance: fixedRelevance(scores).relevance })
  await z.start()
  await z.idle()

  const bySlug = Object.fromEntries(z.listViews().map((v) => [v.slug, [v.sources, v.body]]))
  expect(bySlug.b).toEqual([['e2'], 'body of b'])
  expect(bySlug.c).toEqual([['e3', 'e6'], 'rewritten'])
  expect(z.listRuns().at(-1)).toMatchObject({ status: 'done', dropped: ['write b: topic exists but was not open'] })
})

test('with the primary relevance backend down, the open set comes from the fallback', async () => {
  const fake = scripted([])
  const down: RelevanceBackend = { rank: async () => Promise.reject(new Error('endpoint down')) }
  const relevance = withFallback(down, fixedRelevance(scores).relevance, { timeoutMs: 1000, cooldownMs: 30_000 })
  const z = new OrganizerOnly({ dataDir: await fiveTopicDir(), backend: fake.backend, relevance, retryDelaysMs: [] })
  await z.start()
  await z.idle()

  expect(JSON.parse(fake.sent[0]!.at(-1)!.content).openTopics.map((t: any) => t.slug)).toEqual(['e', 'c', 'a'])
  expect(z.listRuns().at(-1)).toMatchObject({ status: 'done' })
})
