import type { AgentKind, ChatMessage, Run, View, World } from '../domain'

/** A topic is drawn once it has this many sources. */
export const MIN_SOURCES = 4
const MAX_TOPIC_CHARS = 8000
const MAX_SVG_BYTES = 100 * 1024
const MAX_ASCII_COLUMNS = 100
const MAX_ASCII_LINES = 60

export type Diagram = { format: 'svg' | 'ascii'; body: string }
export type DiagramResult = { ok: true; diagram: Diagram } | { ok: false; error: string }

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XML_DECL = /^<\?xml[^>]*\?>\s*/
const ATTRS = String.raw`(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*`
const TOKEN = new RegExp(
  String.raw`<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)(${ATTRS})\s*(\/?)>`,
  'y',
)

/**
 * Checks that the SVG is one well-formed `<svg>` root with a viewBox, and adds the namespaces an
 * `<img>` needs to render it. It does not sanitize: the viewer shows SVG only as an image, where
 * scripts and event handlers never run.
 */
export function checkSvg(raw: string): DiagramResult {
  const body = raw.trim().replace(XML_DECL, '')
  if (Buffer.byteLength(body) > MAX_SVG_BYTES) return { ok: false, error: `svg is larger than ${MAX_SVG_BYTES / 1024} KB` }
  const stack: string[] = []
  let root: { attrs: string; end: number } | null = null
  let closed = false
  let i = 0
  while (i < body.length) {
    const lt = body.indexOf('<', i)
    const text = body.slice(i, lt === -1 ? body.length : lt)
    if (stack.length === 0 && text.trim()) return { ok: false, error: 'svg has text outside its root' }
    if (lt === -1) break
    TOKEN.lastIndex = lt
    const m = TOKEN.exec(body)
    if (!m) return { ok: false, error: `svg is not well-formed at offset ${lt}` }
    i = TOKEN.lastIndex
    const [, slash, name, attrs, selfClose] = m
    if (!name) continue
    if (slash) {
      if (stack.pop() !== name) return { ok: false, error: `svg closes <${name}> that is not open` }
      if (stack.length === 0) closed = true
      continue
    }
    if (stack.length === 0) {
      if (closed || root) return { ok: false, error: 'svg has more than one root element' }
      if (name !== 'svg') return { ok: false, error: `root element is <${name}>, not <svg>` }
      root = { attrs: attrs!, end: lt + 1 + name.length }
    }
    if (selfClose) {
      if (stack.length === 0) closed = true
    } else stack.push(name)
  }
  if (!root) return { ok: false, error: 'reply has no <svg> element' }
  if (stack.length > 0) return { ok: false, error: `svg leaves <${stack.at(-1)}> unclosed` }
  if (!/\sviewBox\s*=\s*("[^"]+"|'[^']+')/.test(root.attrs)) return { ok: false, error: 'svg root has no viewBox' }
  const missing = [
    !/\sxmlns\s*=/.test(root.attrs) && ` xmlns="${SVG_NS}"`,
    /\bxlink:/.test(body) && !/\sxmlns:xlink\s*=/.test(root.attrs) && ` xmlns:xlink="${XLINK_NS}"`,
  ].filter(Boolean).join('')
  return { ok: true, diagram: { format: 'svg', body: body.slice(0, root.end) + missing + body.slice(root.end) } }
}

export function checkAscii(raw: string): DiagramResult {
  const lines = raw.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+$/, ''))
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift()
  if (lines.length === 0) return { ok: false, error: 'ascii diagram is empty' }
  if (lines.length > MAX_ASCII_LINES) return { ok: false, error: `ascii diagram has ${lines.length} lines, more than ${MAX_ASCII_LINES}` }
  const widest = Math.max(...lines.map((l) => [...l].length))
  if (widest > MAX_ASCII_COLUMNS) return { ok: false, error: `ascii diagram is ${widest} columns wide, more than ${MAX_ASCII_COLUMNS}` }
  return { ok: true, diagram: { format: 'ascii', body: lines.join('\n') } }
}

export function parseDiagram(json: unknown): DiagramResult {
  const { format, body } = (json ?? {}) as { format?: unknown; body?: unknown }
  if (typeof body !== 'string') return { ok: false, error: 'reply has no body string' }
  if (format === 'svg') return checkSvg(body)
  if (format === 'ascii') return checkAscii(body)
  return { ok: false, error: 'format is neither svg nor ascii' }
}

/** A topic with enough sources whose diagram is missing or was drawn from an older version of it. */
export function wantsDiagram(topic: View, diagrams: readonly View[]): boolean {
  if (topic.sources.length < MIN_SOURCES) return false
  const drawn = diagrams.find((d) => d.derivedFrom?.id === topic.id)?.derivedFrom
  return !drawn || drawn.updatedAt < topic.updatedAt
}

const VISUALIZER_SYSTEM = `You draw one diagram of a topic page from a person's notes.
Reply with JSON only: {"format":"svg","body":string} or {"format":"ascii","body":string}.
Draw what the page is about: its parts and how they relate, or its timeline when it is a sequence of events. Use only what the page says.
Prefer SVG:
- One <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H"> root with W at most 800. No script, no foreignObject, no images, no links.
- Transparent background. It is shown as an image on light and dark pages, so currentColor does not work: use mid-tone colors such as #5b8def, #e08a3c, #3fae7a, #9a7fd1, and #8a8a8a for lines and text.
- Readable labels: font-family sans-serif, font-size 13 or more, a few words each, text inside its shape, nothing overlapping.
Use ASCII only when a drawing would not help: at most ${MAX_ASCII_COLUMNS} columns and ${MAX_ASCII_LINES} lines.`

export function visualizerMessages(topic: View): ChatMessage[] {
  const body = topic.body.length > MAX_TOPIC_CHARS ? `${topic.body.slice(0, MAX_TOPIC_CHARS)}\n[…]` : topic.body
  return [
    { role: 'system', content: VISUALIZER_SYSTEM },
    { role: 'user', content: JSON.stringify({ title: topic.title, body }) },
  ]
}

export const visualizer: AgentKind = {
  kind: 'visualizer',
  trigger: { on: 'view', kind: 'organizer', wants: wantsDiagram },
  async plan(run: Run, world: World) {
    const topic = world.views.find((v) => v.id === run.viewIds?.[0])
    // The topic may have been drawn by an earlier run since this one was queued; then there is nothing to do.
    if (!topic || !wantsDiagram(topic, world.views.filter((v) => v.kind === 'visualizer'))) return null
    const derivedFrom = { id: topic.id, updatedAt: topic.updatedAt }
    return {
      messages: visualizerMessages(topic),
      settle(json) {
        const result = parseDiagram(json)
        if (!result.ok) return result
        return { ok: true, writes: [{ slug: topic.slug, title: topic.title, sources: topic.sources, ...result.diagram, derivedFrom }], dropped: [], covered: [] }
      },
    }
  },
}
