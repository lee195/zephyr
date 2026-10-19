/**
 * Measures the organizer prompt against the real model endpoint.
 *
 *   wick exec --only vllm -- bun scripts/measure-organizer-prompt.ts [--topics 20] [--reps 1] [--breakdown] [--out file.json]
 *
 * Builds a data dir at steady state from scripts/fixtures/organizer-corpus.json (one topic per subject,
 * 3 to 8 notes each, body one bullet per note, entries interleaved in time), then sends each probe note
 * as a single-note run through the real Zephyr organizer. Each probe starts from a fresh copy of the
 * same data dir, so runs are independent. Never touches ./data or a running server.
 *
 * --breakdown re-sends the first probe's prompt once per part with that part removed (max_tokens 1),
 * so each part's token count is a measured difference, not a chars-per-token estimate.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { backends } from '../src/backends'
import type { ChatMessage, Entry, ModelBackend, Usage } from '../src/domain'
import { Zephyr } from '../src/zephyr'

interface Probe {
  name: string
  expect: { existing: string } | { new: true }
  text: string
}

const PROBES: Probe[] = [
  { name: 'sourdough', expect: { existing: 'sourdough-baking' }, text: 'Swapped the dutch oven for a cast iron combo cooker: 20 min lid on at 250C, then 22 min lid off gave a much darker ear and a crisper crust.' },
  { name: 'forgejo', expect: { existing: 'forgejo-ci-pipelines' }, text: 'The matrix build across bun 1.2 and 1.3 doubles the runner queue. Limiting the matrix to PRs labelled compat and running a single version on push.' },
  { name: 'marathon', expect: { existing: 'marathon-training' }, text: 'Booked a sports massage before the taper. Physio thinks the tight left calf comes from too many downhill km, so a flatter route for the next long run.' },
  { name: 'sailing', expect: { new: true }, text: 'First dinghy sailing lesson on the Wannsee: tacking went fine but I kept forgetting to swap hands on the mainsheet. Next lesson Saturday 10am.' },
  { name: 'beekeeping', expect: { new: true }, text: 'Signed up for a beekeeping intro course in spring: hive checks every 7 to 9 days in swarm season, and a starter colony costs about 150 EUR.' },
]

const { values: args } = parseArgs({
  options: { breakdown: { type: 'boolean', default: false }, topics: { type: 'string', default: '20' }, reps: { type: 'string', default: '1' }, out: { type: 'string' }, label: { type: 'string', default: '' } },
})
const topicCount = Number(args.topics)
const reps = Number(args.reps)

const uuid = (seed: string) => {
  const h = createHash('sha1').update(seed).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
const at = (hour: number) => new Date(Date.UTC(2026, 8, 1) + hour * 3_600_000).toISOString()

interface Subject {
  slug: string
  title: string
  notes: string[]
}

async function buildFixture(subjects: Subject[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zephyr-measure-fixture-'))
  const notesPer = subjects.map((_, i) => 3 + (i % 6))
  const entries: Entry[] = []
  const sourcesBySlug = new Map<string, string[]>()
  for (let round = 0; round < 8; round++) {
    subjects.forEach((s, i) => {
      if (round >= notesPer[i]!) return
      const id = uuid(`${s.slug}#${round}`)
      entries.push({ id, harness: 'claude-code', sessionId: 'measure', at: at(entries.length), text: s.notes[round]! })
      sourcesBySlug.set(s.slug, [...(sourcesBySlug.get(s.slug) ?? []), id])
    })
  }
  await writeFile(join(dir, 'entries.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''))
  const now = at(entries.length)
  await writeFile(join(dir, 'runs.jsonl'), JSON.stringify({ id: 'fixture', kind: 'organizer', entryIds: entries.map((e) => e.id), status: 'done', attempt: 1, startedAt: now, endedAt: now }) + '\n')
  const viewDir = join(dir, 'views', 'organizer')
  await mkdir(viewDir, { recursive: true })
  for (const [i, s] of subjects.entries()) {
    const body = s.notes.slice(0, notesPer[i]).map((n) => `- ${n}`).join('\n')
    const meta = { id: `organizer/${s.slug}`, kind: 'organizer', slug: s.slug, title: s.title, sources: sourcesBySlug.get(s.slug), format: 'md', updatedAt: now }
    await writeFile(join(viewDir, `${s.slug}.md`), body)
    await writeFile(join(viewDir, `${s.slug}.json`), JSON.stringify(meta, null, 2))
  }
  return dir
}

/** Chars per top-level part of the prompt: the system message, then each key of the user JSON payload. */
function promptParts(messages: ChatMessage[]): Record<string, number> {
  const parts: Record<string, number> = { system: messages[0]!.content.length }
  const user = messages.at(-1)!.content
  try {
    for (const [k, v] of Object.entries(JSON.parse(user))) parts[k] = JSON.stringify(v).length
  } catch {
    parts.user = user.length
  }
  return parts
}

interface Call {
  messages: ChatMessage[]
  usage?: Usage
  latencyMs: number
  parts: Record<string, number>
  reply: unknown
}

function measuring(inner: ModelBackend, calls: Call[]): ModelBackend {
  return {
    async complete(messages, opts) {
      const t0 = performance.now()
      const result = await inner.complete(messages, opts)
      calls.push({ messages, usage: result.usage, latencyMs: Math.round(performance.now() - t0), parts: promptParts(messages), reply: result.json })
      return result
    },
  }
}

