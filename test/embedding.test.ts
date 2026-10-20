import { appendFile, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, spyOn, test } from 'bun:test'
import { hintsFor } from '../src/hints'
import { entry, eventually, fakeEmbeddings, tempDir, testEmbedding } from './helpers'

const docs = [
  { id: 'A', text: 'aaa' },
  { id: 'B', text: 'bbb' },
  { id: 'C', text: 'ccc' },
]

test('ranks prepared docs by cosine similarity and names itself in the ranking', async () => {
  const b = testEmbedding(await tempDir(), fakeEmbeddings().fetch)
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
  const b = testEmbedding(await tempDir(), end.fetch)
  await b.prepare!([docs[0]!])
  end.hold((input) => input.includes('bbb'))
  const ranking = await b.rank('aab', docs)
  expect(ranking).toEqual({ backend: 'embedding-gemma', scored: [{ id: 'A', score: expect.any(Number) }], partial: true, minRelatedScore: Infinity, minLinkScore: Infinity })
  expect(b.pending!()).toBe(2)
  end.release()
  await eventually(() => b.pending!() === 0)
  expect((await b.rank('aab', docs)).scored.map((s) => s.id)).toEqual(['A', 'B', 'C'])
})

test('a cached doc is never sent again, in the same process or after a restart', async () => {
  const dir = await tempDir()
  const end = fakeEmbeddings()
  await testEmbedding(dir, end.fetch).prepare!(docs)
  expect(end.sentTexts().sort()).toEqual(['aaa', 'bbb', 'ccc'])

  const same = fakeEmbeddings()
  const b = testEmbedding(dir, same.fetch)
  await b.prepare!(docs)
  await b.rank('abc', docs)
  await b.rank('cab', docs)
  expect(same.batches).toEqual([['abc'], ['cab']])
})

test('a doc whose text changed is embedded again, and only that doc', async () => {
  const dir = await tempDir()
  await testEmbedding(dir, fakeEmbeddings().fetch).prepare!(docs)
  const end = fakeEmbeddings()
  await testEmbedding(dir, end.fetch).prepare!([docs[0]!, { id: 'B', text: 'bbbc' }, docs[2]!])
  expect(end.sentTexts()).toEqual(['bbbc'])
})

test('concurrent prepares of the same new docs embed each doc once, and both wait for it', async () => {
  const end = fakeEmbeddings()
  const b = testEmbedding(await tempDir(), end.fetch)
  await Promise.all([b.prepare!(docs), b.prepare!(docs)])
  expect(end.sentTexts()).toEqual(['aaa', 'bbb', 'ccc'])
  expect((await b.rank('abc', docs)).partial).toBeUndefined()
})

test('each backend id keeps its own vectors: another model embeds every doc itself', async () => {
  const dir = await tempDir()
  await testEmbedding(dir, fakeEmbeddings().fetch, 'gemma').prepare!(docs)
  const other = fakeEmbeddings()
  await testEmbedding(dir, other.fetch, 'other-model').prepare!(docs)
  expect(other.sentTexts().sort()).toEqual(['aaa', 'bbb', 'ccc'])
  expect((await readdir(dir)).sort()).toEqual(['embedding-gemma.jsonl', 'embedding-other-model.jsonl'])
})

test('an endpoint error rejects prepare and rank, and caches nothing', async () => {
  const dir = await tempDir()
  const failing = (async () => new Response('upstream unreachable', { status: 503 })) as unknown as typeof fetch
  const down = testEmbedding(dir, failing)
  await expect(down.prepare!(docs)).rejects.toThrow('503')
  await expect(down.rank('abc', docs)).rejects.toThrow('503')
  const end = fakeEmbeddings()
  await testEmbedding(dir, end.fetch).prepare!(docs)
  expect(end.sentTexts().sort()).toEqual(['aaa', 'bbb', 'ccc'])
})

