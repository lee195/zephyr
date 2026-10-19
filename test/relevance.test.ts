import { expect, test } from 'bun:test'
import { relevanceBackends } from '../src/relevance'

const tfidf = relevanceBackends.tfidf!()

const docs = [
  { id: 'espresso', text: 'Dialed the grinder two steps finer; the shot ran 28 seconds and tasted less sour.' },
  { id: 'bread', text: 'Sourdough starter fed with rye doubled in six hours. Bulk ferment ran long, crumb was tight.' },
  { id: 'deploys', text: 'Coolify deploy failed because the build pack ignored the env var for the port.' },
  { id: 'running', text: 'Long run of 28 km, calf tight after 22 km. Need more gels on the back half.' },
]

test('tfidf ranks the obviously related doc first', () => {
  const ranked = tfidf.rank('The rye STARTER is sluggish; next sourdough bake needs a longer bulk ferment.', docs)
  expect(ranked[0]!.id).toBe('bread')
  expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
})

test('tfidf returns every doc once, unrelated ones at zero', () => {
  const ranked = tfidf.rank('sourdough', docs)
  expect(ranked.map((r) => r.id).sort()).toEqual(['bread', 'deploys', 'espresso', 'running'])
  expect(ranked.filter((r) => r.score === 0).map((r) => r.id).sort()).toEqual(['deploys', 'espresso', 'running'])
})

test('tfidf ignores punctuation, case, and tokens shorter than three characters', () => {
  const ranked = tfidf.rank('a an of 28 km -- !!', docs)
  expect(ranked.every((r) => r.score === 0)).toBe(true)
  expect(tfidf.rank('COOLIFY!', docs)[0]!.id).toBe('deploys')
})
