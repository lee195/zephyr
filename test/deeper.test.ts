import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { linkPairScores, MAX_SUMMARY_CHARS, pairKey, proposedPairs, validateLinks, type LinkScores } from '../src/deeper'
import type { View } from '../src/domain'
import type { RelevanceBackend } from '../src/relevance'
import { withMcp } from './desk'
import { eventually } from './helpers'

const text = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text)

/** A server whose last review closed after garden, compost and trip were filed; garden and trip then got a note each, and big was made over the rewrite cap. */
async function reviewedThenNoted() {
  const s = await withMcp()
  await s.note('garden: beans', 'compost: worms', 'trip: train')
  await s.call('finish_review', { until: text(await s.call('get_review')).until })
  await s.note('garden: peas', 'trip: bus', `big: ${'x'.repeat(33_000)}`)
  return s
}

test('rewrite_touched_topics marks exactly the topics citing a note since the last review stale, and the rewrite runs take them', async () => {
  const s = await reviewedThenNoted()
  try {
    s.d.hold('rewrite')
    const { result } = await s.rpc('tools/call', { name: 'rewrite_touched_topics', arguments: {} })
    expect(text(result)).toEqual({ queued: ['garden', 'trip'], overCap: ['big'] })
    const stale = () => Object.fromEntries(s.z.listViews().filter((v) => v.kind === 'organizer').map((v) => [v.slug, v.bodyStale ?? false]))
    expect(stale()).toEqual({ garden: true, compost: false, trip: true, big: false })

    s.d.release()
    await s.z.idle()
    expect(s.d.calls.filter((c) => c.startsWith('rewrite'))).toEqual(['rewrite garden', 'rewrite trip'])
    expect(stale()).toEqual({ garden: false, compost: false, trip: false, big: false })
    expect(s.view('organizer/garden')!.body).toBe('- garden: beans\n- garden: peas')
    expect(text(await s.call('get_review')).rewrites.map((r: any) => [r.slug, r.yours])).toEqual([
      ['garden', true],
      ['trip', true],
    ])
  } finally {
    s.close()
  }
})

const summariesIn = async (dir: string) => (await readdir(join(dir, 'summaries')).catch(() => [] as string[])).filter((f) => f.endsWith('.md'))

test('summarize_review returns the model summary of the notes since the last review with its usage, and stores it only with save', async () => {
  const s = await withMcp()
  try {
    await s.note('garden: beans')
    await s.call('finish_review', { until: text(await s.call('get_review')).until })
    await s.note('garden: peas', 'compost: worms')
    const unsaved = text(await s.call('summarize_review'))
    expect(unsaved).toEqual({ since: expect.any(String), until: expect.any(String), notes: 2, leftOut: 0, summary: 'Notes e2,e3.', usage: { promptTokens: 100, completionTokens: 20 } })
    expect(s.d.sent.summary[0].sessionNotes).toEqual([
      { id: 'e2', at: expect.any(String), text: 'garden: peas', topics: ['GARDEN'] },
      { id: 'e3', at: expect.any(String), text: 'compost: worms', topics: ['COMPOST'] },
    ])
    expect(await summariesIn(s.dir)).toEqual([])

    const saved = text(await s.call('summarize_review', { save: true }))
    expect(saved.path).toBe(join(s.dir, 'summaries', `${saved.until.replace(/:/g, '-')}.md`))
    expect(await readFile(saved.path, 'utf8')).toBe(`---\nsince: ${saved.since}\nuntil: ${saved.until}\nnotes: ["e2","e3"]\n---\n\nNotes e2,e3.\n`)
    expect(await s.call('summarize_review', { save: 'yes' })).toMatchObject({ isError: true, content: [{ text: 'save must be a boolean' }] })
  } finally {
    s.close()
  }
})

