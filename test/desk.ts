import type { Adjustment, ChatMessage, ModelBackend } from '../src/domain'
import { kinds } from '../src/kinds'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { entry, gate, payloadOf, tempDir } from './helpers'

type Call = 'file' | 'tasks' | 'rewrite' | 'draw'

/**
 * Plays every kind. Organizer: "<slug>: text" files text under <slug>, appending when the topic exists;
 * "<slug>: text => Title" also retitles; "cite <id>" in the text cites that note too; "ask:<other>" asks whether the note
 * belongs on <other> instead. Tasks: a note containing "todo <x>" adds task x, and "ask:task" asks whether it is one. A rewrite makes the page
 * one bullet per note it is shown. The visualizer draws the title as ASCII. calls logs "<call> <detail>" in order;
 * hold(call) holds calls of that type until release().
 */
export function desk() {
  const calls: string[] = []
  const held = gate<[call: Call]>()
  const sent: Record<Call, any[]> = { file: [], tasks: [], rewrite: [], draw: [] }
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const p = payloadOf(messages)
      const call: Call = 'notes' in p ? 'rewrite' : 'openTasks' in p ? 'tasks' : 'openTopics' in p ? 'file' : 'draw'
      sent[call].push(p)
      calls.push(`${call} ${call === 'rewrite' ? p.slug : call === 'draw' ? p.title : p.newEntries.map((e: any) => e.id).join(',')}`)
      await held.pass(call)
      if (call === 'rewrite') return { json: { slug: p.slug, title: p.title, sources: p.notes.map((n: any) => n.id), body: p.notes.map((n: any) => `- ${n.text}`).join('\n') } }
      if (call === 'draw') return { json: { format: 'ascii', body: p.title } }
      if (call === 'tasks') {
        const ops = p.newEntries.flatMap((e: any) => {
          const m = /todo (.*)$/.exec(e.text)
          return m ? [{ op: 'add', text: m[1], sources: [e.id] }] : []
        })
        const questions = p.newEntries.filter((e: any) => e.text.includes('ask:task')).map((e: any) => ({ kind: 'isTask', noteId: e.id }))
        return { json: { ops, questions } }
      }
      const known = new Set<string>([...p.openTopics.map((t: any) => t.slug), ...p.topicIndex.map((l: string) => l.split(' | ')[0])])
      const ops = p.newEntries.flatMap((e: any) => {
        const m = /^([a-z-]+): (.*?)(?: => (.*))?$/.exec(e.text)
        if (!m) return []
        const [, slug, body, retitle] = m
        const op = known.has(slug!) ? { op: 'append', ...(retitle && { title: retitle }) } : { op: 'write', title: slug!.toUpperCase() }
        known.add(slug!)
        const extra = [...e.text.matchAll(/cite (\S+)/g)].map((c) => c[1])
        return [{ ...op, slug, sources: [e.id, ...extra], body }]
      })
      const questions = p.newEntries.flatMap((e: any) => {
        const alternatives = [...e.text.matchAll(/ask:([a-z-]+)/g)].map((c) => c[1]).filter((a) => a !== 'task')
        return alternatives.length > 0 ? [{ kind: 'whichTopic', noteId: e.id, chosen: e.text.split(':')[0], alternatives }] : []
      })
      return { json: { ops, questions } }
    },
  }
  return { backend, calls, sent, hold: (call: Call) => held.hold((c) => c === call), release: held.release }
}

export const ALL = { organizer: kinds.organizer!, tasks: kinds.tasks!, visualizer: kinds.visualizer! }

export async function started(opts: { dir?: string; kinds?: typeof ALL | { organizer: typeof ALL.organizer } } = {}) {
  const d = desk()
  const dir = opts.dir ?? (await tempDir())
  const z = new Zephyr({ dataDir: dir, backend: d.backend, kinds: opts.kinds ?? ALL, retryDelaysMs: [] })
  await z.start()
  await z.idle()
  let n = 0
  const note = async (...texts: string[]) => {
    await z.ingest(texts.map((t) => entry(`e${++n}`, t)))
    await z.idle()
  }
  const view = (id: string) => z.listViews().find((v) => v.id === id)
  const adjust = async (a: Adjustment) => {
    const result = await z.adjust(a)
    await z.idle()
    return result
  }
  return { z, d, dir, note, view, adjust }
}


/** A started desk behind a server on a free port, with JSON-RPC over its /mcp route. A call waits until the server is idle. */
export async function withMcp(kinds?: NonNullable<Parameters<typeof started>[0]>['kinds']) {
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
