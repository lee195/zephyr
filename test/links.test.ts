import { expect, test } from 'bun:test'
import { Zephyr } from '../src/zephyr'
import { started } from './desk'

const related = (s: Awaited<ReturnType<typeof started>>) =>
  Object.fromEntries(s.z.listViews().filter((v) => v.kind === 'organizer').map((v) => [v.slug, v.related ?? []]))

test('linkTopics puts the link on both topics without touching the pages, again changes nothing, unlinkTopics takes it off both', async () => {
  const s = await started()
  for (const n of ['garden: beans', 'garden: peas', 'garden: kale', 'garden: chard', 'compost: worms', 'trip: train']) await s.note(n)
  expect(s.d.calls).toContain('draw GARDEN')
  const before = s.z.listViews().map((v) => [v.id, v.updatedAt])
  const draws = s.d.calls.filter((c) => c.startsWith('draw')).length

  expect(await s.adjust({ op: 'linkTopics', a: 'garden', b: 'compost' })).toMatchObject({ ok: true, written: ['organizer/garden', 'organizer/compost'], rewrites: [] })
  expect(related(s)).toEqual({ garden: ['compost'], compost: ['garden'], trip: [] })
  expect(await s.adjust({ op: 'linkTopics', a: 'compost', b: 'trip' })).toMatchObject({ ok: true })
  expect(related(s)).toEqual({ garden: ['compost'], compost: ['garden', 'trip'], trip: ['compost'] })
  expect(s.z.listViews().map((v) => [v.id, v.updatedAt])).toEqual(before)
  expect(s.d.calls.filter((c) => c.startsWith('draw')).length).toBe(draws)
  expect(s.view('organizer/garden')!.appendsSinceWrite).toBe(3)

  expect(await s.adjust({ op: 'linkTopics', a: 'garden', b: 'compost' })).toMatchObject({ ok: true, written: [] })
  expect(await s.adjust({ op: 'unlinkTopics', a: 'compost', b: 'garden' })).toMatchObject({ ok: true, written: ['organizer/compost', 'organizer/garden'] })
  expect(related(s)).toEqual({ garden: [], compost: ['trip'], trip: ['compost'] })
  expect(await s.adjust({ op: 'unlinkTopics', a: 'compost', b: 'garden' })).toMatchObject({ ok: true, written: [] })

  expect(await s.adjust({ op: 'linkTopics', a: 'garden', b: 'garden' })).toMatchObject({ ok: false, error: 'a topic cannot be linked to itself' })
  expect(await s.adjust({ op: 'linkTopics', a: 'garden', b: 'nowhere' })).toMatchObject({ ok: false, error: 'no topic nowhere' })
  s.z.stop()
})

test('a run that rewrites a linked topic keeps its links', async () => {
  const s = await started()
  await s.note('garden: beans', 'compost: worms')
  await s.adjust({ op: 'linkTopics', a: 'garden', b: 'compost' })
  await s.note('garden: peas => Vegetable garden')
  await s.adjust({ op: 'editNote', noteId: 'e1', text: 'garden: broad beans' })
  expect(s.view('organizer/garden')).toMatchObject({ title: 'Vegetable garden', related: ['compost'] })
  expect(s.d.calls).toContain('rewrite garden')
  s.z.stop()
})

test('a merge moves a link to the target, and a deleted topic leaves every list, through tombstone and purge alike', async () => {
  const s = await started()
  await s.note('garden: beans', 'compost: worms', 'soil: loam', 'trip: train', 'camping: tent', 'trip: bus')
  await s.adjust({ op: 'linkTopics', a: 'garden', b: 'compost' })
  await s.adjust({ op: 'linkTopics', a: 'soil', b: 'compost' })
  await s.adjust({ op: 'linkTopics', a: 'trip', b: 'camping' })
  await s.adjust({ op: 'linkTopics', a: 'garden', b: 'trip' })

  expect(await s.adjust({ op: 'mergeTopics', from: 'compost', into: 'soil' })).toMatchObject({ ok: true })
  expect(related(s)).toEqual({ garden: ['soil', 'trip'], soil: ['garden'], trip: ['camping', 'garden'], camping: ['trip'] })
  expect(await s.adjust({ op: 'linkTopics', a: 'compost', b: 'trip' })).toMatchObject({ ok: false, error: 'topic compost was merged into soil' })

  expect(await s.adjust({ op: 'tombstoneNote', noteId: 'e5' })).toMatchObject({ ok: true, deleted: ['organizer/camping'] })
  expect(related(s)).toEqual({ garden: ['soil', 'trip'], soil: ['garden'], trip: ['garden'] })

  expect(await s.adjust({ op: 'purgeNote', noteId: 'e1', confirm: 'purge e1' })).toMatchObject({ ok: true, deleted: expect.arrayContaining(['organizer/garden']) })
  await s.z.idle()
  expect(related(s)).toEqual({ soil: [], trip: [] })
  s.z.stop()
})

test('links survive a restart, and a link left on one side by a crash is put back on the other', async () => {
  const s = await started()
  await s.note('garden: beans', 'compost: worms', 'trip: train')
  await s.adjust({ op: 'linkTopics', a: 'garden', b: 'compost' })
  s.z.stop()
  const view = s.view('organizer/trip')!
  await s.z.store.writeView({ ...view, related: ['garden'] })

  const again = await started({ dir: s.dir })
  expect(related(again)).toEqual({ garden: ['compost', 'trip'], compost: ['garden'], trip: ['garden'] })
  again.z.stop()
})

test('a related list on disk holding a merged-away or unknown slug is put right on start', async () => {
  const s = await started()
  await s.note('garden: beans', 'compost: worms', 'soil: loam')
  await s.adjust({ op: 'mergeTopics', from: 'compost', into: 'soil' })
  s.z.stop()
  await s.z.store.writeView({ ...s.view('organizer/garden')!, related: ['compost', 'gone'] })
  const z = new Zephyr({ dataDir: s.dir, backend: s.d.backend, retryDelaysMs: [] })
  await z.start()
  await z.idle()
  expect(z.listViews().filter((v) => v.kind === 'organizer').map((v) => [v.slug, v.related])).toEqual(
    expect.arrayContaining([
      ['garden', ['soil']],
      ['soil', ['garden']],
    ]),
  )
  z.stop()
})
