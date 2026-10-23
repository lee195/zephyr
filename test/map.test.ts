import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, ModelBackend, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { areasOf, MAX_AREAS, parseAreas, renderMap } from '../src/kinds/map'
import { freeTitle } from '../src/kinds/organizer'
import { Zephyr } from '../src/zephyr'
import { entry, payloadOf, tempDir } from './helpers'

const topic = (slug: string, title = slug.toUpperCase()): View => ({ id: `organizer/${slug}`, kind: 'organizer', slug, title, sources: ['e'], format: 'md', body: '', updatedAt: 't' })

/**
 * Plays the organizer and the map. As organizer it files "<slug>: text" under topic <slug>, titled in capitals. As the
 * map it puts every topic in one area per first letter of the slug; maps lists each map call's topic lines.
 */
function notebook() {
  const maps: string[][] = []
  let mapReply = (payload: any): unknown => {
    const groups = new Map<string, string[]>()
    for (const line of payload.topics as string[]) {
      const slug = line.split(' | ')[0]!
      groups.set(slug[0]!, [...(groups.get(slug[0]!) ?? []), slug])
    }
    const spaceOf = (title: string) => payload.currentAreas.find((a: any) => a.title === title)?.space
    return { areas: [...groups].map(([letter, slugs]) => ({ space: spaceOf(`Area ${letter}`), title: `Area ${letter}`, slugs })) }
  }
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = payloadOf(messages)
      if ('currentAreas' in payload) {
        maps.push(payload.topics)
        return { json: mapReply(payload) }
      }
      const known = new Set<string>([...payload.openTopics.map((t: any) => t.slug), ...payload.topicIndex.map((l: string) => l.split(' | ')[0])])
      const ops = payload.newEntries.map((e: any) => {
        const [slug, text] = e.text.split(': ')
        const op = known.has(slug) ? { op: 'append' } : { op: 'write', title: slug.toUpperCase() }
        known.add(slug)
        return { ...op, slug, sources: [e.id], body: text }
      })
      return { json: { ops } }
    },
  }
  return { backend, maps, replyWith: (fn: typeof mapReply) => (mapReply = fn) }
}

async function started() {
  const book = notebook()
  const dir = await tempDir()
  const z = new Zephyr({ dataDir: dir, backend: book.backend, kinds: { organizer: kinds.organizer!, map: kinds.map! }, retryDelaysMs: [] })
  await z.start()
  let n = 0
  const note = async (...texts: string[]) => {
    await z.ingest(texts.map((t) => entry(`e${++n}`, t)))
    await z.idle()
  }
  const placed = async (placement: 'topic' | 'space', text: string) => {
    await z.ingest([{ ...entry(`e${++n}`, text), placement }])
    await z.idle()
  }
  return { z, dir, book, note, placed }
}

const mapOf = (z: Zephyr) => z.listViews().find((v) => v.id === 'map/contents')
/** The areas without their creation times, which tests do not pin down. */
const areasIn = (z: Zephyr) => mapOf(z)?.areas?.map(({ slug, title, topics }) => ({ slug, title, topics }))

test('parseAreas keeps each known topic once, drops unknown ones with a reason, and puts the rest under Other', () => {
  const topics = [topic('garden'), topic('party'), topic('taxes')]
  const result = parseAreas({ areas: [{ title: 'Home', slugs: ['garden', 'nope', 'garden'] }, { title: 'Empty', slugs: ['gone'] }, { title: 'Fun', slugs: ['party'] }] }, topics, [], {}, 'T')
  expect(result).toEqual({
    ok: true,
    areas: [
      { slug: 'home', title: 'Home', topics: [{ slug: 'garden', title: 'GARDEN' }], createdAt: 'T' },
      { slug: 'fun', title: 'Fun', topics: [{ slug: 'party', title: 'PARTY' }], createdAt: 'T' },
      { slug: 'other', title: 'Other', topics: [{ slug: 'taxes', title: 'TAXES' }] },
    ],
    dropped: ['area Home: unknown topic nope', 'area Home: topic garden is already in another area', 'area Empty: unknown topic gone', 'area Empty: no known topics, left out'],
  })
})

test('parseAreas refuses a reply without areas, with too many, or with an untitled one', () => {
  const topics = [topic('garden')]
  expect(parseAreas({}, topics, [])).toMatchObject({ ok: false })
  expect(parseAreas({ areas: Array.from({ length: MAX_AREAS + 1 }, (_, i) => ({ title: `A${i}`, slugs: [] })) }, topics, [])).toMatchObject({ ok: false })
  expect(parseAreas({ areas: [{ title: ' ', slugs: ['garden'] }] }, topics, [])).toMatchObject({ ok: false })
})

