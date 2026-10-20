import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, setSystemTime, test } from 'bun:test'
import type { ChatMessage, ModelBackend, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { checkAscii, checkSvg, parseDiagram } from '../src/kinds/visualizer'
import { Zephyr } from '../src/zephyr'
import { doneRun, entry, eventually, gate, filesUnder, payloadOf, seedDataDir, tempDir } from './helpers'

const organizerAndVisualizer = { organizer: kinds.organizer!, visualizer: kinds.visualizer! }

const svgOf = (title: string) => `<svg viewBox="0 0 100 20"><text x="2" y="14">${title}</text></svg>`

/**
 * Plays both kinds. As organizer it files an entry "<slug>: text" under topic <slug>, writing or
 * appending as the page requires; "<slug>: text => Title" appends with that new title. As visualizer it draws the topic's title, optionally held until released.
 * Asked to rewrite a topic, it makes the page one line per note.
 */
function world() {
  const drawn: string[] = []
  const held = gate()
  let diagram: (title: string) => unknown = (title) => ({ format: 'svg', body: svgOf(title) })
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = payloadOf(messages)
      if ('notes' in payload)
        return { json: { slug: payload.slug, title: payload.title, sources: payload.notes.map((n: any) => n.id), body: payload.notes.map((n: any) => `- ${n.text}`).join('\n') } }
      if (!('newEntries' in payload)) {
        drawn.push(payload.title)
        await held.pass()
        return { json: diagram(payload.title) }
      }
      const known = new Set<string>([...payload.openTopics.map((t: any) => t.slug), ...payload.topicIndex.map((l: string) => l.split(' | ')[0])])
      const ops = payload.newEntries.map((e: any) => {
        const [slug, rest] = e.text.split(': ')
        const [text, retitle] = rest.split(' => ')
        const op = known.has(slug) ? { op: 'append', ...(retitle && { title: retitle }) } : { op: 'write', title: slug.toUpperCase() }
        known.add(slug)
        return { ...op, slug, sources: [e.id], body: text }
      })
      return { json: { ops } }
    },
  }
  return {
    backend,
    drawn,
    hold: () => held.hold(),
    release: held.release,
    replyWith: (fn: typeof diagram) => (diagram = fn),
  }
}

async function started(dir?: string) {
  const w = world()
  const z = new Zephyr({ dataDir: dir ?? (await tempDir()), backend: w.backend, kinds: organizerAndVisualizer, retryDelaysMs: [] })
  await z.start()
  let n = 0
  const note = async (text: string) => {
    await z.ingest([entry(`e${++n}`, text)])
    await z.idle()
  }
  return { z, w, note }
}

const diagramOf = (z: Zephyr, slug: string) => z.listViews().find((v) => v.id === `visualizer/${slug}`)

test('a topic is drawn once it reaches four sources, not before', async () => {
  const dir = await tempDir()
  const { z, w, note } = await started(dir)
  for (const t of ['venue', 'catering', 'music']) await note(`party: ${t}`)
  expect(w.drawn).toEqual([])
  expect(await filesUnder(join(dir, 'views'))).toEqual(['organizer'])

  await note('party: invitations')
  expect(w.drawn).toEqual(['PARTY'])
  const topic = z.listViews().find((v) => v.id === 'organizer/party')!
  expect(diagramOf(z, 'party')).toMatchObject({ kind: 'visualizer', format: 'svg', sources: topic.sources, derivedFrom: { id: topic.id, updatedAt: topic.updatedAt } })
  expect(await readFile(join(dir, 'views/visualizer/party.svg'), 'utf8')).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><text x="2" y="14">PARTY</text></svg>',
  )
  expect(z.listRuns().find((r) => r.kind === 'visualizer')).toMatchObject({ entryIds: [], viewIds: ['organizer/party'], status: 'done' })
})

test('a drawn topic is redrawn when it changes, and not when another topic changes', async () => {
  const { w, note } = await started()
  for (let i = 0; i < 4; i++) await note(`party: item ${i}`)
  expect(w.drawn).toEqual(['PARTY'])

  await note('garden: tomatoes')
  expect(w.drawn).toEqual(['PARTY'])

  await note('party: cake')
  expect(w.drawn).toEqual(['PARTY', 'PARTY'])
})

