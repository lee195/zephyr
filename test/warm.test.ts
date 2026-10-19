import { afterEach, expect, test } from 'bun:test'
import { kinds } from '../src/kinds'
import { relevanceBackends, withFallback } from '../src/relevance'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { doneRun, entry, eventually, fakeEmbeddings, scripted, seedDataDir, testEmbedding } from './helpers'

const entries = [
  entry('e1', 'sourdough starter fed with rye'),
  entry('e2', 'sourdough loaf at high hydration'),
  entry('e3', 'coolify deploy failed on the port'),
]
const topic = { kind: 'organizer', slug: 'bread', title: 'Bread', sources: ['e1', 'e2'], format: 'md' as const, body: 'about sourdough', updatedAt: '2026-10-19T09:00:00Z' }
const DRAFT = 'my sourdough starter is sluggish'
const docTexts = [...entries.map((e) => e.text), 'Bread\nabout sourdough']

const seeded = () =>
  seedDataDir({ entries, views: [topic], runs: ['organizer', 'tasks'].map((kind) => doneRun(kind, entries.map((e) => e.id))) })

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

/** The production composition: embeddings over a fake endpoint, falling back to tfidf. */
async function server(dataDir: string, fetch: typeof globalThis.fetch, cooldownMs = 30_000) {
  const embedding = testEmbedding(`${dataDir}/embeddings`, fetch)
  const relevance = withFallback(embedding, relevanceBackends.tfidf(), { timeoutMs: 1000, cooldownMs })
  const z = new Zephyr({ dataDir, backend: scripted({ ops: [] }).backend, kinds: { organizer: kinds.organizer!, tasks: kinds.tasks! }, relevance })
  await z.start()
  const s = serve(z, { port: 0, distDir: '/nonexistent' })
  cleanup.push(() => s.stop(true), () => z.stop())
  const get = async (path: string) => (await fetch_(`http://127.0.0.1:${s.port}${path}`)).json() as Promise<any>
  return {
    z,
    status: () => get('/status'),
    hint: () => get(`/hints?q=${encodeURIComponent(DRAFT)}`),
  }
}
const fetch_ = globalThis.fetch

test('warm-up embeds every uncached doc once, entries and organizer topics, and reports done in /status', async () => {
  const end = fakeEmbeddings()
  const { status } = await server(await seeded(), end.fetch)
  await eventually(async () => (await status()).relevance.warmup === 'done')
  expect((await status()).relevance).toEqual({ warmup: 'done', pending: 0 })
  expect(end.sentTexts().sort()).toEqual([...docTexts].sort())
})

test('a hint during warm-up does not wait for the doc batches and comes back partial from the embedding backend', async () => {
  const end = fakeEmbeddings()
  end.hold((input) => !input.includes(DRAFT))
  const { status, hint } = await server(await seeded(), end.fetch)
  await eventually(async () => (await status()).relevance.pending === docTexts.length)
  expect((await status()).relevance.warmup).toBe('running')
  const reply = await hint()
  expect(reply).toMatchObject({ backend: 'embedding-gemma', partial: true })
  end.release()
})

test('after warm-up a hint is complete', async () => {
  const end = fakeEmbeddings()
  const { status, hint } = await server(await seeded(), end.fetch)
  await eventually(async () => (await status()).relevance.warmup === 'done')
  expect(await hint()).toMatchObject({ backend: 'embedding-gemma', partial: false })
})

test('a new entry is embedded on ingest, so the next hint sends only its query', async () => {
  const end = fakeEmbeddings()
  const { z, status, hint } = await server(await seeded(), end.fetch)
  await eventually(async () => (await status()).relevance.warmup === 'done')
  await z.ingest([entry('e4', 'rye sourdough rose overnight')])
  await eventually(() => end.sentTexts().includes('rye sourdough rose overnight'))
  await eventually(async () => (await status()).relevance.pending === 0)
  const before = end.batches.length
  expect(await hint()).toMatchObject({ backend: 'embedding-gemma', partial: false })
  expect(end.batches.slice(before)).toEqual([[DRAFT]])
})

test('a restart with every doc cached sends no doc to the endpoint', async () => {
  const dir = await seeded()
  const first = await server(dir, fakeEmbeddings().fetch)
  await eventually(async () => (await first.status()).relevance.warmup === 'done')
  for (const c of cleanup) c()
  cleanup = []

  const end = fakeEmbeddings()
  const { status } = await server(dir, end.fetch)
  await eventually(async () => (await status()).relevance.warmup === 'done')
  expect(end.batches).toEqual([])
})

test('with the endpoint down during warm-up, the server keeps serving tfidf hints', async () => {
  const down = (async () => new Response('upstream unreachable', { status: 503 })) as unknown as typeof fetch
  const { status, hint } = await server(await seeded(), down)
  await eventually(async () => (await status()).relevance.warmup === 'failed')
  const reply = await hint()
  expect(reply).toMatchObject({ backend: 'tfidf', partial: false })
  expect(reply.hints.map((h: { entryId: string }) => h.entryId)).toContain('e1')
})

test('a failed warm-up is finished once a hint finds the endpoint back, and then reports done', async () => {
  const end = fakeEmbeddings()
  let up = false
  const flaky = (async (url: string, init: RequestInit) =>
    up ? end.fetch(url, init) : new Response('upstream unreachable', { status: 503 })) as unknown as typeof fetch
  const { status, hint } = await server(await seeded(), flaky, 0)
  await eventually(async () => (await status()).relevance.warmup === 'failed')
  up = true
  expect(await hint()).toMatchObject({ backend: 'embedding-gemma', partial: true })
  await eventually(async () => (await status()).relevance.warmup === 'done')
  expect((await status()).relevance.pending).toBe(0)
  expect(await hint()).toMatchObject({ partial: false })
})

test('an organizer run waits for its topics to be embedded, so every topic can open', async () => {
  const dir = await seedDataDir({
    entries: [...entries, entry('e4', 'rye sourdough rose overnight')],
    views: [topic],
    runs: ['organizer', 'tasks'].map((kind) => doneRun(kind, entries.map((e) => e.id))),
  })
  const end = fakeEmbeddings()
  end.hold((input) => input.includes('Bread\nabout sourdough'))
  const model = scripted({ ops: [] })
  const embedding = testEmbedding(`${dir}/embeddings`, end.fetch)
  const z = new Zephyr({ dataDir: dir, backend: model.backend, kinds: { organizer: kinds.organizer! }, relevance: embedding, retryDelaysMs: [] })
  await z.start()
  cleanup.push(() => z.stop())
  await Bun.sleep(50)
  end.release()
  await z.idle()
  expect(JSON.parse(model.sent[0]!.at(-1)!.content).openTopics.map((t: { slug: string }) => t.slug)).toEqual(['bread'])
})
