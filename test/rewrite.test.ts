import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, ModelBackend, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { validateRewrite } from '../src/kinds/organizer'
import { Zephyr, type ZephyrOptions } from '../src/zephyr'
import { doneRun, entry, eventually, filesUnder, gate, payloadOf, seedDataDir, tempDir } from './helpers'

/**
 * Plays the organizer: "<slug>: text" appends text to topic <slug> (writing it when new), "<slug>! text" writes the
 * page anew. Rewrite requests are answered by rewrite(payload), by default one bullet per note, citing every note.
 * calls lists every call in order: "rewrite <slug>" or "file <entry ids>". hold(when) holds the calls it matches.
 */
function notebook() {
  const rewrites: any[] = []
  const calls: string[] = []
  const held = gate<[payload: any]>()
  let rewrite = (p: any): unknown => ({ slug: p.slug, title: p.title, sources: p.notes.map((n: any) => n.id), body: p.notes.map((n: any) => `- ${n.text}`).join('\n') })
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = payloadOf(messages)
      calls.push('notes' in payload ? `rewrite ${payload.slug}` : `file ${payload.newEntries.map((e: any) => e.id).join(',')}`)
      await held.pass(payload)
      if ('notes' in payload) {
        rewrites.push(payload)
        return { json: rewrite(payload) }
      }
      const known = new Set<string>([...payload.openTopics.map((t: any) => t.slug), ...payload.topicIndex.map((l: string) => l.split(' | ')[0])])
      const ops = payload.newEntries.map((e: any) => {
        const [, slug, mark, body] = /^([a-z-]+)([:!]) (.*)$/.exec(e.text)!
        const op = known.has(slug!) && mark === ':' ? { op: 'append' } : { op: 'write', title: slug!.toUpperCase() }
        known.add(slug!)
        return { ...op, slug, sources: [e.id], body }
      })
      return { json: { ops } }
    },
  }
  return {
    backend,
    rewrites,
    calls,
    hold: (when: (payload: any) => boolean) => held.hold(when),
    release: held.release,
    replyWith: (fn: typeof rewrite) => (rewrite = fn),
  }
}

async function started(opts: Partial<ZephyrOptions> = {}) {
  const book = notebook()
  const dir = opts.dataDir ?? (await tempDir())
  const z = new Zephyr({ dataDir: dir, backend: book.backend, kinds: { organizer: kinds.organizer! }, retryDelaysMs: [], ...opts })
  await z.start()
  let n = 0
  const note = async (text: string) => {
    await z.ingest([entry(`e${++n}`, text)])
    await z.idle()
  }
  return { z, dir, book, note }
}

const topicOf = (z: Zephyr, slug: string) => z.listViews().find((v) => v.id === `organizer/${slug}`)!
const metaOnDisk = async (dir: string, slug: string) => JSON.parse(await readFile(join(dir, `views/organizer/${slug}.json`), 'utf8'))

test('a topic counts the appends since it was last written, and stores the count only when there is one', async () => {
  const { z, dir, note } = await started()
  await note('party: venue')
  expect(topicOf(z, 'party').appendsSinceWrite).toBeUndefined()
  expect(await metaOnDisk(dir, 'party')).not.toHaveProperty('appendsSinceWrite')

  await note('party: cake')
  await note('party: music')
  expect(topicOf(z, 'party').appendsSinceWrite).toBe(2)
  expect(await metaOnDisk(dir, 'party')).toMatchObject({ appendsSinceWrite: 2 })

  await note('party! one page about the party')
  expect(topicOf(z, 'party').appendsSinceWrite).toBeUndefined()
  expect(await metaOnDisk(dir, 'party')).not.toHaveProperty('appendsSinceWrite')

  await note('party: drinks')
  await note('party! one page about the party, drinks included')
  await note('party! one page about the party, drinks included')
  expect(topicOf(z, 'party').appendsSinceWrite).toBeUndefined()
})

const isRewrite = (payload: any) => 'notes' in payload
const isFiling = (payload: any) => !isRewrite(payload)
const rewriteRuns = (z: Zephyr) => z.listRuns().filter((r) => r.viewIds)

/** Topic party, written by its first note and appended to by each of the next `appends`. */
async function partyWith(appends: number, opts: Partial<ZephyrOptions> = {}) {
  const s = await started(opts)
  await s.note('party: venue')
  for (let i = 1; i <= appends; i++) await s.note(`party: item ${i}`)
  return s
}