test('a space named by the reply keeps its slug and age through a retitle; an unnamed one is new even under an old title', () => {
  const topics = [topic('garden'), topic('party')]
  const current = [{ slug: 'home', title: 'Home', topics: [{ slug: 'garden', title: 'GARDEN' }], createdAt: 'T0' }]
  const kept = parseAreas({ areas: [{ space: 'home', title: 'House and Garden', slugs: ['garden', 'party'] }] }, topics, current, {}, 'T1')
  expect(kept).toMatchObject({ ok: true, areas: [{ slug: 'home', title: 'House and Garden', createdAt: 'T0' }] })
  const fresh = parseAreas({ areas: [{ title: 'Home', slugs: ['garden', 'party'] }] }, topics, current, {}, 'T1')
  expect(fresh).toMatchObject({ ok: true, areas: [{ slug: 'home-2', title: 'Home', createdAt: 'T1' }] })
})

test('pins win over the reply: a pinned title stays, and a pinned topic goes back to its space even when the reply dropped it', () => {
  const topics = [topic('garden'), topic('party'), topic('taxes')]
  const current = [
    { slug: 'home', title: 'My Home', topics: [{ slug: 'garden', title: 'GARDEN' }] },
    { slug: 'money', title: 'Money', topics: [{ slug: 'taxes', title: 'TAXES' }] },
  ]
  const pins = { titles: { home: 'My Home' }, placed: { taxes: 'money' } }
  const result = parseAreas({ areas: [{ space: 'home', title: 'Home', slugs: ['garden', 'taxes'] }, { title: 'Fun', slugs: ['party'] }] }, topics, current, pins, 'T')
  expect(result).toEqual({
    ok: true,
    areas: [
      { slug: 'home', title: 'My Home', topics: [{ slug: 'garden', title: 'GARDEN' }] },
      { slug: 'fun', title: 'Fun', topics: [{ slug: 'party', title: 'PARTY' }], createdAt: 'T' },
      { slug: 'money', title: 'Money', topics: [{ slug: 'taxes', title: 'TAXES' }] },
    ],
    dropped: ['space home: title is pinned, "Home" dropped', 'area My Home: topic taxes is pinned to space money'],
  })
})

test('the map renders as markdown linking each topic page', () => {
  expect(renderMap([{ slug: 'home', title: 'Home', topics: [{ slug: 'garden', title: 'Garden' }, { slug: 'taxes', title: 'Taxes' }] }])).toBe(
    '## Home\n- [Garden](../organizer/garden.md)\n- [Taxes](../organizer/taxes.md)',
  )
})

test('a map drawn before spaces had slugs gets them from its titles', () => {
  const legacy = { ...topic('x'), id: 'map/contents', kind: 'map', areas: [{ title: 'Home', topics: [] }, { title: 'Home', topics: [] }] } as unknown as View
  expect(areasOf(legacy).map((a) => a.slug)).toEqual(['home', 'home-2'])
})

test('a new topic redraws the map, and a note on a topic it already lists makes no map call', async () => {
  const { z, dir, book, note } = await started()
  await note('garden: tomatoes')
  expect(areasIn(z)).toEqual([{ slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'GARDEN' }] }])
  expect(await readFile(join(dir, 'views/map/contents.md'), 'utf8')).toBe('## Area g\n- [GARDEN](../organizer/garden.md)')

  await note('garden: basil')
  expect(book.maps).toHaveLength(1)

  await note('party: venue')
  expect(book.maps).toHaveLength(2)
  expect(mapOf(z)?.areas?.map((a) => a.title).sort()).toEqual(['Area g', 'Area p'])
})

test('several new topics in one run cost one map call', async () => {
  const { z, book, note } = await started()
  await note('garden: tomatoes', 'party: venue', 'taxes: receipts')
  expect(book.maps).toHaveLength(1)
  const mapRuns = z.listRuns().filter((r) => r.kind === 'map')
  expect(mapRuns.map((r) => r.noCall ?? false).sort()).toEqual([false, true, true])
  expect(book.maps[0]!.sort()).toEqual(['garden | GARDEN | 1 notes', 'party | PARTY | 1 notes', 'taxes | TAXES | 1 notes'])
  expect(mapOf(z)?.areas?.flatMap((a) => a.topics.map((t) => t.slug)).sort()).toEqual(['garden', 'party', 'taxes'])
})