test('over the cap, a summary is shown the newest notes that fit and reports how many older ones it left out', async () => {
  const s = await withMcp()
  try {
    const long = (slug: string) => `${slug}: ${'y'.repeat(MAX_SUMMARY_CHARS / 2 - slug.length - 2)}`
    await s.note(long('a'), long('b'), long('c'), 'd: short')
    const summary = text(await s.call('summarize_review'))
    expect([summary.notes, summary.leftOut]).toEqual([2, 2])
    expect(s.d.calls.at(-1)).toBe('summary e3,e4')
  } finally {
    s.close()
  }
})

test('summaries run one at a time, and a purge deletes a saved summary of the note even when the summary was in flight', async () => {
  const s = await withMcp()
  try {
    await s.note('garden: beans', 'garden: peas', 'compost: worms')
    const kept = await s.z.summarizeReview(true)
    s.d.hold('summary')
    const first = s.z.summarizeReview(true)
    const second = s.z.summarizeReview(false)
    await eventually(() => s.d.sent.summary.length === 2)
    const purged = s.z.adjust({ op: 'purgeNote', noteId: 'e2', confirm: 'purge e2' })
    await Bun.sleep(20)
    expect(s.d.sent.summary.length).toBe(2)
    s.d.release()
    expect(await first).toMatchObject({ ok: true, notes: 3 })
    expect(await second).toMatchObject({ ok: true, summary: 'Notes e1,e3.' })
    expect(await purged).toMatchObject({ ok: true, purge: { summariesDeleted: 2 } })
    await s.z.idle()
    expect(kept.ok && kept.path).toBeTruthy()
    expect(await summariesIn(s.dir)).toEqual([])
  } finally {
    s.close()
  }
})

test('suggest_links returns the valid pairs with reasons and drops the rest, and changes nothing until link_topics applies one', async () => {
  const s = await withMcp()
  try {
    await s.note('garden: beans', 'compost: worms', 'trip: train', 'soil: loam')
    await s.adjust({ op: 'linkTopics', a: 'garden', b: 'soil' })
    s.d.replies.links = {
      links: [
        { a: 'garden', b: 'compost', reason: 'Compost feeds the garden beds.' },
        { a: 'garden', b: 'nowhere', reason: 'x' },
        { a: 'trip', b: 'trip', reason: 'x' },
        { a: 'soil', b: 'garden', reason: 'x' },
        { a: 'compost', b: 'garden', reason: 'again' },
        { a: 'compost', b: 'soil', reason: '' },
        { a: 'Compost', b: 'soil', reason: 'Worms improve\nthe soil.' },
      ],
    }
    const before = JSON.stringify(s.z.listViews())
    const suggested = text(await s.call('suggest_links'))
    expect(suggested).toEqual({
      links: [
        { a: { slug: 'garden', title: 'GARDEN' }, b: { slug: 'compost', title: 'COMPOST' }, reason: 'Compost feeds the garden beds.' },
        { a: { slug: 'compost', title: 'COMPOST' }, b: { slug: 'soil', title: 'SOIL' }, reason: 'Worms improve' },
      ],
      dropped: [
        'link 1: no such topic: nowhere',
        'link 2: a topic linked to itself',
        'link 3: already linked',
        'link 4: suggested twice',
        'link 5: reason is not one line of at most 200 characters',
      ],
      leftOut: 0,
      usage: { promptTokens: 100, completionTokens: 20 },
    })
    expect(s.d.sent.links[0].topics).toEqual(expect.arrayContaining(['garden | GARDEN | 1 sources', 'trip | TRIP | 1 sources']))
    expect(JSON.stringify(s.z.listViews())).toBe(before)

    expect(text(await s.call('link_topics', { a: 'garden', b: 'compost' }))).toMatchObject({ ok: true, written: ['organizer/garden', 'organizer/compost'] })
    expect(s.view('organizer/compost')!.related).toEqual(['garden'])

    s.d.replies.links = { nope: [] }
    expect(await s.call('suggest_links')).toMatchObject({ isError: true, content: [{ text: 'reply has no links array' }] })
  } finally {
    s.close()
  }
})