const corpus = (await Bun.file(join(import.meta.dir, 'fixtures/organizer-corpus.json')).json()) as { subjects: Subject[] }
if (topicCount > corpus.subjects.length) throw new Error(`corpus has only ${corpus.subjects.length} subjects`)
const fixture = await buildFixture(corpus.subjects.slice(0, topicCount))
const model = backends.vllm!(process.env)

const results = []
let firstMessages: ChatMessage[] | undefined
for (let rep = 0; rep < reps; rep++) {
  for (const probe of PROBES) {
    const dir = await mkdtemp(join(tmpdir(), 'zephyr-measure-run-'))
    await cp(fixture, dir, { recursive: true })
    const calls: Call[] = []
    const z = new Zephyr({ dataDir: dir, backend: measuring(model, calls), retryDelaysMs: [] })
    await z.start()
    const before = new Map(z.listViews().map((v) => [v.slug, v]))
    const probeId = uuid(`probe-${probe.name}`)
    await z.ingest([{ id: probeId, harness: 'claude-code', sessionId: 'measure', at: at(10_000), text: probe.text }])
    await z.idle()
    z.stop()

    const run = z.listRuns().at(-1) as any
    const after = z.listViews()
    const landed = after.filter((v) => v.sources.includes(probeId)).map((v) => v.slug)
    const created = after.filter((v) => !before.has(v.slug)).map((v) => v.slug)
    const rewritten = after.filter((v) => before.has(v.slug) && before.get(v.slug)!.body !== v.body)
    const expected = probe.expect
    const correct =
      run.status === 'done' &&
      ('existing' in expected
        ? landed.length === 1 && landed[0] === expected.existing && created.length === 0
        : landed.length === 1 && created.length === 1 && landed[0] === created[0])
    const call = calls[0]
    const reply = call?.reply as any
    const replyOps = (reply?.ops ?? reply?.upserts ?? []).map((o: any) => `${o.op ?? 'upsert'}:${o.slug}`)
    const shown = call ? JSON.parse(call.messages.at(-1)!.content) : {}
    const open: string[] | undefined = shown.openTopics?.map((t: any) => t.slug)
    const row = {
      rep,
      probe: probe.name,
      expect: 'existing' in expected ? expected.existing : 'new',
      status: run.status,
      error: run.error,
      dropped: run.dropped,
      promptTokens: call?.usage?.promptTokens,
      cachedTokens: call?.usage?.cachedTokens,
      completionTokens: call?.usage?.completionTokens,
      latencyMs: call?.latencyMs,
      replyOps,
      open,
      landed,
      created,
      duplicateTopic: 'existing' in expected && created.length > 0,
      rewrittenExisting: rewritten.map((v) => `${v.slug} ${before.get(v.slug)!.body.length}->${v.body.length} chars`),
      correct,
      promptChars: call?.parts,
    }
    results.push(row)
    firstMessages ??= call?.messages
    console.log(
      [probe.name.padEnd(10), String(row.promptTokens).padStart(6), `cached ${row.cachedTokens ?? '?'}`.padStart(12), String(row.completionTokens).padStart(5), `${row.latencyMs}ms`.padStart(8), correct ? 'ok ' : 'BAD', replyOps.join(' '), open ? `open=${open.join(',')}` : '', row.dropped ? `dropped=${JSON.stringify(row.dropped)}` : '', row.error ?? ''].join('  '),
    )
  }
}

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
const summary = {
  label: args.label,
  topics: topicCount,
  entries: (await Bun.file(join(fixture, 'entries.jsonl')).text()).trim().split('\n').length,
  runs: results.length,
  meanPromptTokens: mean(results.map((r) => r.promptTokens ?? 0)),
  meanCompletionTokens: mean(results.map((r) => r.completionTokens ?? 0)),
  medianLatencyMs: results.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b)[Math.floor(results.length / 2)],
  latencyRangeMs: [Math.min(...results.map((r) => r.latencyMs ?? 0)), Math.max(...results.map((r) => r.latencyMs ?? 0))],
  correct: results.filter((r) => r.correct).length,
  duplicates: results.filter((r) => r.duplicateTopic).length,
  failed: results.filter((r) => r.status !== 'done').length,
}
console.log(JSON.stringify(summary))

async function promptTokens(messages: ChatMessage[]): Promise<number> {
  const base = process.env.ZEPHYR_VLLM_URL ?? 'https://llm.example.com/v1'
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: process.env.ZEPHYR_MODEL ?? 'deepseek-v4-flash-fast', max_tokens: 1, messages }),
  })
  if (!res.ok) throw new Error(`vllm ${res.status}`)
  return ((await res.json()) as any).usage.prompt_tokens
}

/** Tokens per prompt part, as the drop in prompt_tokens when that part is removed. */
async function breakdown(messages: ChatMessage[]): Promise<Record<string, number>> {
  const full = await promptTokens(messages)
  const [system, user] = [messages[0]!, messages.at(-1)!]
  const payload = JSON.parse(user.content) as Record<string, unknown>
  const out: Record<string, number> = { total: full, system: full - (await promptTokens([{ ...system, content: '' }, user])) }
  for (const key of Object.keys(payload)) {
    const { [key]: _, ...rest } = payload
    out[key] = full - (await promptTokens([system, { ...user, content: JSON.stringify(rest) }]))
  }
  return out
}

const tokensByPart = args.breakdown && firstMessages ? await breakdown(firstMessages) : undefined
if (tokensByPart) console.log('tokens by part', JSON.stringify(tokensByPart))
if (args.out) await writeFile(args.out, JSON.stringify({ summary, tokensByPart, results }, null, 2) + '\n')