test('a topic is queued for a rewrite once it has five appends in a row, not at four', async () => {
  const { z, book, note } = await partyWith(4)
  await z.sweep()
  await z.idle()
  expect(book.rewrites).toEqual([])
  expect(rewriteRuns(z)).toEqual([])

  await note('party: item 5')
  await z.sweep()
  await z.idle()
  expect(book.calls.at(-1)).toBe('rewrite party')
  expect(rewriteRuns(z)).toMatchObject([{ kind: 'organizer', entryIds: [], viewIds: ['organizer/party'], status: 'done' }])
})

test('the rewrite is shown the page and every note it cites, in full and oldest first', async () => {
  const { z, book } = await partyWith(5)
  const before = topicOf(z, 'party')
  await z.sweep()
  await z.idle()
  expect(book.rewrites).toEqual([
    {
      slug: 'party',
      title: 'PARTY',
      body: before.body,
      notes: z.listEntries().map((e) => ({ id: e.id, at: e.at, text: e.text })),
    },
  ])
})

test('a valid rewrite replaces the body, keeps slug and sources, resets the count, and keeps the old page under .history', async () => {
  const { z, dir, book } = await partyWith(5)
  book.replyWith((p) => ({ slug: p.slug, title: 'Summer Party', sources: p.notes.map((n: any) => n.id), body: '# Summer Party\n\nVenue first, then six items.' }))
  const before = topicOf(z, 'party')
  await z.sweep()
  await z.idle()

  const after = topicOf(z, 'party')
  expect(after).toMatchObject({ slug: 'party', title: 'Summer Party', sources: before.sources, body: 'Venue first, then six items.' })
  expect(after.appendsSinceWrite).toBeUndefined()
  expect(after.pastTitles).toEqual([{ title: 'PARTY', until: after.updatedAt }])
  expect(await filesUnder(join(dir, 'views/organizer/.history/party'))).toEqual([`${before.updatedAt}.md`])
  expect(await readFile(join(dir, 'views/organizer/.history/party', `${before.updatedAt}.md`), 'utf8')).toBe(before.body)
  expect(await readFile(join(dir, 'views/organizer/party.md'), 'utf8')).toBe('Venue first, then six items.')
})

test('a rewrite that leaves out a source fails naming it, and its retry succeeds; both runs are recorded', async () => {
  const { z, dir, book } = await partyWith(5, { retryDelaysMs: [200] })
  let replies = 0
  book.replyWith((p) => ({ slug: p.slug, title: p.title, sources: p.notes.slice(++replies === 1 ? 1 : 0).map((n: any) => n.id), body: 'all of it, rewritten' }))
  await z.sweep()
  await eventually(() => rewriteRuns(z).some((r) => r.status === 'failed'))
  await z.sweep()
  await z.idle()

  expect(book.calls.filter((c) => c === 'rewrite party')).toHaveLength(2)
  const lines = (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.viewIds)
  expect(lines).toMatchObject([
    { viewIds: ['organizer/party'], status: 'failed', attempt: 1, error: 'invalid reply: sources left out: e1' },
    { viewIds: ['organizer/party'], status: 'done', attempt: 2, retryOf: lines[0].id },
  ])
  expect(topicOf(z, 'party').body).toBe('all of it, rewritten')
})

test('sweeping again while a rewrite runs queues no second one', async () => {
  const { z, book } = await partyWith(5)
  book.hold(isRewrite)
  await z.sweep()
  await eventually(() => book.calls.includes('rewrite party'))
  await z.sweep()
  await z.sweep()
  book.release()
  await z.idle()
  expect(rewriteRuns(z)).toHaveLength(1)
})

test('a topic too big to show in full is never queued', async () => {
  const { z, note } = await started()
  const long = 'x'.repeat(6000)
  await note(`party: ${long}`)
  for (let i = 1; i <= 5; i++) await note(`party: ${long}`)
  expect(topicOf(z, 'party').appendsSinceWrite).toBe(5)
  await z.sweep()
  await z.idle()
  expect(rewriteRuns(z)).toEqual([])
})

