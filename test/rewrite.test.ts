import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, ModelBackend } from '../src/domain'
import { kinds } from '../src/kinds'
import { Zephyr, type ZephyrOptions } from '../src/zephyr'
import { entry, gate, payloadOf, tempDir } from './helpers'

/**
 * Plays the organizer: "<slug>: text" appends text to topic <slug> (writing it when new), "<slug>! text" writes the
 * page anew. Rewrite requests are answered by rewrite(payload), by default one bullet per note, citing every note.
 */
function notebook() {
  const rewrites: any[] = []
  const held = gate()
  let rewrite = (p: any): unknown => ({ slug: p.slug, title: p.title, sources: p.notes.map((n: any) => n.id), body: p.notes.map((n: any) => `- ${n.text}`).join('\n') })
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = payloadOf(messages)
      if ('notes' in payload) {
        rewrites.push(payload)
        await held.pass()
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
  return { backend, rewrites, hold: () => held.hold(), release: held.release, replyWith: (fn: typeof rewrite) => (rewrite = fn) }
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