test('each batch of a large prepare is usable as soon as it lands', async () => {
  const end = fakeEmbeddings()
  const b = testEmbedding(await tempDir(), end.fetch)
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
    const b = testEmbedding(await tempDir(), fakeEmbeddings().fetch, 'embeddinggemma2')
    expect((await b.rank('aab', docs)).minRelatedScore).toBe(0.8)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

test('a model with no measured threshold warns once, when built, and gives no hints', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const b = testEmbedding(await tempDir(), fakeEmbeddings().fetch, 'unmeasured')
    await b.prepare!(docs)
    const entries = docs.map((d) => entry(d.id, d.text))
    const reply = await hintsFor('aab aab', 5, entries, [], b)
    await hintsFor('aab aab', 5, entries, [], b)
    expect(reply).toMatchObject({ backend: 'embedding-unmeasured', hints: [] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('embedding model unmeasured has no measured threshold; hints are off')
  } finally {
    warn.mockRestore()
  }
})

const cacheFile = (dir: string) => join(dir, 'embedding-gemma.jsonl')
const linesOf = async (dir: string) => (await readFile(cacheFile(dir), 'utf8')).split('\n').filter(Boolean)

test('compaction keeps one line per live doc with its latest vector, and a fresh backend on the file needs no doc embedded', async () => {
  const dir = await tempDir()
  await testEmbedding(dir, fakeEmbeddings().fetch).prepare!(docs)
  // A later line for the same text wins on load: here it points aaa along c.
  const key = `gemma:${new Bun.CryptoHasher('sha256').update('aaa').digest('hex')}`
  const later = Buffer.from(new Float32Array([0, 0, 9]).buffer).toString('base64')
  await appendFile(cacheFile(dir), `${JSON.stringify({ key, v: later })}\n{"key":"torn`)
  expect(await linesOf(dir)).toHaveLength(5)

  const b = testEmbedding(dir, fakeEmbeddings().fetch)
  const compaction = await b.compact!([docs[0]!, docs[2]!])
  expect(compaction.before.lines).toBe(5)
  expect(compaction.after.lines).toBe(2)
  expect(compaction.after.bytes).toBe((await stat(cacheFile(dir))).size)
  expect(await linesOf(dir)).toHaveLength(2)

  const end = fakeEmbeddings()
  const fresh = testEmbedding(dir, end.fetch)
  await fresh.prepare!([docs[0]!, docs[2]!])
  const ranking = await fresh.rank('ccc', [docs[0]!, docs[2]!])
  expect(end.batches).toEqual([['ccc']])
  expect(ranking.scored.map((s) => [s.id, Math.round(s.score)])).toEqual([['A', 1], ['C', 1]])
  await fresh.prepare!([docs[1]!])
  expect(end.batches.at(-1)).toEqual(['bbb'])
})

test('a second compaction with the same live docs leaves the file untouched', async () => {
  const dir = await tempDir()
  const b = testEmbedding(dir, fakeEmbeddings().fetch)
  await b.prepare!(docs)
  await b.compact!([docs[0]!])
  const first = await stat(cacheFile(dir))
  await Bun.sleep(20)
  const again = await b.compact!([docs[0]!])
  const second = await stat(cacheFile(dir))
  expect(again.before).toEqual(again.after)
  expect([second.size, second.mtimeMs]).toEqual([first.size, first.mtimeMs])
})

test('a doc whose embedding lands during a compaction is still on disk after it', async () => {
  const dir = await tempDir()
  const end = fakeEmbeddings()
  const b = testEmbedding(dir, end.fetch)
  await b.prepare!(docs)
  const late = { id: 'D', text: 'abcabc' }
  end.hold((input) => input.includes(late.text))
  const preparing = b.prepare!([late])
  await eventually(() => end.batches.some((input) => input.includes(late.text)))
  const compacting = b.compact!([docs[0]!, late])
  end.release()
  await Promise.all([preparing, compacting])
  expect(await linesOf(dir)).toHaveLength(2)

  const after = fakeEmbeddings()
  await testEmbedding(dir, after.fetch).prepare!([docs[0]!, late])
  expect(after.batches).toEqual([])
})