test('a note arriving during a rewrite is filed after it, onto the rewritten page', async () => {
  const { z, book } = await partyWith(5)
  book.replyWith((p) => ({ slug: p.slug, title: p.title, sources: p.notes.map((n: any) => n.id), body: 'the rewritten page' }))
  book.hold(isRewrite)
  await z.sweep()
  await eventually(() => book.calls.includes('rewrite party'))
  await z.ingest([entry('late', 'party: late arrival')])
  book.release()
  await z.idle()

  expect(book.calls.slice(-2)).toEqual(['rewrite party', 'file late'])
  expect(topicOf(z, 'party')).toMatchObject({ body: 'the rewritten page\n\nlate arrival', appendsSinceWrite: 1 })
  expect(topicOf(z, 'party').sources.at(-1)).toBe('late')
})

test('waiting notes are filed before a waiting rewrite', async () => {
  const { z, book } = await partyWith(5)
  book.hold(isFiling)
  await z.ingest([entry('n1', 'party: first')])
  await eventually(() => book.calls.includes('file n1'))
  await z.sweep()
  await z.ingest([entry('n2', 'party: second')])
  book.release()
  await z.idle()
  expect(book.calls.slice(-3)).toEqual(['file n1', 'file n2', 'rewrite party'])
})

test('a rewrite whose attempts ran out is not queued again until the topic changes', async () => {
  const { z, book, note } = await partyWith(5)
  book.replyWith((p) => ({ slug: p.slug, title: p.title, sources: [], body: 'lost every note' }))
  await z.sweep()
  await z.idle()
  await z.sweep()
  await z.idle()
  expect(book.calls.filter((c) => c === 'rewrite party')).toHaveLength(1)

  await note('party: item 6')
  await z.sweep()
  await z.idle()
  expect(book.calls.filter((c) => c === 'rewrite party')).toHaveLength(2)
})

test('a topic written anew after its rewrite was queued is not rewritten, and costs no call', async () => {
  const { z, book } = await partyWith(5)
  book.hold(isFiling)
  await z.ingest([entry('w', 'party! one fresh page')])
  await eventually(() => book.calls.includes('file w'))
  await z.sweep()
  book.release()
  await z.idle()
  expect(book.calls).not.toContain('rewrite party')
  expect(rewriteRuns(z)).toMatchObject([{ status: 'done' }])
  expect(topicOf(z, 'party').body).toBe('one fresh page')
})

/** A data dir whose topic party already has five appends in a row, all its notes filed. */
async function seededParty() {
  const entries = ['venue', 'cake', 'music', 'games', 'drinks', 'cleanup'].map((t, i) => entry(`e${i + 1}`, `party: ${t}`))
  const ids = entries.map((e) => e.id)
  const party = { kind: 'organizer', slug: 'party', title: 'PARTY', sources: ids, format: 'md' as const, body: 'venue\n\ncake\n\nmusic\n\ngames\n\ndrinks\n\ncleanup', updatedAt: '2026-10-19T09:00:00.000Z', appendsSinceWrite: 5 }
  return seedDataDir({ entries, runs: [doneRun('organizer', ids)], views: [party] })
}

test('a topic that qualifies is rewritten on start', async () => {
  const { z, book } = await started({ dataDir: await seededParty() })
  await z.idle()
  expect(book.calls).toEqual(['rewrite party'])
  expect(topicOf(z, 'party').body).toStartWith('- party: venue')
})

test('with sweepMs the sweep repeats until stop', async () => {
  const { z, book, note } = await partyWith(4, { sweepMs: 20 })
  await note('party: item 5')
  await eventually(() => book.calls.includes('rewrite party'))
  z.stop()
  await z.idle()
  for (let i = 6; i <= 10; i++) await note(`party: item ${i}`)
  await Bun.sleep(100)
  expect(book.calls.filter((c) => c === 'rewrite party')).toHaveLength(1)
})

const page: View = { id: 'organizer/party', kind: 'organizer', slug: 'party', title: 'Party', sources: ['e1', 'e2'], format: 'md', body: 'venue\n\ncake\n', updatedAt: 't' }
const known = new Set(['e1', 'e2', 'e3'])
const reply = (over: object) => ({ slug: 'party', title: 'Party', sources: ['e1', 'e2'], body: '- venue\n- cake', ...over })