test('the review brief names the deeper tools and says a suggested link waits for a yes', async () => {
  const s = await withMcp()
  try {
    await s.note('garden: beans')
    const brief = await (await fetch(`${s.base}/api/review/brief`)).text()
    for (const tool of ['summarize_review', 'rewrite_touched_topics', 'suggest_links']) expect(brief).toContain(tool)
    expect(brief).toContain('link_topics only after the person says yes')
    const { result } = await s.rpc('tools/list')
    const names = new Set(result.tools.map((t: any) => t.name))
    for (const tool of ['summarize_review', 'rewrite_touched_topics', 'suggest_links', 'link_topics', 'unlink_topics']) expect(names.has(tool)).toBe(true)
  } finally {
    s.close()
  }
})

test('a link the model calls weak, or between topics that score too unlike, is dropped with a reason; a backend with no threshold gates none', () => {
  const topic = (slug: string): View => ({ id: `organizer/${slug}`, kind: 'organizer', slug, title: slug, format: 'md', body: '', sources: [], updatedAt: '' })
  const shown = ['bread', 'pizza', 'taxes', 'boats'].map(topic)
  const reply = {
    links: [
      { a: 'bread', b: 'pizza', strength: 'strong', reason: 'both are doughs' },
      { a: 'bread', b: 'taxes', strength: 'weak', reason: 'a stretch' },
      { a: 'pizza', b: 'boats', strength: 'strong', reason: 'boats deliver pizza' },
      { a: 'taxes', b: 'boats', reason: 'boat taxes' },
    ],
  }
  const scores = (backend: string): LinkScores => ({ backend, scores: new Map([[pairKey('bread', 'pizza'), 0.82], [pairKey('pizza', 'boats'), 0.69], [pairKey('taxes', 'boats'), 0.75]]) })
  const gated = validateLinks(reply, shown, scores('embedding-embeddinggemma2'))
  expect(gated.ok && gated.links.map((l) => `${l.a.slug}-${l.b.slug}`)).toEqual(['bread-pizza', 'taxes-boats'])
  expect(gated.ok && gated.dropped).toEqual(['link 1: the model called it weak', 'link 2: topics too dissimilar (0.69 < 0.73)'])
  const ungated = validateLinks(reply, shown, scores('tfidf'))
  expect(ungated.ok && ungated.links.map((l) => l.b.slug)).toEqual(['pizza', 'boats', 'boats'])
  expect(proposedPairs(reply, shown).map(([a, b]) => pairKey(a.slug, b.slug))).toEqual(['bread pizza', 'bread taxes', 'boats pizza', 'boats taxes'])
})

test('pair scores rank each first topic once against its partners, and give up on a partial ranking', async () => {
  const topic = (slug: string, body: string): View => ({ id: `organizer/${slug}`, kind: 'organizer', slug, title: slug, format: 'md', body, sources: [], updatedAt: '' })
  const [bread, pizza, taxes] = [topic('bread', 'sourdough starter flour'), topic('pizza', 'dough flour oven'), topic('taxes', 'receipts deductions')]
  const queries: string[] = []
  const backend = (partial: boolean): RelevanceBackend => ({
    async rank(query, docs) {
      queries.push(query)
      return { backend: 'fake', scored: docs.slice(partial ? 1 : 0).map((d, i) => ({ id: d.id, score: 0.9 - i / 10 })), minRelatedScore: 0.8 }
    },
  })
  const scores = await linkPairScores(backend(false), [[bread, pizza], [bread, taxes], [pizza, taxes]])
  expect(queries).toHaveLength(2)
  expect(Object.fromEntries(scores!.scores)).toEqual({ 'bread pizza': 0.9, 'bread taxes': 0.8, 'pizza taxes': 0.9 })
  expect(await linkPairScores(backend(true), [[bread, pizza], [bread, taxes]])).toBeNull()
})