test('a drawn topic retitled by an append is redrawn under its new title', async () => {
  const { z, w, note } = await started()
  for (let i = 0; i < 4; i++) await note(`party: item ${i}`)
  await note('party: cake => Summer Party')
  expect(w.drawn).toEqual(['PARTY', 'Summer Party'])
  expect(diagramOf(z, 'party')).toMatchObject({ title: 'Summer Party', derivedFrom: { id: 'organizer/party' } })
})

test('changes to a topic while its diagram is drawn coalesce into one redraw; other topics get their own run', async () => {
  const { z, w } = await started()
  const ids = ['p1', 'p2', 'p3', 'p4', 'g1', 'g2', 'g3', 'g4']
  await z.ingest(ids.slice(0, 4).map((id) => entry(id, `party: ${id}`)))
  w.hold()
  await eventually(() => w.drawn.length === 1)
  for (const id of ['p5', 'p6', 'p7']) {
    await z.ingest([entry(id, `party: ${id}`)])
    await eventually(() => z.listViews().find((v) => v.id === 'organizer/party')!.sources.includes(id))
  }
  await z.ingest(ids.slice(4).map((id) => entry(id, `garden: ${id}`)))
  await eventually(() => z.listViews().some((v) => v.id === 'organizer/garden'))
  w.release()
  await z.idle()

  expect(w.drawn.sort()).toEqual(['GARDEN', 'PARTY', 'PARTY'])
  expect(z.listRuns().filter((r) => r.kind === 'visualizer').map((r) => r.viewIds![0]).sort()).toEqual(['organizer/garden', 'organizer/party', 'organizer/party'])
  const party = z.listViews().find((v) => v.id === 'organizer/party')!
  expect(diagramOf(z, 'party')?.derivedFrom?.updatedAt).toBe(party.updatedAt)
})

test('a drawn topic that is rewritten is redrawn from the rewritten page', async () => {
  const { z, w, note } = await started()
  for (let i = 0; i < 6; i++) await note(`party: item ${i}`)
  expect(w.drawn).toHaveLength(3)
  await z.sweep()
  await z.idle()

  const party = z.listViews().find((v) => v.id === 'organizer/party')!
  expect(party.body).toStartWith('- party: item 0')
  expect(w.drawn).toHaveLength(4)
  expect(diagramOf(z, 'party')?.derivedFrom).toEqual({ id: party.id, updatedAt: party.updatedAt })
})

test('a topic that changes in the same millisecond it was drawn is still redrawn', async () => {
  setSystemTime(new Date('2026-10-19T12:00:00.000Z'))
  try {
    const { w, note } = await started()
    for (let i = 0; i < 4; i++) await note(`party: item ${i}`)
    await note('party: cake')
    expect(w.drawn).toEqual(['PARTY', 'PARTY'])
  } finally {
    setSystemTime()
  }
})

test('a retry of a failed drawing makes no call when a later run already drew the topic', async () => {
  const w = world()
  let calls = 0
  w.replyWith((title) => (++calls === 1 ? { format: 'svg', body: '<svg/>' } : { format: 'svg', body: svgOf(title) }))
  const z = new Zephyr({ dataDir: await tempDir(), backend: w.backend, kinds: organizerAndVisualizer, retryDelaysMs: [300] })
  await z.start()
  await z.ingest(['a', 'b', 'c', 'd'].map((t, i) => entry(`p${i}`, `party: ${t}`)))
  await eventually(() => z.listRuns().some((r) => r.kind === 'visualizer' && r.status === 'failed'))
  await z.ingest([entry('p4', 'party: cake')])
  await z.idle()

  expect(w.drawn).toEqual(['PARTY', 'PARTY'])
  expect(z.listRuns().filter((r) => r.kind === 'visualizer').map((r) => [r.status, r.attempt])).toEqual([['failed', 1], ['done', 1], ['done', 2]])
})

test('the visualizer writes only under views/visualizer and leaves the topic untouched', async () => {
  const dir = await tempDir()
  const { z, note } = await started(dir)
  for (let i = 0; i < 4; i++) await note(`party: item ${i}`)
  const topicBody = await readFile(join(dir, 'views/organizer/party.md'), 'utf8')

  expect(await filesUnder(join(dir, 'views'))).toEqual(['organizer', 'visualizer'])
  expect(await filesUnder(join(dir, 'views/visualizer'))).toEqual(['party.json', 'party.svg'])
  expect(await filesUnder(join(dir, 'views/organizer'))).toEqual(['party.json', 'party.md'])
  expect(topicBody).toBe(z.listViews().find((v) => v.id === 'organizer/party')!.body)
  expect(z.listViews().filter((v) => v.kind === 'visualizer').map((v) => v.id)).toEqual(['visualizer/party'])
})

