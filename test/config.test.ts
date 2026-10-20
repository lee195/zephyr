import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { chatCompletion } from '../src/backends'
import { parseConfig, type Env } from '../src/config'
import { relevanceBackends, type RelevanceName } from '../src/relevance'
import { fakeEmbeddings, tempDir } from './helpers'

/** The LLM settings as .env.example sets them, with a key in the variable they name. */
const LLM_ENV: Env = {
  ZEPHYR_CHAT_URL: 'http://chat.test/v1',
  ZEPHYR_CHAT_MODEL: 'chat-model',
  ZEPHYR_CHAT_KEY_VAR: 'CHAT_KEY',
  ZEPHYR_EMBED_URL: 'http://embed.test/v1',
  ZEPHYR_EMBED_MODEL: 'embeddinggemma2',
  ZEPHYR_EMBED_KEY_VAR: 'EMBED_KEY',
  CHAT_KEY: 'chat-secret',
  EMBED_KEY: 'embed-secret',
}

const docs = [
  { id: 'bread', text: 'sourdough starter fed with rye' },
  { id: 'deploy', text: 'coolify deploy failed on the port' },
]

const expected: Record<RelevanceName, { backend: string; minRelatedScore: number; minLinkScore: number }> = {
  tfidf: { backend: 'tfidf', minRelatedScore: 0.14, minLinkScore: Infinity },
  embedding: { backend: 'embedding-embeddinggemma2', minRelatedScore: 0.8, minLinkScore: 0.73 },
}

