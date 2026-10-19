import { expect, test } from 'bun:test'
import { adapters } from '../src/adapters'

const fixture = await Bun.file(new URL('./fixtures/claude-code-notes.jsonl', import.meta.url)).text()
const adapter = adapters['claude-code']!

test('real Claude Code note rows become entries without the marker', () => {
  const entries = fixture.trim().split('\n').map((l) => adapter.parseLine(l))
  expect(entries).toEqual([
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
  expect(adapter.parseLine(JSON.stringify(row))?.text).toBe('typed')
})

test('ordinary chat, assistant rows, and garbage are ignored', () => {
  const chat = { type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'hello model' }] } }
  const assistant = { type: 'assistant', uuid: 'u3', message: { content: [{ type: 'text', text: '[zephyr] echo' }] } }
  const toolResult = { type: 'user', uuid: 'u4', message: { content: [{ type: 'tool_result', content: '[zephyr] x' }] } }
  expect(adapter.parseLine(JSON.stringify(chat))).toBeNull()
  expect(adapter.parseLine(JSON.stringify(assistant))).toBeNull()
  expect(adapter.parseLine(JSON.stringify(toolResult))).toBeNull()
  expect(adapter.parseLine('{"type":"user",')).toBeNull()
})
