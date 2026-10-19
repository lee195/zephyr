import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { ChatMessage, Entry, ModelBackend } from '../src/domain'
import { Zephyr } from '../src/zephyr'

const entry = (id: string, text = id): Entry => ({ id, harness: 'claude-code', sessionId: 's', at: '2026-10-19T00:00:00Z', text })

const noteRow = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', isMeta: true, uuid, timestamp: '2026-10-19T00:00:00Z', sessionId: 's1', message: { role: 'user', content: [{ type: 'text', text: `[zephyr] ${text}` }] } }) + '\n'

/** Groups every entry it is shown into one "all" topic; optionally holds each call until released. */
function fakeBackend() {
  const calls: string[][] = []
  const gates: Array<() => void> = []
  let hold = false
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const payload = JSON.parse(messages.at(-1)!.content)
      const ids: string[] = payload.newEntries.map((e: any) => e.id)
      calls.push(ids)
      if (hold) await new Promise<void>((r) => gates.push(r))
      return { upserts: [{ slug: 'all', title: 'All', sources: ids, body: ids.join(',') }] }
    },
  }
  return {
    backend,
    calls,
    holdCalls: () => (hold = true),
    release: () => {
      hold = false
      gates.splice(0).forEach((r) => r())
    },
  }
}

const tempDir = () => mkdtemp(join(tmpdir(), 'zephyr-test-'))

async function eventually(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error('condition not met in time')
}

test('entries arriving during a run coalesce into exactly one next run', async () => {
  const fake = fakeBackend()
  const z = new Zephyr({ dataDir: await tempDir(), backend: fake.backend })
  await z.start()
  fake.holdCalls()

  await z.ingest([entry('e1')])
  await eventually(() => fake.calls.length === 1)
  await z.ingest([entry('e2')])
  await z.ingest([entry('e3')])
  fake.release()
  await z.idle()

  expect(fake.calls).toEqual([['e1'], ['e2', 'e3']])
  expect(z.listRuns().map((r) => [r.entryIds, r.status])).toEqual([
    [['e1'], 'done'],
    [['e2', 'e3'], 'done'],
  ])
  expect(z.listViews().map((v) => [v.slug, v.sources])).toEqual([['all', ['e1', 'e2', 'e3']]])
})

test('a bad model reply fails the run and writes nothing', async () => {
  const dir = await tempDir()
  const z = new Zephyr({ dataDir: dir, backend: { complete: async () => ({ nope: true }) } })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(z.listRuns()[0]?.status).toBe('failed')
  expect(z.listViews()).toEqual([])
  const again = new Zephyr({ dataDir: dir, backend: fakeBackend().backend })
  await again.start()
  expect(again.listViews()).toEqual([])
})

test('views persist as files and reload after restart', async () => {
  const dir = await tempDir()
  const z = new Zephyr({ dataDir: dir, backend: fakeBackend().backend })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(await readFile(join(dir, 'views/organizer/all.md'), 'utf8')).toBe('e1')

  const reloaded = new Zephyr({ dataDir: dir, backend: fakeBackend().backend })
  await reloaded.start()
  expect(reloaded.listViews().map((v) => [v.id, v.sources, v.body])).toEqual([['organizer/all', ['e1'], 'e1']])
})

test('a registered transcript is backfilled, tailed, and never duplicated across restarts', async () => {
  const dir = await tempDir()
  const transcript = join(await tempDir(), 'session.jsonl')
  await writeFile(transcript, noteRow('n1', 'first') + JSON.stringify({ type: 'assistant', uuid: 'a1' }) + '\n')

  const z = new Zephyr({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
  await z.start()
  await z.registerSession('claude-code', 's1', transcript)
  await z.registerSession('claude-code', 's1', transcript)
  await eventually(() => z.listEntries().length === 1)

  await appendFile(transcript, noteRow('n2', 'second').slice(0, 20))
  await Bun.sleep(150)
  expect(z.listEntries().map((e) => e.id)).toEqual(['n1'])
  await appendFile(transcript, noteRow('n2', 'second').slice(20))
  await eventually(() => z.listEntries().length === 2)
  await z.idle()
  z.stop()

  // Simulate a crash that lost the offset: the whole transcript is re-read.
  await writeFile(join(dir, 'sessions.json'), JSON.stringify([{ harness: 'claude-code', sessionId: 's1', transcriptPath: transcript, offset: 0 }]))
  const restarted = new Zephyr({ dataDir: dir, backend: fakeBackend().backend, pollMs: 50 })
  await restarted.start()
  await appendFile(transcript, noteRow('n3', 'third'))
  await eventually(() => restarted.listEntries().length === 3)
  restarted.stop()

  const lines = (await readFile(join(dir, 'entries.jsonl'), 'utf8')).trim().split('\n')
  expect(lines.map((l) => JSON.parse(l).id)).toEqual(['n1', 'n2', 'n3'])
  expect(restarted.status().sessions).toBe(1)
})
