import { afterEach, expect, test } from 'bun:test'
import type { ModelBackend } from '../src/domain'
import { hintsFor } from '../src/hints'
import { relevanceBackends, withFallback, type RelevanceBackend } from '../src/relevance'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { entry, seedDataDir } from './helpers'

const entries = [
  entry('starter', 'Sourdough starter fed with rye doubled in six hours. Bulk ferment ran long, crumb was tight.', '2026-10-01T08:00:00Z'),
  entry('scoring', 'Scored the sourdough loaf deeper with the new lame; at lower hydration the ear finally opened.', '2026-10-02T08:00:00Z'),
  entry('hydration', 'Sourdough at 78% hydration was soup; held back 30g water and the loaf came together.', '2026-10-03T08:00:00Z'),
  entry('deploy', 'Coolify deploy failed because the build pack ignored the env var for the port.', '2026-10-04T08:00:00Z'),
  entry('running', 'Long run of 28 km, calf tight after 22 km. Need more gels on the back half.', '2026-10-05T08:00:00Z'),
]

const views = [
  { kind: 'organizer', slug: 'sourdough-baking', title: 'Sourdough Baking', sources: ['starter', 'scoring', 'hydration'], format: 'md' as const, body: '- notes', updatedAt: '2026-10-05T09:00:00Z' },
]

const throwing: ModelBackend = {
  async complete() {
    throw new Error('hints must never call the model')
  },
}

let cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

/** No kinds, so nothing but the request under test can reach the backend. */
async function hintsServer(backend: ModelBackend = throwing) {
  const z = new Zephyr({ dataDir: await seedDataDir({ entries, views }), backend, kinds: {} })
  await z.start()
  const server = serve(z, { port: 0, distDir: '/nonexistent' })
  cleanup.push(() => server.stop(true), () => z.stop())
  return (query: string) => fetch(`http://127.0.0.1:${server.port}/hints?${query}`)
}

const ask = async (get: (q: string) => Promise<Response>, draft: string, extra = '') => {
  const res = await get(`q=${encodeURIComponent(draft)}${extra}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { hints: { entryId: string; text: string; at: string; score: number; topic: unknown }[] }).hints
}

test('the related entry comes first, with its text, time, score and organizer topic', async () => {
  const get = await hintsServer()
  const hints = await ask(get, 'The rye starter is sluggish; the next sourdough bake needs a longer bulk ferment.')
  expect(hints[0]).toEqual({
    entryId: 'starter',
    text: entries[0]!.text,
    at: '2026-10-01T08:00:00Z',
    score: expect.any(Number),
    topic: { slug: 'sourdough-baking', title: 'Sourdough Baking' },
  })
  expect(hints.map((h) => h.entryId)).not.toContain('running')
})

test('an entry no organizer view cites has a null topic', async () => {
  const get = await hintsServer()
  const hints = await ask(get, 'coolify deploy keeps failing on the port')
  expect(hints).toEqual([expect.objectContaining({ entryId: 'deploy', topic: null })])
})

test('limit caps the number of hints', async () => {
  const get = await hintsServer()
  expect((await ask(get, 'sourdough loaf', '&limit=5')).length).toBe(2)
  expect((await ask(get, 'sourdough loaf', '&limit=1')).length).toBe(1)
})

test('a one-word draft gets no hints, even when an entry matches it', async () => {
  const get = await hintsServer()
  expect(await ask(get, 'coolify')).toEqual([])
  expect(await ask(get, 'the coolify')).toEqual([])
  expect(await ask(get, 'coolify deploy')).not.toEqual([])
})

test('a hit that shares only one word with the draft falls under the threshold', async () => {
  const weak = (await relevanceBackends.tfidf().rank('sourdough loaf', entries)).scored.find((s) => s.id === 'starter')!
  expect(weak.score).toBeGreaterThan(0)
  const get = await hintsServer()
  expect((await ask(get, 'sourdough loaf', '&limit=5')).map((h) => h.entryId).sort()).toEqual(['hydration', 'scoring'])
})

test('an entry whose text is the draft itself is not offered back', async () => {
  const get = await hintsServer()
  const ids = (await ask(get, `  ${entries[2]!.text} `, '&limit=5')).map((h) => h.entryId)
  expect(ids).toContain('scoring')
  expect(ids).not.toContain('hydration')
})

test('missing q or a limit outside 1..5 is a 400 with a JSON error', async () => {
  const get = await hintsServer()
  for (const query of ['limit=3', 'q=sourdough+loaf&limit=0', 'q=sourdough+loaf&limit=6', 'q=sourdough+loaf&limit=two', 'q=sourdough+loaf&limit=']) {
    const res = await get(query)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: expect.any(String) })
  }
})

test('hints never call the model', async () => {
  let calls = 0
  const get = await hintsServer({
    async complete() {
      calls++
      throw new Error('hints must never call the model')
    },
  })
  expect(await ask(get, 'sourdough loaf')).not.toEqual([])
  expect(await ask(get, 'x')).toEqual([])
  expect(calls).toBe(0)
})

/** Gives every entry the same score and says it came from `backend`, which counts minRelatedScore and up as related. */
const scoring = (backend: string, score: number, minRelatedScore: number): RelevanceBackend => ({
  async rank(_q, docs) {
    return { backend, scored: docs.map((d) => ({ id: d.id, score })), minRelatedScore }
  },
})

test('hints apply the threshold of the backend that answered', async () => {
  const hint = async (relevance: RelevanceBackend) => (await hintsFor('sourdough loaf', 5, entries, [], relevance)).hints
  expect(await hint(scoring('a', 0.5, 0.14))).toHaveLength(5)
  expect(await hint(scoring('b', 0.5, 0.8))).toEqual([])
  expect(await hint(scoring('b', 0.85, 0.8))).toHaveLength(5)
  expect(await hint(scoring('a', 0.1, 0.14))).toEqual([])
})

test('hints from a fallback answer apply the fallback threshold, not the primary one', async () => {
  const down: RelevanceBackend = { rank: () => Promise.reject(new Error('endpoint down')) }
  const reply = await hintsFor('sourdough loaf', 5, entries, [], withFallback(down, scoring('fallback', 0.5, 0.14), { timeoutMs: 1000, cooldownMs: 30_000 }))
  expect(reply.backend).toBe('fallback')
  expect(reply.hints).toHaveLength(5)
})

test('a backend with no measured threshold gives no hints', async () => {
  expect((await hintsFor('sourdough loaf', 5, entries, [], scoring('unmeasured', 0.99, Infinity))).hints).toEqual([])
})