test('a renamed topic is listed under its new title, and a merged-away one leaves the map at the next sweep', async () => {
  const { z, book, note } = await started()
  await note('garden: tomatoes', 'grill: charcoal')
  await z.adjust({ op: 'renameTopic', slug: 'garden', title: 'Vegetable Garden' })
  await z.idle()
  expect(areasIn(z)).toEqual([{ slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'Vegetable Garden' }, { slug: 'grill', title: 'GRILL' }] }])

  await z.adjust({ op: 'mergeTopics', from: 'grill', into: 'garden' })
  await z.idle()
  const before = book.maps.length
  await z.sweep()
  await z.idle()
  expect(book.maps).toHaveLength(before + 1)
  expect(areasIn(z)).toEqual([{ slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'Vegetable Garden' }] }])
})

test('the map is no topic: it never shows in hints or the newest note\'s topics', async () => {
  const { z, note } = await started()
  await note('garden: tomatoes and basil in the raised bed')
  expect(mapOf(z)).toBeDefined()
  expect(z.status().lastNote?.topics).toEqual([{ slug: 'garden', title: 'GARDEN' }])
  const { hints } = await z.hints('tomatoes basil raised bed', 5)
  expect(hints.flatMap((h) => h.topics.map((t) => t.slug))).toEqual(['garden'])
})

test('moving a topic to another space pins it there: the next map run that files it elsewhere is overruled', async () => {
  const { z, book, note } = await started()
  await note('garden: tomatoes', 'grill: charcoal', 'party: venue')
  const bySpace = () => Object.fromEntries(areasIn(z)!.map((a) => [a.slug, a.topics.map((t) => t.slug).sort()]))
  expect(bySpace()).toEqual({ 'area-g': ['garden', 'grill'], 'area-p': ['party'] })
  const moved = await z.adjust({ op: 'moveTopicToSpace', slug: 'grill', space: 'area-p' })
  expect(moved).toMatchObject({ ok: true })
  await z.idle()
  expect(bySpace()).toEqual({ 'area-g': ['garden'], 'area-p': ['grill', 'party'] })
  expect(mapOf(z)?.pins?.spaces).toEqual({ placed: { grill: 'area-p' } })

  const calls = book.maps.length
  await note('gazebo: paint it')
  expect(book.maps).toHaveLength(calls + 1)
  expect(bySpace()).toEqual({ 'area-g': ['garden', 'gazebo'], 'area-p': ['grill', 'party'] })
  expect(z.listRuns().find((r) => r.kind === 'map' && r.dropped)?.dropped).toEqual(['area Area g: topic grill is pinned to space area-p'])
})

test('moving a topic to a space by a new title makes that space with a pinned title', async () => {
  const { z, note } = await started()
  await note('garden: tomatoes', 'grill: charcoal')
  await z.adjust({ op: 'moveTopicToSpace', slug: 'grill', space: 'Cooking Outdoors' })
  await z.idle()
  expect(areasIn(z)).toEqual([
    { slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'GARDEN' }] },
    { slug: 'cooking-outdoors', title: 'Cooking Outdoors', topics: [{ slug: 'grill', title: 'GRILL' }] },
  ])
  expect(mapOf(z)?.pins?.spaces).toEqual({ titles: { 'cooking-outdoors': 'Cooking Outdoors' }, placed: { grill: 'cooking-outdoors' } })
})

test('a renamed space keeps the person\'s title when a later map run proposes another', async () => {
  const { z, book, note } = await started()
  await note('garden: tomatoes')
  await z.adjust({ op: 'renameSpace', space: 'area-g', title: 'Backyard' })
  await z.idle()
  expect(areasIn(z)?.[0]).toMatchObject({ slug: 'area-g', title: 'Backyard' })

  book.replyWith((p) => ({ areas: [{ space: 'area-g', title: 'Garden Things', slugs: p.topics.map((l: string) => l.split(' | ')[0]) }] }))
  await note('gazebo: paint it')
  expect(areasIn(z)).toEqual([{ slug: 'area-g', title: 'Backyard', topics: expect.arrayContaining([{ slug: 'garden', title: 'GARDEN' }, { slug: 'gazebo', title: 'GAZEBO' }]) }])
})

test('space ops refuse an unknown topic or space', async () => {
  const { z, note } = await started()
  await note('garden: tomatoes')
  expect(await z.adjust({ op: 'moveTopicToSpace', slug: 'nope', space: 'area-g' })).toMatchObject({ ok: false, error: 'no topic nope' })
  expect(await z.adjust({ op: 'renameSpace', space: 'nope', title: 'X' })).toMatchObject({ ok: false, error: 'no space nope' })
})

const topicSources = (z: Zephyr) => Object.fromEntries(z.listViews().filter((v) => v.kind === 'organizer').map((v) => [v.slug, v.sources]))

