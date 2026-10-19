import { expect, test } from 'bun:test'
import type { Adjustment } from '../src/domain'
import { serve } from '../src/server'
import type { Zephyr } from '../src/zephyr'
import { ALL, started } from './desk'
import { tempDir } from './helpers'

async function withMcp(kinds?: NonNullable<Parameters<typeof started>[0]>['kinds']) {
  const s = await started({ kinds })
  const server = serve(s.z, { port: 0, distDir: await tempDir() })
  const base = `http://127.0.0.1:${server.port}`
  let id = 0
  const rpc = async (method: string, params?: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params !== undefined && { params }) }),
    })
    return res.json() as Promise<any>
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = await rpc('tools/call', { name, arguments: args })
    await s.z.idle()
    return result as { content: { type: string; text: string }[]; isError?: true }
  }
  const close = () => {
    server.stop(true)
    s.z.stop()
  }
  return { ...s, base, rpc, call, close }
}

const NOTES = ['party: venue', 'party: cake', 'party: budget', 'party: todo buy cake', 'garden: beans', 'trip: train', 'camping: tent', 'garden: flowers, cite e2']

/** Every op once, as the phase 2 tests apply them, in an order where each one applies. */
const SCRIPT: Adjustment[] = [
  { op: 'renameTopic', slug: 'party', title: 'Summer Party' },
  { op: 'moveNote', noteId: 'e1', from: 'party', to: 'garden' },
  { op: 'detachNote', noteId: 'e2', from: 'garden', to: 'party' },
  { op: 'splitTopic', slug: 'party', noteIds: ['e3'], into: { slug: 'party-budget', title: 'Party budget' } },
  { op: 'mergeTopics', from: 'camping', into: 'trip' },
  { op: 'editNote', noteId: 'e5', text: 'garden: broad beans' },
  { op: 'tombstoneNote', noteId: 'e6' },
  { op: 'editTask', taskId: 't1', text: 'buy a big cake', due: 'Friday' },
  { op: 'completeTask', taskId: 't1' },
  { op: 'deleteTask', taskId: 't1' },
]

const toolName = (op: string) => op.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** Views and entries with every timestamp masked, since two servers run the same ops at different times. */
const state = (z: Zephyr) =>
  JSON.stringify({ views: z.listViews().sort((a, b) => a.id.localeCompare(b.id)), entries: z.listEntries() }).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')

test('tools/call applies every op to the same state and result as a direct adjustment', async () => {
  const direct = await started()
  const viaMcp = await withMcp()
  try {
    await direct.note(...NOTES)
    await viaMcp.note(...NOTES)
    expect(state(viaMcp.z)).toBe(state(direct.z))
    for (const { op, ...args } of SCRIPT) {
      const { id, ...expected } = await direct.adjust({ op, ...args } as Adjustment)
      expect(expected.ok).toBe(true)
      const result = await viaMcp.call(toolName(op), args)
      expect(result.isError).toBeUndefined()
      expect({ op, ...JSON.parse(result.content[0]!.text), id: undefined }).toEqual({ op, ...expected, id: undefined })
      expect(state(viaMcp.z)).toBe(state(direct.z))
    }
  } finally {
    direct.z.stop()
    viaMcp.close()
  }
})

test('tools/list offers the review tools and one tool per op, each schema requiring what the op needs', async () => {
  const s = await withMcp()
  try {
    const { result } = await s.rpc('tools/list')
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]))
    expect([...byName.keys()].sort()).toEqual(
      [
        'get_review', 'finish_review', 'list_topics', 'get_topic', 'search_notes', 'get_purge', 'list_questions', 'answer_question',
        'rename_topic', 'merge_topics', 'split_topic', 'move_note', 'detach_note', 'edit_note', 'tombstone_note', 'edit_task', 'complete_task', 'delete_task', 'purge_note',
      ].sort(),
    )
    for (const t of byName.values()) expect(t.description.length).toBeGreaterThan(0)
    expect(byName.get('move_note').inputSchema.required).toEqual(['noteId', 'from', 'to'])
    expect(byName.get('split_topic').inputSchema.properties.into.required).toEqual(['slug', 'title'])
    expect(byName.get('edit_task').inputSchema.required).toEqual(['taskId'])
    expect(byName.get('edit_task').inputSchema.properties.due.type).toEqual(['string', 'null'])
    for (const { op, ...args } of SCRIPT) {
      const schema = byName.get(toolName(op)).inputSchema
      expect(Object.keys(args).every((k) => k in schema.properties)).toBe(true)
      expect([...schema.required].sort()).toEqual(Object.keys(args).filter((k) => op !== 'editTask' || k === 'taskId').sort())
    }
  } finally {
    s.close()
  }
})

