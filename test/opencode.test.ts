import { Database } from 'bun:sqlite'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { adapters, parseOpencode } from '../src/adapters'
import { isNote, noteEntry } from '../src/domain'
import { Zephyr } from '../src/zephyr'
import { eventually, scripted, tempDir } from './helpers'

const SESSION = 'ses_fixture0001A'
const adapter = adapters['opencode']!

/** A database with opencode's real tables and the fixture's synthetic rows. */
async function fixtureDb() {
  const path = join(await tempDir(), 'opencode.db')
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(await Bun.file(new URL('./fixtures/opencode-notes.sql', import.meta.url)).text())
  return { path, db }
}

function addNote(db: Database, n: number, text: string) {
  const at = 1792414200000 + n
  db.query('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    `msg_added${n}`, SESSION, at, at, JSON.stringify({ role: 'user', time: { created: at }, agent: 'build', model: { providerID: 'deepseek', modelID: 'deepseek-v4-pro' } }),
  )
  db.query('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    `prt_added${n}`, `msg_added${n}`, SESSION, at + 7, at + 7, JSON.stringify({ type: 'text', text: `[zephyr] ${text}` }),
  )
}

test("a session's note rows become entries keyed by opencode message id; chat, assistant text and other sessions are not notes", async () => {
  const { path, db } = await fixtureDb()
  const { rows } = await adapter.read(path, SESSION, 0)
  db.close()
  expect(rows.filter(isNote).map((r) => noteEntry('opencode', r))).toEqual([
    { id: 'msg_fixture0001', harness: 'opencode', sessionId: SESSION, at: '2026-10-19T12:48:05.530Z', text: 'first note' },
    { id: 'msg_fixture0004', harness: 'opencode', sessionId: SESSION, at: '2026-10-19T12:48:19.000Z', text: 'second note' },
  ])
})

test('an assistant text part that starts with the marker is a row but not a note', () => {
  const [row] = parseOpencode({ id: 'm', sessionId: 's', at: 0, message: '{"role":"assistant"}', part: '{"type":"text","text":"[zephyr] echo"}' })
  expect(row?.role).toBe('assistant')
  expect(isNote(row!)).toBe(false)
})

test('a missing database reads as empty', async () => {
  expect(await adapter.read('/nonexistent/opencode.db', SESSION, 0)).toEqual({ rows: [], offset: 0 })
})

test('a registered opencode session is backfilled, tailed, and re-read without duplicates across restarts', async () => {
  const dir = await tempDir()
  const { path, db } = await fixtureDb()
  const z = new Zephyr({ dataDir: dir, backend: scripted().backend, kinds: {}, pollMs: 50 })
  await z.start()
  await z.registerSession('opencode', SESSION, path)
  await eventually(() => z.listEntries().length === 2)

  addNote(db, 1, 'third note')
  await eventually(() => z.listEntries().length === 3)
  await Bun.sleep(200)
  z.stop()

  const restarted = new Zephyr({ dataDir: dir, backend: scripted().backend, kinds: {}, pollMs: 50 })
  await restarted.start()
  addNote(db, 2, 'fourth note')
  await eventually(() => restarted.listEntries().length === 4)
  await Bun.sleep(200)
  restarted.stop()
  db.close()

  const ids = (await readFile(join(dir, 'entries.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id)
  expect(ids).toEqual(['msg_fixture0001', 'msg_fixture0004', 'msg_added1', 'msg_added2'])
  expect(restarted.listEntries().map((e) => e.text)).toEqual(['first note', 'second note', 'third note', 'fourth note'])
})
