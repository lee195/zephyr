import { readdir } from 'node:fs/promises'
import { expect, test } from 'bun:test'
import { embeddingBackend } from '../src/embedding'
import { tempDir } from './helpers'

/** A fake /embeddings endpoint: a text's vector counts its a, b and c characters. Keeps every input batch it was sent. */
function fakeEndpoint() {
  const batches: string[][] = []
  const fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] }
    batches.push(input)
    const data = input.map((text, index) => ({ index, embedding: ['a', 'b', 'c'].map((ch) => text.split(ch).length - 1) }))
    return Response.json({ data })
  }) as typeof globalThis.fetch
  return { fetch, batches, sentTexts: () => batches.flat() }
}

const docs = [
  { id: 'A', text: 'aaa' },
  { id: 'B', text: 'bbb' },
  { id: 'C', text: 'ccc' },
]

const backend = (cacheDir: string, fetch: typeof globalThis.fetch, model = 'gemma') =>
  embeddingBackend({ baseUrl: 'http://embed.test/v1', model, apiKey: 'k', cacheDir, fetch })

test('ranks by cosine similarity and names itself in the ranking', async () => {
  const end = fakeEndpoint()
  const ranking = await backend(await tempDir(), end.fetch).rank('aab', docs)
  expect(ranking.backend).toBe('embedding-gemma')
  expect(ranking.scored.map((s) => s.id)).toEqual(['A', 'B', 'C'])
  expect(ranking.scored[0]!.score).toBeCloseTo(2 / Math.sqrt(5), 5)
  expect(ranking.scored[2]!.score).toBe(0)
})

test('a cached doc is never sent again, in the same process or after a restart', async () => {
  const dir = await tempDir()
  const end = fakeEndpoint()
  await backend(dir, end.fetch).rank('abc', docs)
  expect(end.sentTexts().sort()).toEqual(['aaa', 'abc', 'bbb', 'ccc'])

  const same = fakeEndpoint()
  const b = backend(dir, same.fetch)
  await b.rank('abc', docs)
  await b.rank('cab', docs)
  expect(same.batches).toEqual([['abc'], ['cab']])
})

test('a doc whose text changed is embedded again, and only that doc', async () => {
  const dir = await tempDir()
  await backend(dir, fakeEndpoint().fetch).rank('abc', docs)
  const end = fakeEndpoint()
  await backend(dir, end.fetch).rank('abc', [docs[0]!, { id: 'B', text: 'bbbc' }, docs[2]!])
  expect(end.sentTexts().sort()).toEqual(['abc', 'bbbc'])
})

test('concurrent rankings of the same new docs embed each doc once', async () => {
  const end = fakeEndpoint()
  const b = backend(await tempDir(), end.fetch)
  await Promise.all([b.rank('abc', docs), b.rank('cab', docs)])
  expect(end.sentTexts().filter((t) => t === 'aaa')).toEqual(['aaa'])
})

test('each backend id keeps its own vectors: another model embeds every doc itself', async () => {
  const dir = await tempDir()
  await backend(dir, fakeEndpoint().fetch, 'gemma').rank('abc', docs)
  const other = fakeEndpoint()
  const ranking = await backend(dir, other.fetch, 'other-model').rank('abc', docs)
  expect(ranking.backend).toBe('embedding-other-model')
  expect(other.sentTexts().sort()).toEqual(['aaa', 'abc', 'bbb', 'ccc'])
  expect((await readdir(dir)).sort()).toEqual(['embedding-gemma.jsonl', 'embedding-other-model.jsonl'])
})

test('an endpoint error rejects the ranking and caches nothing', async () => {
  const dir = await tempDir()
  const failing = (async () => new Response('upstream unreachable', { status: 503 })) as unknown as typeof fetch
  await expect(backend(dir, failing).rank('abc', docs)).rejects.toThrow('503')
  const end = fakeEndpoint()
  await backend(dir, end.fetch).rank('abc', docs)
  expect(end.sentTexts().sort()).toEqual(['aaa', 'abc', 'bbb', 'ccc'])
})
