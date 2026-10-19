import { appendFile, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { adapters, parseCodex } from '../src/adapters'
import { isNote, noteEntry } from '../src/domain'
import { Zephyr } from '../src/zephyr'
import { eventually, scripted, tempDir } from './helpers'

const fixture = new URL('./fixtures/codex-notes.jsonl', import.meta.url).pathname
const SESSION = '01a15448-ee4b-7600-8f8b-407720467e1d'
const adapter = adapters['codex']!

const userRow = (id: string, text: string) =>
  JSON.stringify({
    timestamp: '2026-10-19T14:00:00.000Z',
    ordinal: 99,
    type: 'response_item',
    payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
  })

test("a rollout's note rows become entries keyed by Codex message id; chat, injected context and the ack are not notes", async () => {
  const { rows } = await adapter.read(fixture, SESSION, 0)
  expect(rows.filter(isNote).map((r) => noteEntry('codex', r))).toEqual([
    { id: 'msg_01a15448-ee8b-7482-a92d-b8bbd2cec1d2', harness: 'codex', sessionId: SESSION, at: '2026-10-19T13:10:28.235Z', text: 'first note' },
    { id: 'msg_01a15449-0307-7dd1-9283-f67dd5fe5bde', harness: 'codex', sessionId: SESSION, at: '2026-10-19T13:10:33.479Z', text: 'second note' },
  ])
})

test('each message is one row: the item_completed echo of a user message does not repeat it', async () => {
  const { rows } = await adapter.read(fixture, SESSION, 0)
  const texts = rows.map((r) => `${r.role}: ${r.text.split('\n')[0]}`)
  expect(texts.filter((t) => t.includes('first note'))).toEqual(['user: [zephyr] first note'])
  expect(texts).toContain('user: Say hello in two words.')
  expect(texts).toContain('assistant: Hello there.')
  expect(texts).toContain('assistant: .')
  expect(rows.some((r) => r.text.startsWith('<skills_instructions>'))).toBe(false)
})

test('an assistant message that starts with the marker is a row but not a note', () => {
  const line = JSON.stringify({
    timestamp: 't',
    type: 'response_item',
    payload: { type: 'message', id: 'msg_a', role: 'assistant', content: [{ type: 'output_text', text: '[zephyr] echo' }] },
  })
  const [row] = parseCodex(line, 's')
  expect(row?.role).toBe('assistant')
  expect(isNote(row!)).toBe(false)
})

test('developer messages, items without an id, and torn lines carry no row', () => {
  const developer = { type: 'response_item', payload: { type: 'message', id: 'msg_d', role: 'developer', content: [{ type: 'input_text', text: '[zephyr] x' }] } }
  const noId = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[zephyr] x' }] } }
  const echo = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: '[zephyr] x' }] } } }
  expect(parseCodex(JSON.stringify(developer), 's')).toEqual([])
  expect(parseCodex(JSON.stringify(noId), 's')).toEqual([])
  expect(parseCodex(JSON.stringify(echo), 's')).toEqual([])
  expect(parseCodex('{"type":"response_item",', 's')).toEqual([])
})

test('a registered Codex rollout is backfilled, tailed, and re-read without duplicates across restarts', async () => {
  const dir = await tempDir()
  const transcript = join(await tempDir(), `rollout-2026-10-19T15-10-28-${SESSION}.jsonl`)
  await copyFile(fixture, transcript)
  const z = new Zephyr({ dataDir: dir, backend: scripted().backend, kinds: {}, pollMs: 50 })
  await z.start()
  await z.registerSession('codex', SESSION, transcript)
  await eventually(() => z.listEntries().length === 2)

  await appendFile(transcript, userRow('msg_added1', '[zephyr] third note') + '\n')
  await eventually(() => z.listEntries().length === 3)
  await Bun.sleep(200)
  z.stop()

  const restarted = new Zephyr({ dataDir: dir, backend: scripted().backend, kinds: {}, pollMs: 50 })
  await restarted.start()
  await restarted.registerSession('codex', SESSION, transcript)
  await appendFile(transcript, userRow('msg_added2', '[zephyr] fourth note') + '\n')
  await eventually(() => restarted.listEntries().length === 4)
  await Bun.sleep(200)
  restarted.stop()

  const ids = (await readFile(join(dir, 'entries.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).id)
  expect(ids).toEqual(['msg_01a15448-ee8b-7482-a92d-b8bbd2cec1d2', 'msg_01a15449-0307-7dd1-9283-f67dd5fe5bde', 'msg_added1', 'msg_added2'])
  expect(restarted.listEntries().map((e) => e.text)).toEqual(['first note', 'second note', 'third note', 'fourth note'])
})