test('validateRewrite fails a malformed reply, another slug, an empty body, a left-out source, and an extend-only body', () => {
  expect(validateRewrite(null, page, known)).toEqual({ ok: false, error: 'reply needs slug and body strings and a sources array' })
  expect(validateRewrite(reply({ sources: 'e1' }), page, known).ok).toBe(false)
  expect(validateRewrite(reply({ slug: 'garden' }), page, known)).toEqual({ ok: false, error: "slug garden is not the topic's slug party" })
  expect(validateRewrite(reply({ body: ' \n' }), page, known)).toEqual({ ok: false, error: 'body is empty' })
  expect(validateRewrite(reply({ sources: ['e2'] }), page, known)).toEqual({ ok: false, error: 'sources left out: e1' })
  expect(validateRewrite(reply({ body: 'venue\n\ncake\n\nmusic' }), page, known)).toEqual({ ok: false, error: 'body only extends the current page' })
  expect(validateRewrite(reply({ body: 'venue\n\ncake\n' }), page, known)).toEqual({ ok: false, error: 'body only extends the current page' })
})

test('validateRewrite takes a stale page back unchanged, since its notes agree with it, but not one that only extends it', () => {
  const stale: View = { ...page, bodyStale: true }
  expect(validateRewrite(reply({ body: 'venue\n\ncake' }), stale, known)).toMatchObject({ ok: true, write: { body: 'venue\n\ncake' } })
  expect(validateRewrite(reply({ body: 'venue\n\ncake\n\nmusic' }), stale, known)).toEqual({ ok: false, error: 'body only extends the current page' })
})

test('validateRewrite keeps exactly the page\'s sources, dropping extra ids with a reason', () => {
  expect(validateRewrite(reply({ slug: 'Party', sources: ['e3', 'e2', 'ghost', 'e1'] }), page, known)).toEqual({
    ok: true,
    write: { slug: 'party', title: 'Party', sources: ['e1', 'e2'], format: 'md', body: '- venue\n- cake' },
    dropped: ['rewrite party: unknown sources dropped: ghost', 'rewrite party: sources not on the page dropped: e3'],
  })
})

test('validateRewrite takes a usable new title and keeps the current one otherwise, with a reason', () => {
  const titled = (title: unknown) => {
    const r = validateRewrite(reply({ title }), page, known)
    return r.ok ? [r.write.title, r.dropped] : r.error
  }
  expect(titled(' Summer Party ')).toEqual(['Summer Party', []])
  const reason = ['rewrite party: title dropped, not a non-empty string of at most 80 characters']
  expect(titled('')).toEqual(['Party', reason])
  expect(titled('x'.repeat(81))).toEqual(['Party', reason])
  expect(titled(undefined)).toEqual(['Party', reason])
})

test('a stale topic is rewritten on start whatever its append count, told why, then drawn once from the new page', async () => {
  const entries = ['venue', 'cake', 'music', 'games'].map((t, i) => entry(`e${i + 1}`, t))
  const ids = entries.map((e) => e.id)
  const party = { kind: 'organizer', slug: 'party', title: 'PARTY', sources: ids, format: 'md' as const, body: 'venue, cake, music, games, and a moved-away note', updatedAt: '2026-10-19T09:00:00.000Z', bodyStale: true as const }
  const dir = await seedDataDir({ entries, runs: [doneRun('organizer', ids)], views: [party] })
  const calls: string[] = []
  let system = ''
  const backend: ModelBackend = {
    async complete(messages) {
      const p = payloadOf(messages)
      if ('notes' in p) {
        calls.push('rewrite')
        system = messages[0]!.content
        return { json: { slug: p.slug, title: p.title, sources: p.notes.map((n: any) => n.id), body: p.notes.map((n: any) => n.text).join(', ') } }
      }
      calls.push(`draw ${p.body}`)
      return { json: { format: 'ascii', body: p.body } }
    },
  }
  const z = new Zephyr({ dataDir: dir, backend, kinds: { organizer: kinds.organizer!, visualizer: kinds.visualizer! }, retryDelaysMs: [] })
  await z.start()
  await z.idle()

  expect(calls).toEqual(['rewrite', 'draw venue, cake, music, games'])
  expect(system).toContain("The person changed the page's notes")
  expect(topicOf(z, 'party').bodyStale).toBeUndefined()
  expect(await metaOnDisk(dir, 'party')).not.toHaveProperty('bodyStale')
  expect(await readFile(join(dir, 'views/organizer/.history/party', `${party.updatedAt}.md`), 'utf8')).toBe(party.body)
})