test('an invalid diagram fails the run and writes nothing', async () => {
  const dir = await tempDir()
  const { z, w, note } = await started(dir)
  w.replyWith(() => ({ format: 'svg', body: '<svg><rect/></svg>' }))
  for (let i = 0; i < 4; i++) await note(`party: item ${i}`)
  expect(z.listRuns().find((r) => r.kind === 'visualizer')).toMatchObject({ status: 'failed', error: 'invalid reply: svg root has no viewBox' })
  expect(await filesUnder(join(dir, 'views/visualizer'))).toEqual([])
})

test('a diagram redrawn as ASCII replaces its SVG file', async () => {
  const dir = await tempDir()
  const { w, note } = await started(dir)
  for (let i = 0; i < 4; i++) await note(`party: item ${i}`)
  w.replyWith(() => ({ format: 'ascii', body: '[party] --> [cake]' }))
  await note('party: cake')
  expect(await filesUnder(join(dir, 'views/visualizer'))).toEqual(['party.json', 'party.txt'])
})

const topic = (slug: string, sources: number, updatedAt: string): Omit<View, 'id'> => ({
  kind: 'organizer',
  slug,
  title: slug.toUpperCase(),
  format: 'md',
  body: `about ${slug}`,
  sources: Array.from({ length: sources }, (_, i) => `${slug}${i}`),
  updatedAt,
})

const diagram = (slug: string, drawnFrom: string): Omit<View, 'id'> => ({
  kind: 'visualizer',
  slug,
  title: slug.toUpperCase(),
  format: 'svg',
  body: svgOf(slug),
  sources: [],
  updatedAt: '2026-10-19T12:00:00.000Z',
  derivedFrom: { id: `organizer/${slug}`, updatedAt: drawnFrom },
})

test('on start, exactly the topics whose diagram is missing or stale are drawn', async () => {
  const entries = ['stale', 'fresh', 'missing', 'small'].flatMap((s) => [0, 1, 2, 3].map((i) => entry(`${s}${i}`)))
  const dir = await seedDataDir({
    entries,
    runs: [doneRun('organizer', entries.map((e) => e.id))],
    views: [
      topic('stale', 4, '2026-10-19T10:00:00.000Z'),
      diagram('stale', '2026-10-19T09:00:00.000Z'),
      topic('fresh', 4, '2026-10-19T10:00:00.000Z'),
      diagram('fresh', '2026-10-19T10:00:00.000Z'),
      topic('missing', 4, '2026-10-19T10:00:00.000Z'),
      topic('small', 3, '2026-10-19T10:00:00.000Z'),
    ],
  })
  const { z, w } = await started(dir)
  await z.idle()
  expect(w.drawn.sort()).toEqual(['MISSING', 'STALE'])
})

test('the visualizer is shown one topic page: its title and body, nothing else', async () => {
  const sent: ChatMessage[][] = []
  const w = world()
  const backend: ModelBackend = { complete: (m, o) => (sent.push(m), w.backend.complete(m, o)) }
  const z = new Zephyr({ dataDir: await tempDir(), backend, kinds: organizerAndVisualizer })
  await z.start()
  await z.ingest([entry('e0', 'garden: tomatoes')])
  await z.ingest(['a', 'b', 'c', 'd'].map((t, i) => entry(`p${i}`, `party: ${t}`)))
  await z.idle()

  const drawRequests = sent.map(payloadOf).filter((p) => !('newEntries' in p))
  expect(drawRequests).toEqual([{ title: 'PARTY', body: z.listViews().find((v) => v.id === 'organizer/party')!.body }])
})

const svg = (inner: string, attrs = ' viewBox="0 0 10 10"') => `<svg${attrs}>${inner}</svg>`
const rejects = (body: string) => {
  const r = checkSvg(body)
  return r.ok ? null : r.error
}

