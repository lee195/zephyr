import { expect, test } from 'bun:test'
import { adapters, parseClaudeCode } from '../src/adapters'
import { isNote, noteEntry } from '../src/domain'

const fixture = new URL('./fixtures/claude-code-notes.jsonl', import.meta.url).pathname
const adapter = adapters['claude-code']!

const notes = (line: string) => parseClaudeCode(line).filter(isNote).map((r) => noteEntry('claude-code', r))

test('real Claude Code note rows become entries without the marker', async () => {
  const { rows } = await adapter.read(fixture, 'c8fb7caa-e237-478f-8127-f5d88cb8e82d', 0)
  expect(rows.filter(isNote).map((r) => noteEntry('claude-code', r))).toEqual([
    {
      id: '8899696f-c1c6-4997-a618-280be5097b74',
      harness: 'claude-code',
      sessionId: 'c8fb7caa-e237-478f-8127-f5d88cb8e82d',
      at: '2026-10-19T08:17:19.812Z',
      text: 'first note',
    },
    {
      id: 'c5df8870-57eb-4849-92f1-4d9ed8dd2787',
      harness: 'claude-code',
      sessionId: 'c8fb7caa-e237-478f-8127-f5d88cb8e82d',
      at: '2026-10-19T08:17:28.964Z',
      text: 'second note',
    },
  ])
})

test('a typed (non-meta) note row with string content is accepted', () => {
  const row = { type: 'user', isMeta: false, uuid: 'u1', timestamp: 't', sessionId: 's', message: { role: 'user', content: '[zephyr] typed' } }
  expect(notes(JSON.stringify(row)).map((e) => e.text)).toEqual(['typed'])
})

test('a note row asking for a new topic or space carries its placement, and an unknown ask is no note', () => {
  const row = (text: string) => JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 't', sessionId: 's', message: { content: text } })
  expect(notes(row('[zephyr new topic] roses'))).toMatchObject([{ text: 'roses', placement: 'topic' }])
  expect(notes(row('[zephyr new space] roses'))).toMatchObject([{ text: 'roses', placement: 'space' }])
  expect(notes(row('[zephyr] roses'))[0]).not.toHaveProperty('placement')
  expect(notes(row('[zephyr new area] roses'))).toEqual([])
})

test('ordinary chat, assistant rows, and garbage are ignored', () => {
  const chat = { type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'hello model' }] } }
  const assistant = { type: 'assistant', uuid: 'u3', message: { content: [{ type: 'text', text: '[zephyr] echo' }] } }
  const toolResult = { type: 'user', uuid: 'u4', message: { content: [{ type: 'tool_result', content: '[zephyr] x' }] } }
  expect(notes(JSON.stringify(chat))).toEqual([])
  expect(notes(JSON.stringify(assistant))).toEqual([])
  expect(notes(JSON.stringify(toolResult))).toEqual([])
  expect(notes('{"type":"user",')).toEqual([])
})