/** KEY=value lines, as Bun reads a .env file; comments and blank lines skipped. */
function readEnvFile(text: string): Env {
  return Object.fromEntries(text.split('\n').flatMap((line) => (/^\s*(#|$)/.test(line) ? [] : [[line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]])))
}

test('the registry builds every registered backend from config, the embedding one from the embed endpoint and its key', async () => {
  const calls: { url: string; auth: string | null }[] = []
  const end = fakeEmbeddings()
  const fetch = ((url: string, init: RequestInit) => (calls.push({ url, auth: new Headers(init.headers).get('authorization') }), end.fetch(url, init))) as typeof globalThis.fetch
  for (const name of Object.keys(relevanceBackends) as RelevanceName[]) {
    const config = parseConfig({ ...LLM_ENV, ZEPHYR_RELEVANCE: name })
    const backend = relevanceBackends[config.relevance](config, { cacheDir: await tempDir(), fetch })
    await backend.prepare?.(docs)
    const ranking = await backend.rank('sourdough starter', docs)
    expect(ranking).toMatchObject(expected[name])
    expect(ranking.scored.map((s) => s.id).sort()).toEqual(['bread', 'deploy'])
  }
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every((c) => c.url === 'http://embed.test/v1/embeddings' && c.auth === 'Bearer embed-secret')).toBe(true)
})

test('chat goes to the chat endpoint with the chat key and model', async () => {
  const sent: { url: string; auth: string | null; body: any }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
    return Response.json({ choices: [] })
  }) as typeof globalThis.fetch
  try {
    await chatCompletion(parseConfig(LLM_ENV), { messages: [] })
  } finally {
    globalThis.fetch = real
  }
  expect(sent).toEqual([{ url: 'http://chat.test/v1/chat/completions', auth: 'Bearer chat-secret', body: { model: 'chat-model', messages: [] } }])
})

test('a key comes from the variable its *_KEY_VAR names; unset or empty counts as none, and the error names that variable', async () => {
  const config = parseConfig({ ...LLM_ENV, CHAT_KEY: '', EMBED_KEY: undefined })
  expect(config.chat).toEqual({ url: 'http://chat.test/v1', model: 'chat-model', keyVar: 'CHAT_KEY' })
  expect(config.embed!.apiKey).toBeUndefined()
  expect(() => relevanceBackends.embedding(config, { cacheDir: '/nonexistent' })).toThrow('EMBED_KEY is not set')
  await expect(chatCompletion(config, {})).rejects.toThrow('CHAT_KEY missing')
})

test('each LLM setting is required, pointing at .env.example; the embed ones only for embedding relevance', () => {
  for (const name of ['ZEPHYR_CHAT_URL', 'ZEPHYR_CHAT_MODEL', 'ZEPHYR_CHAT_KEY_VAR', 'ZEPHYR_EMBED_URL', 'ZEPHYR_EMBED_MODEL', 'ZEPHYR_EMBED_KEY_VAR'])
    expect(() => parseConfig({ ...LLM_ENV, [name]: undefined })).toThrow(`${name} is not set; copy .env.example to .env`)
  const local = parseConfig({ ZEPHYR_CHAT_URL: 'u', ZEPHYR_CHAT_MODEL: 'm', ZEPHYR_CHAT_KEY_VAR: 'K', ZEPHYR_RELEVANCE: 'tfidf' })
  expect(local.embed).toBeUndefined()
})

test('the renamed variables fail loudly instead of being ignored', () => {
  expect(() => parseConfig({ ...LLM_ENV, ZEPHYR_VLLM_URL: 'http://old' })).toThrow('ZEPHYR_VLLM_URL was renamed; set ZEPHYR_CHAT_URL and ZEPHYR_EMBED_URL instead')
  expect(() => parseConfig({ ...LLM_ENV, ZEPHYR_MODEL: 'old' })).toThrow('ZEPHYR_MODEL was renamed; set ZEPHYR_CHAT_MODEL instead')
})

test('an unknown backend or relevance name fails at parse time, listing the registered names', () => {
  expect(Object.keys(relevanceBackends).join(', ')).toBe('tfidf, embedding')
  expect(() => parseConfig({ ...LLM_ENV, ZEPHYR_RELEVANCE: 'bm25' })).toThrow('unknown ZEPHYR_RELEVANCE: bm25; registered: tfidf, embedding')
  expect(() => parseConfig({ ...LLM_ENV, ZEPHYR_RELEVANCE: 'toString' })).toThrow('unknown ZEPHYR_RELEVANCE: toString')
  expect(() => parseConfig({ ...LLM_ENV, ZEPHYR_BACKEND: 'gpt' })).toThrow('unknown ZEPHYR_BACKEND: gpt; registered: vllm')
})

test(".env.example parses to today's settings: the shared endpoint for chat and embeddings, keyed by DEEPSEEK_API_KEY", async () => {
  const example = readEnvFile(await Bun.file(join(import.meta.dir, '../.env.example')).text())
  expect(example).not.toHaveProperty('DEEPSEEK_API_KEY')
  const config = parseConfig({ ...example, DEEPSEEK_API_KEY: 'k' })
  expect(config).toMatchObject({
    modelBackend: 'vllm',
    chat: { url: 'https://llm.example.com/v1', model: 'deepseek-v4-flash-fast', keyVar: 'DEEPSEEK_API_KEY', apiKey: 'k' },
    relevance: 'embedding',
    embed: { url: 'https://llm.example.com/v1', model: 'embeddinggemma2', keyVar: 'DEEPSEEK_API_KEY', apiKey: 'k' },
    port: 7317,
    sweepMinutes: 30,
  })
  expect(config.dataDir).toEndWith('/data')
})

test('the sweep interval takes any positive number of minutes and refuses anything else, naming the variable', () => {
  expect(parseConfig({ ...LLM_ENV, ZEPHYR_SWEEP_MINUTES: '0.5' }).sweepMinutes).toBe(0.5)
  expect(parseConfig({ ...LLM_ENV, ZEPHYR_SWEEP_MINUTES: '120' }).sweepMinutes).toBe(120)
  for (const bad of ['0', '-5', 'often', '', 'Infinity']) expect(() => parseConfig({ ...LLM_ENV, ZEPHYR_SWEEP_MINUTES: bad })).toThrow(`ZEPHYR_SWEEP_MINUTES must be a positive number: ${bad}`)
})
