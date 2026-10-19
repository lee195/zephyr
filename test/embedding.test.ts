import { readdir } from 'node:fs/promises'
import { expect, spyOn, test } from 'bun:test'
import { embeddingBackend } from '../src/embedding'
import { hintsFor } from '../src/hints'
import { eventually, fakeEmbeddings, tempDir } from './helpers'

const docs = [
  { id: 'A', text: 'aaa' },
  { id: 'B', text: 'bbb' },
  { id: 'C', text: 'ccc' },
]

const backend = (cacheDir: string, fetch: typeof globalThis.fetch, model = 'gemma') =>
  embeddingBackend({ baseUrl: 'http://embed.test/v1', model, apiKey: 'k', cacheDir, fetch })

test('ranks prepared docs by cosine similarity and names itself in the ranking', async () => {
  const b = backend(await tempDir(), fakeEmbeddings().fetch)
  await b.prepare!(docs)
  const ranking = await b.rank('aab', docs)
  expect(ranking.backend).toBe('embedding-gemma')
  expect(ranking.partial).toBeUndefined()
  expect(ranking.scored.map((s) => s.id)).toEqual(['A', 'B', 'C'])
  expect(ranking.scored[0]!.score).toBeCloseTo(2 / Math.sqrt(5), 5)
  expect(ranking.scored[2]!.score).toBe(0)
})

test('a ranking never waits on doc embedding: it scores the cached docs, is partial, and embeds the rest', async () => {
  const end = fakeEmbeddings()
  const b = backend(await tempDir(), end.fetch)
  await b.prepare!([docs[0]!])
  end.hold((input) => input.includes('bbb'))
  const ranking = await b.rank('aab', docs)
  expect(ranking).toEqual({ backend: 'embedding-gemma', scored: [{ id: 'A', score: expect.any(Number) }], partial: true, minRelatedScore: Infinity })
  expect(b.pending!()).toBe(2)
  end.release()
  await eventually(() => b.pending!() === 0)
  expect((await b.rank('aab', docs)).scored.map((s) => s.id)).toEqual(['A', 'B', 'C'])
})

test('a cached doc is never sent again, in the same process or after a restart', async () => {
  const dir = await tempDir()
  const end = fakeEmbeddings()
  await backend(dir, end.fetch).prepare!(docs)
  expect(end.sentTexts().sort()).toEqual(['aaa', 'bbb', 'ccc'])

  const same = fakeEmbeddings()
  const b = backend(dir, same.fetch)
  await b.prepare!(docs)
  await b.rank('abc', docs)
  await b.rank('cab', docs)
  expect(same.batches).toEqual([['abc'], ['cab']])
})

test('a doc whose text changed is embedded again, and only that doc', async () => {
  const dir = await tempDir()
  await backend(dir, fakeEmbeddings().fetch).prepare!(docs)
  const end = fakeEmbeddings()
  await backend(dir, end.fetch).prepare!([docs[0]!, { id: 'B', text: 'bbbc' }, docs[2]!])
  expect(end.sentTexts()).toEqual(['bbbc'])
})

test('concurrent prepares of the same new docs embed each doc once, and both wait for it', async () => {
  const end = fakeEmbeddings()
  const b = backend(await tempDir(), end.fetch)
  await Promise.all([b.prepare!(docs), b.prepare!(docs)])
  expect(end.sentTexts()).toEqual(['aaa', 'bbb', 'ccc'])
  expect((await b.rank('abc', docs)).partial).toBeUndefined()
})

test('each backend id keeps its own vectors: another model embeds every doc itself', async () => {
  const dir = await tempDir()
  await backend(dir, fakeEmbeddings().fetch, 'gemma').prepare!(docs)
  const other = fakeEmbeddings()
  await backend(dir, other.fetch, 'other-model').prepare!(docs)
  expect(other.sentTexts().sort()).toEqual(['aaa', 'bbb', 'ccc'])
  expect((await readdir(dir)).sort()).toEqual(['embedding-gemma.jsonl', 'embedding-other-model.jsonl'])
})

test('an endpoint error rejects prepare and rank, and caches nothing', async () => {
  const dir = await tempDir()
  const failing = (async () => new Response('upstream unreachable', { status: 503 })) as unknown as typeof fetch
  const down = backend(dir, failing)
  await expect(down.prepare!(docs)).rejects.toThrow('503')
  await expect(down.rank('abc', docs)).rejects.toThrow('503')
  const end = fakeEmbeddings()
  await backend(dir, end.fetch).prepare!(docs)
  expect(end.sentTexts().sort()).toEqual(['aaa', 'bbb', 'ccc'])
})

test('each batch of a large prepare is usable as soon as it lands', async () => {
  const end = fakeEmbeddings()
  const b = backend(await tempDir(), end.fetch)
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `d${i}`, text: `a${i}` }))
  end.hold((input) => input.includes('a299'))
  const preparing = b.prepare!(many)
  await eventually(() => end.batches.some((input) => input.includes('a299')))
  const ranking = await b.rank('aa', many)
  expect(ranking.partial).toBe(true)
  expect(ranking.scored.length).toBeGreaterThan(0)
  end.release()
  await preparing
  expect((await b.rank('aa', many)).scored).toHaveLength(300)
})

test('a ranking carries the measured threshold of its model', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const b = backend(await tempDir(), fakeEmbeddings().fetch, 'embeddinggemma2')
    expect((await b.rank('aab', docs)).minRelatedScore).toBe(0.8)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

test('a model with no measured threshold warns once, when built, and gives no hints', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const b = backend(await tempDir(), fakeEmbeddings().fetch, 'unmeasured')
    await b.prepare!(docs)
    const entries = docs.map((d) => ({ ...d, harness: 'claude-code', sessionId: 's', at: '2026-10-19T08:00:00Z' }))
    const reply = await hintsFor('aab aab', 5, entries, [], b)
    await hintsFor('aab aab', 5, entries, [], b)
    expect(reply).toMatchObject({ backend: 'embedding-unmeasured', hints: [] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('embedding model unmeasured has no measured threshold; hints are off')
  } finally {
    warn.mockRestore()
  }
})
