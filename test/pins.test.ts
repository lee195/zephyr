import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { Pins, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { validateRewrite } from '../src/kinds/organizer'
import { Zephyr } from '../src/zephyr'
import { doneRun, entry, scripted, seedDataDir } from './helpers'

const topic = (slug: string, sources: string[], pins?: Pins): Omit<View, 'id'> => ({
  kind: 'organizer',
  slug,
  title: slug.toUpperCase(),
  sources,
  format: 'md',
  body: `about ${slug}`,
  updatedAt: '2026-10-19T09:00:00.000Z',
  ...(pins && { pins }),
})

/** Garden cites g1 and had g2 taken off it; trip had camping merged in and its title pinned; n1 waits to be filed. */
const pinnedDir = () =>
  seedDataDir({
    entries: [entry('g1'), entry('g2'), entry('t1'), entry('n1')],
    runs: [doneRun('organizer', ['g1', 'g2', 't1'])],
    views: [topic('garden', ['g1'], { excluded: ['g2'] }), topic('trip', ['g2', 't1'], { title: true, aliases: ['camping'] })],
  })

async function filed(...ops: object[]) {
  const dir = await pinnedDir()
  const z = new Zephyr({ dataDir: dir, backend: scripted({ ops }).backend, kinds: { organizer: kinds.organizer! }, retryDelaysMs: [] })
  await z.start()
  await z.idle()
  const page = (slug: string) => z.listViews().find((v) => v.id === `organizer/${slug}`)
  return { dir, z, page, run: z.listRuns().at(-1)! }
}

test('a reply that cites an excluded note on its old page drops that citation with a reason; the rest applies', async () => {
  const { page, run } = await filed({ op: 'append', slug: 'garden', sources: ['g2', 'n1'], body: 'more' })
  expect(page('garden')!.sources).toEqual(['g1', 'n1'])
  expect(run).toMatchObject({ status: 'done', dropped: ['append garden: excluded from this topic: g2'] })
})

test('an op citing only an excluded note is dropped whole, with the reason', async () => {
  const { page, run } = await filed({ op: 'append', slug: 'garden', sources: ['g2'], body: 'g2 again' }, { op: 'write', slug: 'misc', title: 'Misc', sources: ['n1'], body: 'n1' })
  expect(page('garden')).toMatchObject({ sources: ['g1'], body: 'about garden' })
  expect(run.dropped).toEqual(['append garden: excluded from this topic: g2'])
})

test('a write to a merged-away slug lands on its target as an append without the title, with a reason', async () => {
  const { page, run } = await filed({ op: 'write', slug: 'camping', title: 'Camping', sources: ['n1'], body: 'tent' })
  expect(page('camping')).toBeUndefined()
  expect(page('trip')).toMatchObject({ title: 'TRIP', sources: ['g2', 't1', 'n1'], body: 'about trip\n\ntent' })
  expect(run).toMatchObject({ status: 'done', dropped: ['write camping: merged into trip, so applied there as an append without its title'] })
  expect(run.uncovered).toBeUndefined()
})

test('a retitle of a pinned page, by append or by write, keeps the pinned title and says why', async () => {
  const byAppend = await filed({ op: 'append', slug: 'trip', title: 'Holidays', sources: ['n1'], body: 'more' })
  expect(byAppend.page('trip')).toMatchObject({ title: 'TRIP', body: 'about trip\n\nmore' })
  expect(byAppend.page('trip')!.pastTitles).toBeUndefined()
  expect(byAppend.run.dropped).toEqual(['append trip: title is pinned, "Holidays" dropped'])

  const write = { op: 'write', slug: 'trip', title: 'Holidays', sources: ['n1'], body: '# TRIP\n\nall of it' }
  const dir = await pinnedDir()
  const relevance = { rank: async (_q: string, docs: { id: string }[]) => ({ backend: 'fixed', scored: docs.map((d) => ({ id: d.id, score: 1 })), minRelatedScore: 0, minLinkScore: Infinity }) }
  const z = new Zephyr({ dataDir: dir, backend: scripted({ ops: [write] }).backend, kinds: { organizer: kinds.organizer! }, relevance, retryDelaysMs: [] })
  await z.start()
  await z.idle()
  expect(z.listViews().find((v) => v.slug === 'trip')).toMatchObject({ title: 'TRIP', body: 'all of it' })
  expect(z.listRuns().at(-1)!.dropped).toEqual(['write trip: title is pinned, "Holidays" dropped'])
})

test('a run that writes a pinned page keeps its pins, in memory and on disk', async () => {
  const { dir, page } = await filed({ op: 'append', slug: 'garden', sources: ['n1'], body: 'more' })
  expect(page('garden')!.pins).toEqual({ excluded: ['g2'] })
  expect(JSON.parse(await readFile(join(dir, 'views/organizer/garden.json'), 'utf8')).pins).toEqual({ excluded: ['g2'] })
})

test('a rewrite of a pinned page keeps its title and says why', () => {
  const page: View = { id: 'organizer/trip', kind: 'organizer', slug: 'trip', title: 'Trip', sources: ['t1'], format: 'md', body: 'old', updatedAt: 't', pins: { title: true } }
  const result = validateRewrite({ slug: 'trip', title: 'Holidays', sources: ['t1'], body: 'new' }, page, new Set(['t1']))
  expect(result).toEqual({ ok: true, write: { slug: 'trip', title: 'Trip', sources: ['t1'], format: 'md', body: 'new' }, dropped: ['rewrite trip: title is pinned, "Holidays" dropped'] })
})
