import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, ModelBackend, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { MAX_AREAS, parseAreas, renderMap } from '../src/kinds/map'
import { Zephyr } from '../src/zephyr'
import { entry, payloadOf, tempDir } from './helpers'

const topic = (slug: string, title = slug.toUpperCase()): View => ({ id: `organizer/${slug}`, kind: 'organizer', slug, title, sources: ['e'], format: 'md', body: '', updatedAt: 't' })

/**
 * Plays the organizer and the map. As organizer it files "<slug>: text" under topic <slug>, titled in capitals. As the
 * map it puts every topic in one area per first letter of the slug; maps lists each map call's topic lines.
 */
function notebook() {
  const maps: string[][] = []
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = payloadOf(messages)
      if ('currentAreas' in payload) {
        maps.push(payload.topics)
        const groups = new Map<string, string[]>()
        for (const line of payload.topics as string[]) {
          const slug = line.split(' | ')[0]!
          groups.set(slug[0]!, [...(groups.get(slug[0]!) ?? []), slug])
        }
        return { json: { areas: [...groups].map(([letter, slugs]) => ({ title: `Area ${letter}`, slugs })) } }
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
  return { backend, maps }
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
  return { z, dir, book, note }
}

const mapOf = (z: Zephyr) => z.listViews().find((v) => v.id === 'map/contents')

test('parseAreas keeps each known topic once, drops unknown ones with a reason, and puts the rest under Other', () => {
  const topics = [topic('garden'), topic('party'), topic('taxes')]
  const result = parseAreas({ areas: [{ title: 'Home', slugs: ['garden', 'nope', 'garden'] }, { title: 'Empty', slugs: ['gone'] }, { title: 'Fun', slugs: ['party'] }] }, topics)
  expect(result).toEqual({
    ok: true,
    areas: [
      { title: 'Home', topics: [{ slug: 'garden', title: 'GARDEN' }] },
      { title: 'Fun', topics: [{ slug: 'party', title: 'PARTY' }] },
      { title: 'Other', topics: [{ slug: 'taxes', title: 'TAXES' }] },
    ],
    dropped: ['area Home: unknown topic nope', 'area Home: topic garden is already in another area', 'area Empty: unknown topic gone', 'area Empty: no known topics, left out'],
  })
})

test('parseAreas refuses a reply without areas, with too many, or with an untitled one', () => {
  const topics = [topic('garden')]
  expect(parseAreas({}, topics)).toMatchObject({ ok: false })
  expect(parseAreas({ areas: Array.from({ length: MAX_AREAS + 1 }, (_, i) => ({ title: `A${i}`, slugs: [] })) }, topics)).toMatchObject({ ok: false })
  expect(parseAreas({ areas: [{ title: ' ', slugs: ['garden'] }] }, topics)).toMatchObject({ ok: false })
})

test('the map renders as markdown linking each topic page', () => {
  expect(renderMap([{ title: 'Home', topics: [{ slug: 'garden', title: 'Garden' }, { slug: 'taxes', title: 'Taxes' }] }])).toBe(
    '## Home\n- [Garden](../organizer/garden.md)\n- [Taxes](../organizer/taxes.md)',
  )
})

test('a new topic redraws the map, and a note on a topic it already lists makes no map call', async () => {
  const { z, dir, book, note } = await started()
  await note('garden: tomatoes')
  expect(mapOf(z)?.areas).toEqual([{ title: 'Area g', topics: [{ slug: 'garden', title: 'GARDEN' }] }])
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
  expect(book.maps[0]!.sort()).toEqual(['garden | GARDEN | 1 notes', 'party | PARTY | 1 notes', 'taxes | TAXES | 1 notes'])
  expect(mapOf(z)?.areas?.flatMap((a) => a.topics.map((t) => t.slug)).sort()).toEqual(['garden', 'party', 'taxes'])
})

test('a renamed topic is listed under its new title, and a merged-away one leaves the map at the next sweep', async () => {
  const { z, book, note } = await started()
  await note('garden: tomatoes', 'grill: charcoal')
  await z.adjust({ op: 'renameTopic', slug: 'garden', title: 'Vegetable Garden' })
  await z.idle()
  expect(mapOf(z)?.areas).toEqual([{ title: 'Area g', topics: [{ slug: 'garden', title: 'Vegetable Garden' }, { slug: 'grill', title: 'GRILL' }] }])

  await z.adjust({ op: 'mergeTopics', from: 'grill', into: 'garden' })
  await z.idle()
  const before = book.maps.length
  await z.sweep()
  await z.idle()
  expect(book.maps).toHaveLength(before + 1)
  expect(mapOf(z)?.areas).toEqual([{ title: 'Area g', topics: [{ slug: 'garden', title: 'Vegetable Garden' }] }])
})

test('the map is no topic: it never shows in hints or the newest note\'s topics', async () => {
  const { z, note } = await started()
  await note('garden: tomatoes and basil in the raised bed')
  expect(mapOf(z)).toBeDefined()
  expect(z.status().lastNote?.topics).toEqual([{ slug: 'garden', title: 'GARDEN' }])
  const { hints } = await z.hints('tomatoes basil raised bed', 5)
  expect(hints.flatMap((h) => h.topics.map((t) => t.slug))).toEqual(['garden'])
})
