import { expect, test } from 'bun:test'
import { relevanceBackends, withFallback, type RelevanceBackend, type RelevanceDoc } from '../src/relevance'

const tfidf = relevanceBackends.tfidf!()

const docs = [
  { id: 'espresso', text: 'Dialed the grinder two steps finer; the shot ran 28 seconds and tasted less sour.' },
  { id: 'bread', text: 'Sourdough starter fed with rye doubled in six hours. Bulk ferment ran long, crumb was tight.' },
  { id: 'deploys', text: 'Coolify deploy failed because the build pack ignored the env var for the port.' },
  { id: 'running', text: 'Long run of 28 km, calf tight after 22 km. Need more gels on the back half.' },
]

test('tfidf ranks the obviously related doc first', async () => {
  const { scored: ranked } = await tfidf.rank('The rye STARTER is sluggish; next sourdough bake needs a longer bulk ferment.', docs)
  expect(ranked[0]!.id).toBe('bread')
  expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
})

test('tfidf returns every doc once, unrelated ones at zero', async () => {
  const { scored: ranked } = await tfidf.rank('sourdough', docs)
  expect(ranked.map((r) => r.id).sort()).toEqual(['bread', 'deploys', 'espresso', 'running'])
  expect(ranked.filter((r) => r.score === 0).map((r) => r.id).sort()).toEqual(['deploys', 'espresso', 'running'])
})

test('tfidf ignores punctuation, case, and tokens shorter than three characters', async () => {
  const { scored: ranked } = await tfidf.rank('a an of 28 km -- !!', docs)
  expect(ranked.every((r) => r.score === 0)).toBe(true)
  expect((await tfidf.rank('COOLIFY!', docs)).scored[0]!.id).toBe('deploys')
})

test('tfidf scores a doc that shares only function words with the query at zero', async () => {
  const { scored: ranked } = await tfidf.rank('Because the weather was awful, more of us stayed in after lunch with the kids.', docs)
  expect(ranked.every((r) => r.score === 0)).toBe(true)
})

const fixed = (backend: string, minRelatedScore = 0.5): RelevanceBackend & { calls: number } => {
  const b = {
    calls: 0,
    async rank(_query: string, ds: RelevanceDoc[]) {
      b.calls++
      return { backend, scored: ds.map((d) => ({ id: d.id, score: 1 })), minRelatedScore }
    },
  }
  return b
}
const failing = (): RelevanceBackend & { calls: number } => {
  const b = {
    calls: 0,
    async rank(): Promise<never> {
      b.calls++
      throw new Error('endpoint down')
    },
  }
  return b
}
const hanging = (): RelevanceBackend => ({ rank: () => new Promise(() => {}) })

test('withFallback answers from the primary while it works', async () => {
  const fb = fixed('fallback')
  const r = withFallback(fixed('primary'), fb, { timeoutMs: 1000, cooldownMs: 30_000 })
  expect((await r.rank('q', docs)).backend).toBe('primary')
  expect(fb.calls).toBe(0)
})

test('withFallback answers from the fallback when the primary fails', async () => {
  const r = withFallback(failing(), fixed('fallback'), { timeoutMs: 1000, cooldownMs: 30_000 })
  const ranking = await r.rank('q', docs)
  expect(ranking.backend).toBe('fallback')
  expect(ranking.scored.map((s) => s.id).sort()).toEqual(['bread', 'deploys', 'espresso', 'running'])
})

test('withFallback answers from the fallback when the primary takes longer than the timeout', async () => {
  const r = withFallback(hanging(), fixed('fallback'), { timeoutMs: 20, cooldownMs: 30_000 })
  const started = performance.now()
  expect((await r.rank('q', docs)).backend).toBe('fallback')
  expect(performance.now() - started).toBeLessThan(500)
})

test('after a failure the primary is skipped until the cooldown ends', async () => {
  let now = 0
  const primary = failing()
  const r = withFallback(primary, fixed('fallback'), { timeoutMs: 1000, cooldownMs: 30_000, now: () => now })
  await r.rank('q', docs)
  now = 29_999
  expect((await r.rank('q', docs)).backend).toBe('fallback')
  expect(primary.calls).toBe(1)
  now = 30_000
  await r.rank('q', docs)
  expect(primary.calls).toBe(2)
})

test('a ranking carries the threshold of the backend that answered it', async () => {
  expect((await tfidf.rank('sourdough', docs)).minRelatedScore).toBe(0.14)
  expect((await withFallback(fixed('primary', 0.8), tfidf, { timeoutMs: 1000, cooldownMs: 30_000 }).rank('sourdough', docs)).minRelatedScore).toBe(0.8)
  const fellBack = await withFallback(failing(), tfidf, { timeoutMs: 1000, cooldownMs: 30_000 }).rank('sourdough', docs)
  expect(fellBack).toMatchObject({ backend: 'tfidf', minRelatedScore: 0.14 })
})
