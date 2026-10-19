import { expect, test } from 'bun:test'
import { parseConfig } from '../src/config'
import { relevanceBackends, type RelevanceName } from '../src/relevance'
import { fakeEmbeddings, tempDir } from './helpers'

const docs = [
  { id: 'bread', text: 'sourdough starter fed with rye' },
  { id: 'deploy', text: 'coolify deploy failed on the port' },
]

const expected: Record<RelevanceName, { backend: string; minRelatedScore: number }> = {
  tfidf: { backend: 'tfidf', minRelatedScore: 0.14 },
  embedding: { backend: 'embedding-embeddinggemma2', minRelatedScore: 0.8 },
}

test('the registry builds every registered backend from config', async () => {
  const urls: string[] = []
  const end = fakeEmbeddings()
  const fetch = ((url: string, init: RequestInit) => (urls.push(url), end.fetch(url, init))) as typeof globalThis.fetch
  for (const name of Object.keys(relevanceBackends) as RelevanceName[]) {
    const config = parseConfig({ ZEPHYR_RELEVANCE: name, DEEPSEEK_API_KEY: 'k', ZEPHYR_VLLM_URL: 'http://embed.test/v1' })
    const backend = relevanceBackends[config.relevance](config, { cacheDir: await tempDir(), fetch })
    await backend.prepare?.(docs)
    const ranking = await backend.rank('sourdough starter', docs)
    expect(ranking).toMatchObject(expected[name])
    expect(ranking.scored.map((s) => s.id).sort()).toEqual(['bread', 'deploy'])
  }
  expect(urls.every((u) => u === 'http://embed.test/v1/embeddings')).toBe(true)
  expect(urls.length).toBeGreaterThan(0)
})

test('a backend that needs the key refuses to build without it, naming the key', () => {
  const config = parseConfig({ ZEPHYR_RELEVANCE: 'embedding' })
  expect(() => relevanceBackends.embedding(config, { cacheDir: '/nonexistent' })).toThrow('DEEPSEEK_API_KEY is not set')
})

test('an unknown relevance name fails at parse time, listing the registered names', () => {
  const registered = Object.keys(relevanceBackends).join(', ')
  expect(registered).toBe('tfidf, embedding')
  expect(() => parseConfig({ ZEPHYR_RELEVANCE: 'bm25' })).toThrow(`unknown ZEPHYR_RELEVANCE: bm25; registered: ${registered}`)
  expect(() => parseConfig({ ZEPHYR_RELEVANCE: 'toString' })).toThrow('unknown ZEPHYR_RELEVANCE: toString')
})

test('defaults: the vLLM endpoint, embedding relevance, and an empty key counts as none', () => {
  expect(parseConfig({ DEEPSEEK_API_KEY: '' })).toMatchObject({
    vllmUrl: 'https://llm.example.com/v1',
    apiKey: undefined,
    modelBackend: 'vllm',
    chatModel: 'deepseek-v4-flash-fast',
    embedModel: 'embeddinggemma2',
    relevance: 'embedding',
    port: 7317,
  })
})
