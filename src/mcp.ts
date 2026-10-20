import { inputSchema, OPS, parseAdjustment } from './adjust'
import { MAX_LINK_TOPICS, MAX_LINKS, MAX_SUMMARY_CHARS } from './deeper'
import type { Adjustment, PendingAdjustment } from './domain'
import { MAX_HINT_LIMIT } from './hints'
import { sanitizeSlug } from './kinds'
import { areasOf, mapIn } from './kinds/map'
import { MAX_REWRITE_CHARS, topicsIn } from './kinds/organizer'
import type { Zephyr } from './zephyr'

/** The newest first; an initialize asking for another gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true }
type Tool = { name: string; description: string; inputSchema: object; call(args: Record<string, unknown>): Promise<ToolResult> }

const result = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const toolError = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })
const noArgs = { type: 'object', properties: {}, additionalProperties: false }
/** What the agent tells the person about an adjustment that failed partway: it is not lost, and when it applies again. */
const pendingText = (p: PendingAdjustment) =>
  `${p.id} failed partway (${p.error}). It is logged and applied again ${p.retryInMs === null ? 'on the next server start' : `in ${Math.round(p.retryInMs / 1000)} s`}; do not send it again.`

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
      description: 'Every topic by slug: slug, title, the ids of the notes it cites, and the space of the map it is in (null until the map lists it).',
      inputSchema: noArgs,
      call: async () => {
        const views = z.listViews()
        const spaceOf = new Map(areasOf(mapIn(views)).flatMap((a) => a.topics.map((t) => [t.slug, { slug: a.slug, title: a.title }] as const)))
        return result(
          topicsIn(views)
            .map((v) => ({ slug: v.slug, title: v.title, noteIds: v.sources, space: spaceOf.get(v.slug) ?? null }))
            .sort((a, b) => a.slug.localeCompare(b.slug)),
        )
      },
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
      description: 'Notes related to a query, best first, with every topic each is on and the backend that ranked them. Use it to find where something was noted.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: MAX_HINT_LIMIT, default: 3 } },
        required: ['query'],
        additionalProperties: false,
      },
      async call(args) {
        const limit = args.limit ?? 3
        if (typeof args.query !== 'string') return toolError('query is required')
        if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_HINT_LIMIT) return toolError(`limit must be an integer from 1 to ${MAX_HINT_LIMIT}`)
        return result(await z.hints(args.query, limit as number))
      },
    },
    {
      name: 'list_questions',
      description:
        'Open questions the agents raised while filing notes, each about one note they filed by a best guess, with the answers it takes. Answering keep leaves the note as filed.',
      inputSchema: noArgs,
      call: async () => result(z.listQuestions()),
    },
    {
      name: 'answer_question',
      description:
        "Answer an open question with one of its answers, as the person chose it; an answer other than keep applies the matching change. A question whose note moved or was removed since closes as moot.",
      inputSchema: {
        type: 'object',
        properties: { questionId: { type: 'string', minLength: 1, description: 'question id' }, answer: { type: 'string', minLength: 1, description: "one of the question's answers" } },
        required: ['questionId', 'answer'],
        additionalProperties: false,
      },
      async call(args) {
        if (typeof args.questionId !== 'string' || typeof args.answer !== 'string') return toolError('questionId and answer must be strings')
        const answered = await z.answerQuestion(args.questionId, args.answer)
        return answered.ok ? result(answered) : toolError(answered.error)
      },
    },
    {
      name: 'summarize_review',
      description: `A summary the model writes of the notes since the last review, with the token usage of the call. It is shown ${MAX_SUMMARY_CHARS} characters of notes at most, the budget a topic rewrite gets, so one call stays quick and is read in full; past that it covers the newest notes, and leftOut counts the older ones left out. Not stored unless save is true; then path is where it was saved.`,
      inputSchema: { type: 'object', properties: { save: { type: 'boolean', default: false, description: 'keep the summary in the data dir' } }, additionalProperties: false },
      async call(args) {
        if (args.save !== undefined && typeof args.save !== 'boolean') return toolError('save must be a boolean')
        const done = await z.summarizeReview(args.save === true)
        if (!done.ok) return toolError(done.error)
        const { ok, ...summary } = done
        return result(summary)
      },
    },
    {
      name: 'suggest_links',
      description: `Pairs of topics the model finds related but worth keeping as separate pages, each with a one-line reason; at most ${MAX_LINKS}, from an index of the ${MAX_LINK_TOPICS} most recently updated topics. Changes nothing: put each pair to the person, and apply one with link_topics only after they say yes.`,
      inputSchema: noArgs,
      async call() {
        const done = await z.suggestLinks()
        if (!done.ok) return toolError(done.error)
        const { ok, ...suggestions } = done
        return result(suggestions)
      },
    },
    {
      name: 'rewrite_touched_topics',
      description: `Rewrite every topic that cites a note since the last review as one coherent page from its notes. Queues the rewrites and returns the slugs queued; a topic whose body and notes exceed ${MAX_REWRITE_CHARS} characters is not rewritten and is listed in overCap.`,
      inputSchema: noArgs,
      async call() {
        const done = await z.rewriteTouched()
        return done.ok ? result({ queued: done.queued, overCap: done.overCap }) : toolError(done.error)
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
        let done: Awaited<ReturnType<Zephyr['adjust']>>
        try {
          done = await z.adjust(parsed.adjustment)
        } catch (err) {
          return toolError(`the adjustment could not be logged, so nothing changed: ${(err as Error).message}`)
        }
        if ('pending' in done) return toolError(pendingText(done))
        return done.ok ? result(done) : toolError(done.error)
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