test('a malformed op is a tool error with the validator message, a refused one with the data message, and nothing changes', async () => {
  const s = await withMcp({ organizer: ALL.organizer })
  try {
    await s.note('party: venue', 'garden: beans')
    const before = state(s.z)
    expect(await s.call('move_note', { noteId: 'e1', from: 'party' })).toEqual({ content: [{ type: 'text', text: 'moveNote needs non-empty strings: to' }], isError: true })
    expect(await s.call('edit_task', { taskId: 't1' })).toEqual({ content: [{ type: 'text', text: 'editTask needs text or due' }], isError: true })
    expect(await s.call('rename_topic', { slug: 'nowhere', title: 'X' })).toEqual({ content: [{ type: 'text', text: 'no topic nowhere' }], isError: true })
    expect(await s.call('rename_topic', { slug: 'party', title: 'X', op: 'tombstoneNote', noteId: 'e1' })).toMatchObject({ content: [{ text: expect.stringContaining('"ok":true') }] })
    expect(s.z.listEntries().map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(state(s.z)).not.toBe(before)
    expect((await s.rpc('tools/call', { name: 'shred', arguments: {} })).error.code).toBe(-32602)
  } finally {
    s.close()
  }
})

test('the review tools read the digest, topics and related notes, and finish_review moves the cursor', async () => {
  const s = await withMcp({ organizer: ALL.organizer })
  try {
    await s.note('party: venue in the barn', 'party: cake', 'garden: beans')
    const text = async (name: string, args?: Record<string, unknown>) => JSON.parse((await s.call(name, args)).content[0]!.text)
    const digest = await text('get_review')
    expect({ ...digest, until: 'T' }).toEqual({ ...(await (await fetch(`${s.base}/api/review`)).json()), until: 'T' })
    expect(digest.notes.ids).toEqual(['e1', 'e2', 'e3'])
    expect(await text('list_topics')).toEqual([
      { slug: 'garden', title: 'GARDEN', noteIds: ['e3'] },
      { slug: 'party', title: 'PARTY', noteIds: ['e1', 'e2'] },
    ])
    expect(await text('get_topic', { slug: 'party' })).toMatchObject({ slug: 'party', body: 'venue in the barn\n\ncake', notes: [{ id: 'e1', text: 'party: venue in the barn' }, { id: 'e2', text: 'party: cake' }] })
    expect(await s.call('get_topic', { slug: 'nowhere' })).toMatchObject({ isError: true })
    const found = await text('search_notes', { query: 'barn venue', limit: 2 })
    expect([found.backend, found.hints[0].entryId, found.hints[0].topic.slug]).toEqual(['tfidf', 'e1', 'party'])
    expect(await s.call('search_notes', { query: 'barn venue', limit: 9 })).toMatchObject({ isError: true })

    expect(await s.call('finish_review', { until: 'yesterday' })).toMatchObject({ isError: true, content: [{ text: 'until must be an ISO timestamp as GET /api/review returns it' }] })
    expect(await text('finish_review', { until: digest.until })).toEqual({ ok: true, lastReviewedAt: digest.until })
    expect((await text('get_review')).since).toBe(digest.until)
  } finally {
    s.close()
  }
})

test('the review brief names the digest it carries and the until that finishes it', async () => {
  const s = await withMcp({ organizer: ALL.organizer })
  try {
    await s.note('party: venue')
    const brief = await (await fetch(`${s.base}/api/review/brief`)).text()
    const digest = JSON.parse(brief.slice(brief.indexOf('\n{')))
    expect(digest.notes.ids).toEqual(['e1'])
    expect(brief).toContain(`call finish_review with until "${digest.until}"`)
  } finally {
    s.close()
  }
})

test('MCP lifecycle: initialize answers with the tools capability, a notification gets 202, GET has no stream', async () => {
  const s = await withMcp()
  try {
    const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.result).toEqual({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'zephyr', version: '0.1.0' } })
    expect((await s.rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion).toBe('2025-11-25')
    const note = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    expect([note.status, await note.text()]).toEqual([202, ''])
    expect((await s.rpc('resources/list')).error.code).toBe(-32601)
    expect((await fetch(`${s.base}/mcp`)).status).toBe(405)
  } finally {
    s.close()
  }
})