test('svg validation accepts one well-formed root with a viewBox and adds missing namespaces', () => {
  expect(checkSvg(`<?xml version="1.0"?>\n${svg('<g><rect width="1" height="1"/><!-- c --><text>a &amp; b</text></g>')}`)).toEqual({
    ok: true,
    diagram: { format: 'svg', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><rect width="1" height="1"/><!-- c --><text>a &amp; b</text></g></svg>` },
  })
  const linked = checkSvg(svg('<use xlink:href="#a"/>', ' xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"'))
  expect(linked.ok && linked.diagram.body).toBe('<svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><use xlink:href="#a"/></svg>')
})

test('svg validation rejects a missing viewBox, a wrong or second root, bad nesting, and more than 100 KB', () => {
  expect(rejects(svg('', ' width="10"'))).toBe('svg root has no viewBox')
  expect(rejects('<div viewBox="0 0 1 1"></div>')).toBe('root element is <div>, not <svg>')
  expect(rejects(svg('') + svg(''))).toBe('svg has more than one root element')
  expect(rejects(svg('<g><rect></g></rect>'))).toBe('svg closes <g> that is not open')
  expect(rejects('<svg viewBox="0 0 1 1"><g>')).toBe('svg leaves <g> unclosed')
  expect(rejects(svg('<rect width=1/>'))).toStartWith('svg is not well-formed')
  expect(rejects(`Here is your diagram: ${svg('')}`)).toBe('svg has text outside its root')
  expect(rejects(svg(`<text>${'x'.repeat(100 * 1024)}</text>`))).toBe('svg is larger than 100 KB')
  expect(rejects(svg(`<text>${'x'.repeat(100 * 1024 - 60)}</text>`))).toBeNull()
})

test('ascii validation allows 100 columns and 60 lines, and no more', () => {
  expect(checkAscii(`\n${'-'.repeat(100)}\n`)).toEqual({ ok: true, diagram: { format: 'ascii', body: '-'.repeat(100) } })
  expect(checkAscii('─'.repeat(100)).ok).toBe(true)
  expect(checkAscii('-'.repeat(101))).toEqual({ ok: false, error: 'ascii diagram is 101 columns wide, more than 100' })
  expect(checkAscii(Array(60).fill('|').join('\n')).ok).toBe(true)
  expect(checkAscii(Array(61).fill('|').join('\n'))).toEqual({ ok: false, error: 'ascii diagram has 61 lines, more than 60' })
  expect(checkAscii(' \n ').ok).toBe(false)
})

test('a reply that is neither svg nor ascii fails', () => {
  expect(parseDiagram({ format: 'mermaid', body: 'graph TD' }).ok).toBe(false)
  expect(parseDiagram({ format: 'svg' }).ok).toBe(false)
  expect(parseDiagram(null).ok).toBe(false)
})

test('a retry after a refused drawing names the fault to the model; a first attempt names none', async () => {
  const systems: string[] = []
  let calls = 0
  const w = world()
  const backend: ModelBackend = {
    async complete(messages, opts) {
      if (!('newEntries' in payloadOf(messages)) && !('notes' in payloadOf(messages))) systems.push(messages[0]!.content)
      return w.backend.complete(messages, opts)
    },
  }
  w.replyWith((title) => (++calls === 1 ? { format: 'svg', body: '<svg width=10>' } : { format: 'svg', body: svgOf(title) }))
  const z = new Zephyr({ dataDir: await tempDir(), backend, kinds: organizerAndVisualizer, retryDelaysMs: [10] })
  await z.start()
  await z.ingest(['a', 'b', 'c', 'd'].map((t, i) => entry(`p${i}`, `party: ${t}`)))
  await eventually(() => z.listRuns().some((r) => r.kind === 'visualizer' && r.status === 'done'))
  const [failed, retried] = z.listRuns().filter((r) => r.kind === 'visualizer')
  expect(failed!.error).toBe('invalid reply: svg is not well-formed at offset 0, at "<svg width=10>"')
  expect(retried).toMatchObject({ attempt: 2, retryAfter: 'svg is not well-formed at offset 0, at "<svg width=10>"' })
  expect(systems[0]).not.toContain('previous reply')
  expect(systems[1]).toContain('Your previous reply for this page was refused: svg is not well-formed at offset 0, at "<svg width=10>". Reply again, without that fault.')
  z.stop()
})

test('svg validation skips a doctype before the root', () => {
  expect(checkSvg(`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${svg('')}`).ok).toBe(true)
})