test('a note asking for a new topic gets one of its own, even when a topic on its subject exists', async () => {
  const { z, note, placed } = await started()
  await note('garden: tomatoes')
  await placed('topic', 'garden: roses')
  expect(topicSources(z)).toEqual({ garden: ['e1'], 'garden-2': ['e2'] })
  expect(z.listViews().find((v) => v.id === 'organizer/garden-2')?.title).toBe('GARDEN 2')
  expect(z.listRuns().find((r) => r.kind === 'organizer' && r.entryIds[0] === 'e2')?.dropped).toEqual(['write garden-2: a topic is titled "GARDEN" already, so titled "GARDEN 2"'])
})

test('a new topic whose title a topic has already is numbered, ignoring case, within the title cap', () => {
  expect(freeTitle('Garden', ['Sourdough'])).toBe('Garden')
  expect(freeTitle('Garden', ['garden', 'GARDEN 2'])).toBe('Garden 3')
  expect(freeTitle('x'.repeat(80), ['x'.repeat(80)])).toBe(`${'x'.repeat(78)} 2`)
})

test('a note asking for a new topic is filed in a run of its own, apart from the notes that arrive with it', async () => {
  const { z } = await started()
  await z.ingest([entry('e1', 'garden: tomatoes'), { ...entry('e2', 'garden: roses'), placement: 'topic' }, entry('e3', 'garden: beans')])
  await z.idle()
  expect(topicSources(z)).toEqual({ garden: ['e1', 'e3'], 'garden-2': ['e2'] })
})

test('a placed note is neither shown nor citable as context in the runs that file other notes', async () => {
  const dir = await tempDir()
  const seen: string[][] = []
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const p = payloadOf(messages)
      if ('currentAreas' in p) return { json: { areas: [] } }
      seen.push(p.recentEntries.map((e: any) => e.id))
      const ids: string[] = p.newEntries.map((e: any) => e.id)
      // Files the placed note on herbs, and every other run's notes on garden, citing the placed note there as well.
      const [slug, sources] = ids[0] === 'e2' ? ['herbs', ids] : ['garden', [...ids, 'e2']]
      return { json: { ops: [{ op: 'write', slug, title: slug, sources, body: slug }] } }
    },
  }
  const z = new Zephyr({ dataDir: dir, backend, kinds: { organizer: kinds.organizer!, map: kinds.map! }, retryDelaysMs: [] })
  await z.start()
  await z.ingest([entry('e1', 'tomatoes'), { ...entry('e2', 'herb spiral'), placement: 'topic' }])
  await z.idle()
  await z.ingest([entry('e3', 'beans')])
  await z.idle()
  expect(topicSources(z)).toEqual({ garden: ['e1', 'e3'], herbs: ['e2'] })
  expect(seen.flat()).not.toContain('e2')
})

test('a note asking for a new space gets a new topic in a new space titled after it, pinned there', async () => {
  const { z, note, placed } = await started()
  await note('garden: tomatoes')
  await placed('space', 'garden: roses')
  expect(areasIn(z)).toEqual([
    { slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'GARDEN' }] },
    { slug: 'garden-2', title: 'GARDEN 2', topics: [{ slug: 'garden-2', title: 'GARDEN 2' }] },
  ])
  expect(mapOf(z)?.pins?.spaces).toEqual({ titles: { 'garden-2': 'GARDEN 2' }, placed: { 'garden-2': 'garden-2' } })
})

test('a new space asked for before any map exists starts the map, and the next map run places the other topics', async () => {
  const { z, note, placed } = await started()
  await placed('space', 'party: balloons')
  expect(areasIn(z)).toEqual([{ slug: 'party', title: 'PARTY', topics: [{ slug: 'party', title: 'PARTY' }] }])
  await note('garden: tomatoes')
  expect(areasIn(z)).toEqual([
    { slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'GARDEN' }] },
    { slug: 'party', title: 'PARTY', topics: [{ slug: 'party', title: 'PARTY' }] },
  ])
})

test('a fresh move makes a new space even when one has the title\'s slug', async () => {
  const { z, note } = await started()
  await note('garden: tomatoes', 'grill: charcoal')
  await z.adjust({ op: 'moveTopicToSpace', slug: 'grill', space: 'Area g', fresh: true })
  await z.idle()
  expect(areasIn(z)).toEqual([
    { slug: 'area-g', title: 'Area g', topics: [{ slug: 'garden', title: 'GARDEN' }] },
    { slug: 'area-g-2', title: 'Area g', topics: [{ slug: 'grill', title: 'GRILL' }] },
  ])
})
