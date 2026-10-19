import { inputSchema, OPS, parseAdjustment } from './adjust'
import type { Adjustment } from './domain'
import { sanitizeSlug } from './kinds'
import { topicsIn } from './kinds/organizer'
import type { Zephyr } from './zephyr'

/** The newest first; an initialize asking for another gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true }
type Tool = { name: string; description: string; inputSchema: object; call(args: Record<string, unknown>): Promise<ToolResult> }

const result = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const toolError = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })
const noArgs = { type: 'object', properties: {}, additionalProperties: false }
const snake = (op: string) => op.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

function tools(z: Zephyr): Tool[] {
  const topic = (slug: unknown) => (typeof slug === 'string' ? topicsIn(z.listViews()).find((v) => v.slug === sanitizeSlug(slug)) : undefined)
  const read: Tool[] = [
    {
      name: 'get_review',
      description: 'The digest of notes since the last review: new topics, notes per topic, shared notes, renames, tasks, unfiled notes, rewrites.',
      inputSchema: noArgs,
      call: async () => result(await z.review()),
    },
    {
      name: 'finish_review',
      description: 'End the review: the next digest starts after `until`, the value the reviewed digest returned.',
      inputSchema: { type: 'object', properties: { until: { type: 'string', description: "the digest's until" } }, required: ['until'], additionalProperties: false },
      async call(args) {
        const closed = await z.finishReview(args.until)
        return closed.ok ? result({ ok: true, lastReviewedAt: closed.until }) : toolError(closed.error)
      },
    },
    {
      name: 'list_topics',
      description: 'Every topic by slug: slug, title and the ids of the notes it cites.',
      inputSchema: noArgs,
      call: async () =>
        result(
          topicsIn(z.listViews())
            .map((v) => ({ slug: v.slug, title: v.title, noteIds: v.sources }))
            .sort((a, b) => a.slug.localeCompare(b.slug)),
        ),
    },
    {
      name: 'get_topic',
      description: 'One topic: its page body and the notes it cites, with their text.',
      inputSchema: { type: 'object', properties: { slug: { type: 'string', description: 'topic slug' } }, required: ['slug'], additionalProperties: false },
      async call(args) {
        const v = topic(args.slug)
        if (!v) return toolError(`no topic ${String(args.slug)}`)
        const cited = new Set(v.sources)
        const notes = z.listEntries().filter((e) => cited.has(e.id)).map((e) => ({ id: e.id, text: e.text, at: e.at }))
        return result({ slug: v.slug, title: v.title, body: v.body, notes, ...(v.pins && { pins: v.pins }) })
      },
    },
    {
      name: 'search_notes',
      description: 'Notes related to a query, best first, with the topic each is on and the backend that ranked them.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 } },
        required: ['query'],
        additionalProperties: false,
      },
      async call(args) {
        const limit = args.limit ?? 3
        if (typeof args.query !== 'string') return toolError('query is required')
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 5) return toolError('limit must be an integer from 1 to 5')
        return result(await z.hints(args.query, limit as number))
      },
    },
    {
      name: 'get_purge',
      description: 'Whether a purge has finished: done once the topics it queued for a rewrite have been rewritten; pending lists those still waiting.',
      inputSchema: { type: 'object', properties: { noteId: { type: 'string', description: 'the purged note id' } }, required: ['noteId'], additionalProperties: false },
      async call(args) {
        const status = typeof args.noteId === 'string' ? await z.purgeStatus(args.noteId) : null
        return status ? result(status) : toolError(`note ${String(args.noteId)} was not purged`)
      },
    },
  ]
  const adjust = (Object.keys(OPS) as Adjustment['op'][]).map(
    (op): Tool => ({
      name: snake(op),
      description: OPS[op].describe,
      inputSchema: inputSchema(op),
      async call(args) {
        const parsed = parseAdjustment({ ...args, op })
        if (!parsed.ok) return toolError(parsed.error)
        try {
          const done = await z.adjust(parsed.adjustment)
          return done.ok ? result(done) : toolError(done.error)
        } catch (err) {
          return toolError(`the adjustment failed partway and is applied again on the next start: ${(err as Error).message}`)
        }
      },
    }),
  )
  return [...read, ...adjust]
}

const reply = (id: unknown, body: { result: unknown } | { error: { code: number; message: string } }) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...body }), { headers: { 'content-type': 'application/json' } })

/**
 * Stateless MCP over Streamable HTTP: each POST carries one JSON-RPC message and gets a JSON reply, or 202 for a
 * notification or a response. There is no session id and no server-to-client stream.
 */
export async function mcp(z: Zephyr, req: Request): Promise<Response> {
  let msg: any
  try {
    msg = await req.json()
  } catch {
    return reply(null, { error: { code: -32700, message: 'parse error' } })
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return reply(msg?.id, { error: { code: -32600, message: 'invalid request' } })
  if (typeof msg.method !== 'string' || msg.id === undefined) return new Response(null, { status: 202 })
  const params = msg.params ?? {}
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]
      return reply(msg.id, { result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'zephyr', version: '0.1.0' } } })
    }
    case 'ping':
      return reply(msg.id, { result: {} })
    case 'tools/list':
      return reply(msg.id, { result: { tools: tools(z).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
    case 'tools/call': {
      const tool = tools(z).find((t) => t.name === params.name)
      if (!tool) return reply(msg.id, { error: { code: -32602, message: `unknown tool ${String(params.name)}` } })
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      return reply(msg.id, { result: await tool.call(args) })
    }
  }
  return reply(msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } })
}
