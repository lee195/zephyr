/**
 * Measures the prompts behind the open model-behavior issues against the real model endpoint.
 *
 *   bun scripts/measure-deeper.ts --item <retitle|rewrite|merge|links|summary|svg|ambiguity> [--reps 5] [--out file.json]
 *
 * Each item calls the prompt builders directly with fixed fixtures built from scripts/fixtures/organizer-corpus.json,
 * so it needs no data dir and never touches ./data or a running server. It prints one line per call and a summary.
 *
 * - retitle: organizer appends to an open topic. Broadening notes should retitle it; fitting notes should not.
 * - rewrite: the log rewrite of the same probes, after the note was appended. Same expectations.
 * - merge: the rewrite after a merge. The title should cover both merged pages.
 * - links: suggest_links over 40 topics. Counts pairs in a related set, a plausible set, and the rest.
 * - summary: summarize_review on sessions with and without stated tasks. Counts framing labels the notes do not use.
 * - svg: the visualizer on 10 topics. Counts replies that fail the SVG check, and how a repair retry does.
 * - ambiguity: relevance scores of the filed topic and the runner-up, for the server-raised question (no model call).
 */
import { parseArgs } from 'node:util'
import { backends } from '../src/backends'
import { parseConfig } from '../src/config'
import { linkIndex, linkMessages, linkPairScores, pairKey, parseSummary, summaryMessages, validateLinks } from '../src/deeper'
import type { ChatMessage, Entry, View } from '../src/domain'
import { appendSection, organizerMessages, rewriteMessages, topicDocs } from '../src/kinds/organizer'
import { parseDiagram, visualizerMessages, visualizerRepairMessages } from '../src/kinds/visualizer'
import { rankAll, relevanceBackends } from '../src/relevance'
import { tmpdir } from 'node:os'
import { loadCorpus } from './corpus'

const { values: args } = parseArgs({ options: { item: { type: 'string' }, reps: { type: 'string', default: '5' }, out: { type: 'string' }, label: { type: 'string', default: '' } } })
const reps = Number(args.reps)
const config = parseConfig(process.env)
const model = backends[config.modelBackend](config)

const corpus = await loadCorpus()
const subject = (slug: string) => corpus.find((s) => s.slug === slug)!

const at = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString()
let seq = 0
const entry = (text: string): Entry => ({ id: `n${++seq}`, harness: 'claude-code', sessionId: 'measure', at: at(seq), text })

/** A topic page from notes, one bullet each, as the fixture pages of the organizer measurement are. */
function topic(slug: string, title: string, notes: string[]): { view: View; entries: Entry[] } {
  const entries = notes.map(entry)
  const body = notes.map((n) => `- ${n}`).join('\n')
  return { view: { id: `organizer/${slug}`, kind: 'organizer', slug, title, format: 'md', body, sources: entries.map((e) => e.id), updatedAt: at(seq) }, entries }
}
const fromCorpus = (slug: string, n = 4) => topic(slug, subject(slug).title, subject(slug).notes.slice(0, n))

async function call(messages: ChatMessage[]): Promise<{ json?: unknown; error?: string; ms: number }> {
  const t0 = performance.now()
  try {
    const r = await model.complete(messages, { json: true })
    return { json: r.json, ms: Math.round(performance.now() - t0) }
  } catch (err) {
    return { error: (err as Error).message, ms: Math.round(performance.now() - t0) }
  }
}

/** Runs the jobs four at a time, in order of their results. */
async function pool<T>(jobs: (() => Promise<T>)[], width = 4): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await jobs[i]!()
    }
  }))
  return out
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
const results: unknown[] = []
let summary: Record<string, unknown> = {}

// ---- retitle ---------------------------------------------------------------------------------------------------
interface RetitleProbe {
  name: string
  slug: string
  title: string
  notes: string[]
  add: string
  retitle: boolean
}
const RETITLE: RetitleProbe[] = [
  { name: 'seedlings', slug: 'tomato-seedlings', title: 'Tomato Seedlings', retitle: true, notes: ['Sowed Sungold and Roma tomato seeds in the propagator, 22C on the heat mat.', 'Tomato seedlings up after 6 days, moved them under the grow light 14h a day.', 'Potted the tomato seedlings on into 9cm pots, buried the stems deep.'], add: 'Started cucumbers, peppers and basil on the same heat mat now, so the propagator is a whole vegetable nursery; peppers need 26C though.' },
  { name: 'kafka', slug: 'kafka-consumer-lag', title: 'Kafka Consumer Lag', retitle: true, notes: ['Consumer lag on the orders topic peaks at 40k messages every morning at 9.', 'Raised max.poll.records to 1000, lag halves but rebalances got longer.', 'Added two more consumer instances, lag back under 5k at peak.'], add: 'Different part of the same cluster work: on the producer side linger.ms 20 and batch.size 64k cut broker CPU by a third, and we moved the brokers to gp3 disks.' },
  { name: 'lisbon', slug: 'lisbon-flights', title: 'Lisbon Flights', retitle: true, notes: ['Flights to Lisbon on Sept 12 out of Gatwick at 7:40, 210 GBP return.', 'Checked in online, seats 14A and 14B.', 'Return flight moved to 18:05 on the 19th, airline emailed.'], add: 'Booked the Alfama apartment for all 7 nights and a day trip to Sintra on the 15th, and the wedding itself is on the 14th in Cascais.' },
  { name: 'sourdough', slug: 'sourdough-baking', title: 'Sourdough Baking', retitle: false, notes: subject('sourdough-baking').notes.slice(0, 3), add: 'Pushed hydration to 78% with the same flour; the dough was slack at shaping but the crumb opened up a lot.' },
  { name: 'marathon', slug: 'marathon-training', title: 'Marathon Training', retitle: false, notes: subject('marathon-training').notes.slice(0, 3), add: 'Tempo run Wednesday, 10km at 4:55/km, felt controlled the whole way.' },
  { name: 'espresso', slug: 'home-espresso', title: 'Home Espresso', retitle: false, notes: subject('home-espresso').notes.slice(0, 3), add: 'Descaled the machine today, first one in four months; shots pull a touch faster now at the same grind.' },
]

async function retitle() {
  const others = ['coolify-deployments', 'japanese-learning', 'car-maintenance', 'bouldering', 'podcast-ideas'].map((s) => fromCorpus(s).view)
  const jobs = RETITLE.flatMap((p) =>
    Array.from({ length: reps }, (_, rep) => async () => {
      const t = topic(p.slug, p.title, p.notes)
      const note = entry(p.add)
      const r = await call(organizerMessages([note], { open: [t.view], indexed: others }, t.entries))
      const op = ((r.json as any)?.ops ?? []).find((o: any) => o?.slug === p.slug)
      const newTitle: string | undefined = typeof op?.title === 'string' ? op.title : undefined
      const retitled = !!newTitle && !same(newTitle, p.title)
      return { rep, probe: p.name, expect: p.retitle, op: op?.op ?? null, title: newTitle ?? null, retitled, ok: retitled === p.retitle && !!op, error: r.error, ms: r.ms }
    }),
  )
  const rows = await pool(jobs)
  for (const row of rows) console.log([row.probe.padEnd(10), row.expect ? 'want new' : 'want same', String(row.op).padEnd(6), row.retitled ? 'RETITLED' : 'kept    ', row.ok ? 'ok ' : 'BAD', JSON.stringify(row.title), row.error ?? ''].join('  '))
  results.push(...rows)
  const of = (want: boolean) => rows.filter((r) => r.expect === want)
  summary = { broadeningRetitled: `${of(true).filter((r) => r.retitled).length}/${of(true).length}`, fittingRetitled: `${of(false).filter((r) => r.retitled).length}/${of(false).length}`, filedElsewhere: rows.filter((r) => !r.op).length }
}

// ---- rewrite ---------------------------------------------------------------------------------------------------
/** The retitle probes as a log rewrite sees them: the new note appended as a section, the title as it was. */
async function rewrite() {
  const jobs = RETITLE.flatMap((p) =>
    Array.from({ length: reps }, (_, rep) => async () => {
      const t = topic(p.slug, p.title, [...p.notes, p.add])
      const view: View = { ...t.view, body: appendSection(p.notes.map((n) => `- ${n}`).join('\n'), p.add), appendsSinceWrite: 5 }
      const r = await call(rewriteMessages({ topic: view, notes: t.entries }))
      const title: string | null = typeof (r.json as any)?.title === 'string' ? (r.json as any).title : null
      const retitled = !!title && !same(title, p.title)
      return { rep, probe: p.name, expect: p.retitle, title, retitled, ok: retitled === p.retitle, error: r.error, ms: r.ms }
    }),
  )
  const rows = await pool(jobs)
  for (const row of rows) console.log([row.probe.padEnd(10), row.expect ? 'want new' : 'want same', row.retitled ? 'RETITLED' : 'kept    ', row.ok ? 'ok ' : 'BAD', JSON.stringify(row.title), row.error ?? ''].join('  '))
  results.push(...rows)
  const of = (want: boolean) => rows.filter((r) => r.expect === want)
  summary = { broadeningRetitled: `${of(true).filter((r) => r.retitled).length}/${of(true).length}`, fittingRetitled: `${of(false).filter((r) => r.retitled).length}/${of(false).length}` }
}

// ---- merge -----------------------------------------------------------------------------------------------------
const MERGES: { name: string; into: [string, string, string[]]; from: [string, string, string[]] }[] = [
  {
    name: 'kafka',
    into: ['kafka-consumer-lag', 'Kafka Consumer Lag', RETITLE[1]!.notes],
    from: ['kafka-producer-tuning', 'Kafka Producer Tuning', ['linger.ms 20 and batch.size 64k on the producers cut broker CPU by a third.', 'Enabled zstd compression on the producers, network egress down 40%.', 'acks=all with idempotence on, throughput dropped only 5%.']],
  },
  {
    name: 'lisbon',
    into: ['lisbon-flights', 'Lisbon Flights', RETITLE[2]!.notes],
    from: ['cascais-wedding', 'Cascais Wedding', ['Wedding is on Sept 14 at 4pm in Cascais, dress code summer formal.', 'Gift: we chipped in for the honeymoon fund, 150 EUR.', 'Rehearsal dinner on the 13th at the beach restaurant.']],
  },
  {
    name: 'garden',
    into: ['tomato-seedlings', 'Tomato Seedlings', RETITLE[0]!.notes],
    from: ['balcony-herbs', 'Balcony Herbs', ['Basil on the balcony bolted in the heat, pinched off the flowers.', 'Rosemary and thyme survived the winter outside in the big trough.', 'Mint goes in its own pot, it took over the trough last year.']],
  },
]

/** The topic as mergeTopics leaves it: the old page appended under its title, both pages' notes, marked stale. */
function merged(m: (typeof MERGES)[number]) {
  const into = topic(...m.into)
  const from = topic(...m.from)
  const view: View = { ...into.view, body: appendSection(into.view.body, `## ${from.view.title}\n\n${from.view.body}`), sources: [...into.view.sources, ...from.view.sources], bodyStale: true, mergedTitles: [from.view.title] }
  return { view, notes: [...into.entries, ...from.entries], fromTitle: from.view.title }
}

async function merge() {
  const jobs = MERGES.flatMap((m) =>
    Array.from({ length: reps }, (_, rep) => async () => {
      const t = merged(m)
      const r = await call(rewriteMessages({ topic: t.view, notes: t.notes }))
      const title: string | null = typeof (r.json as any)?.title === 'string' ? (r.json as any).title : null
      const retitled = !!title && !same(title, m.into[1]) && !same(title, t.fromTitle)
      return { rep, probe: m.name, title, retitled, error: r.error, ms: r.ms }
    }),
  )
  const rows = await pool(jobs)
  for (const row of rows) console.log([row.probe.padEnd(8), row.retitled ? 'COVERS BOTH?' : 'kept one    ', JSON.stringify(row.title), row.error ?? ''].join('  '))
  results.push(...rows)
  summary = { retitled: `${rows.filter((r) => r.retitled).length}/${rows.length}` }
}

// ---- links -----------------------------------------------------------------------------------------------------
/** Pairs a reader of one would clearly want to know of the other. */
const RELATED = new Set([
  pairKey('sourdough-baking', 'pizza-dough'),
  pairKey('coolify-deployments', 'forgejo-ci-pipelines'),
  pairKey('friends-wedding-trip', 'portugal-vacation'),
  pairKey('home-network', 'smart-home-lights'),
  pairKey('tax-return-2026', 'household-budget'),
])
/** Pairs that are defensible but weaker. */
const PLAUSIBLE = new Set([
  pairKey('vue-viewer-ui', 'typescript-strictness'),
  pairKey('tauri-wkwebview-quirks', 'vue-viewer-ui'),
  pairKey('sso-incident-postmortem', 'password-manager-rollout'),
  pairKey('iso27001-policy', 'password-manager-rollout'),
  pairKey('iso27001-policy', 'sso-incident-postmortem'),
  pairKey('kubernetes-costs', 'coolify-deployments'),
  pairKey('vllm-endpoint-ops', 'llm-context-degradation'),
  pairKey('backend-hiring', 'quarterly-okrs'),
  pairKey('conference-talk', 'bun-open-source'),
  pairKey('meal-prep', 'household-budget'),
  pairKey('marathon-training', 'sleep-tracking'),
  pairKey('postgres-migrations', 'quarterly-okrs'),
  pairKey('home-espresso', 'sourdough-baking'),
  pairKey('coolify-deployments', 'vllm-endpoint-ops'),
  pairKey('forgejo-ci-pipelines', 'bun-open-source'),
  pairKey('apartment-move', 'household-budget'),
])

async function links() {
  const topics = corpus.map((s) => topic(s.slug, s.title, s.notes).view)
  const index = linkIndex(topics)
  const relevance = relevanceBackends[config.relevance](config, { cacheDir: tmpdir() })
  const scores = await linkPairScores(relevance, topics.flatMap((a, i) => topics.slice(i + 1).map((b) => [a, b] as const)))
  const classify = (k: string) => (RELATED.has(k) ? 'related' : PLAUSIBLE.has(k) ? 'plausible' : 'unrelated')
  const jobs = Array.from({ length: reps }, (_, rep) => async () => {
    const r = await call(linkMessages(index))
    const parsed = r.json ? validateLinks(r.json, index.topics, scores) : { ok: false as const, error: r.error ?? 'no reply' }
    const all = ((r.json as any)?.links ?? []).map((l: any) => ({ key: pairKey(String(l?.a), String(l?.b)), strength: l?.strength ?? null }))
    const kept = parsed.ok ? parsed.links.map((l) => pairKey(l.a.slug, l.b.slug)) : []
    return {
      rep,
      proposed: all.map((p: any) => ({ ...p, class: classify(p.key), score: scores?.scores.get(p.key) ?? null })),
      kept: kept.map((k) => ({ key: k, class: classify(k) })),
      dropped: parsed.ok ? parsed.dropped : [parsed.error],
      ms: r.ms,
    }
  })
  const rows = await pool(jobs)
  for (const row of rows) {
    console.log(`rep ${row.rep}`)
    for (const p of row.proposed) console.log(`  ${p.class.padEnd(9)} ${p.score?.toFixed(3) ?? '  ?  '} ${String(p.strength).padEnd(6)} ${p.key}${row.kept.some((k) => k.key === p.key) ? '' : '  (dropped)'}`)
  }
  results.push(...rows)
  const count = (pick: (r: (typeof rows)[number]) => { class: string }[], c: string) => rows.reduce((n, r) => n + pick(r).filter((p) => p.class === c).length, 0)
  const scored = [...(scores?.scores.entries() ?? [])].sort((a, b) => b[1] - a[1])
  const rank = (k: string) => scored.findIndex(([key]) => key === k) + 1
  summary = {
    proposed: { related: count((r) => r.proposed, 'related'), plausible: count((r) => r.proposed, 'plausible'), unrelated: count((r) => r.proposed, 'unrelated') },
    kept: { related: count((r) => r.kept, 'related'), plausible: count((r) => r.kept, 'plausible'), unrelated: count((r) => r.kept, 'unrelated') },
    backend: scores?.backend,
    relatedScores: [...RELATED].map((k) => ({ pair: k, score: scores?.scores.get(k), rank: rank(k) })),
    plausibleScores: [...PLAUSIBLE].map((k) => ({ pair: k, score: scores?.scores.get(k), rank: rank(k) })),
    pairs: scored.length,
    scoreQuantiles: [0.5, 0.9, 0.95, 0.99].map((q) => scored[Math.floor((1 - q) * scored.length)]?.[1]),
  }
}

// ---- summary ---------------------------------------------------------------------------------------------------
/** Labels that frame a point as a task, decision or open question. Counted only when no note of the session uses them. */
const FRAMING = ['to do', 'todo', 'action item', 'next step', 'open question', 'decision', 'decided', 'open task', 'follow up', 'follow-up', 'pending', 'outstanding']
const SESSIONS: { name: string; tasks: boolean; notes: string[] }[] = [
  { name: 'observations', tasks: false, notes: [...subject('film-photography').notes.slice(0, 3), ...subject('sci-fi-reading-list').notes.slice(0, 3)] },
  { name: 'training', tasks: false, notes: [...subject('bouldering').notes.slice(0, 3), ...subject('sleep-tracking').notes.slice(0, 3)] },
  {
    name: 'with-tasks',
    tasks: true,
    notes: ['Need to renew the car insurance before Nov 1, the quote went up 12%.', 'Decided to go with the Allianz offer for the house contents.', 'Open question: does the bike count as contents or needs its own policy?', ...subject('car-maintenance').notes.slice(0, 2)],
  },
]

async function summaries() {
  const jobs = SESSIONS.flatMap((s) =>
    Array.from({ length: reps }, (_, rep) => async () => {
      const notes = s.notes.map(entry)
      const r = await call(summaryMessages({ notes, leftOut: 0 }, []))
      const parsed = r.json ? parseSummary(r.json) : { ok: false as const, error: r.error ?? 'no reply' }
      const text = parsed.ok ? parsed.summary.toLowerCase() : ''
      const inNotes = s.notes.join('\n').toLowerCase()
      const added = FRAMING.filter((w) => text.includes(w) && !inNotes.includes(w))
      const namesRenewal = text.includes('insurance') && text.includes('nov')
      return { rep, session: s.name, added, namesRenewal, summary: parsed.ok ? parsed.summary : null, error: parsed.ok ? undefined : parsed.error, ms: r.ms }
    }),
  )
  const rows = await pool(jobs)
  for (const row of rows) console.log([row.session.padEnd(12), `added=${JSON.stringify(row.added)}`, row.session === 'with-tasks' ? `renewal ${row.namesRenewal ? 'named' : 'MISSING'}` : '', row.error ?? ''].join('  '))
  results.push(...rows)
  summary = {
    withAddedFraming: `${rows.filter((r) => r.added.length > 0).length}/${rows.length}`,
    addedLabels: rows.reduce((n, r) => n + r.added.length, 0),
    taskNamed: `${rows.filter((r) => r.session === 'with-tasks' && r.namesRenewal).length}/${rows.filter((r) => r.session === 'with-tasks').length}`,
  }
}

// ---- svg -------------------------------------------------------------------------------------------------------
const SVG_TOPICS = ['coolify-deployments', 'marathon-training', 'apartment-move', 'sso-incident-postmortem', 'home-network', 'garden-tomatoes', 'friends-wedding-trip', 'kubernetes-costs', 'dog-training', 'conference-talk']

async function svg() {
  const jobs = SVG_TOPICS.flatMap((slug) =>
    Array.from({ length: reps }, (_, rep) => async () => {
      const t = fromCorpus(slug, 8).view
      const first = await call(visualizerMessages(t))
      const firstCheck = first.json ? parseDiagram(first.json) : { ok: false as const, error: first.error ?? 'no reply' }
      // On a failure, both retries from the same fault: the plain one the server makes today, and the repair one.
      let plain: { ok: boolean; error?: string } | null = null
      let repaired: { ok: boolean; error?: string } | null = null
      if (!firstCheck.ok) {
        const check = async (messages: ChatMessage[]) => {
          const r = await call(messages)
          const c = r.json ? parseDiagram(r.json) : { ok: false as const, error: r.error ?? 'no reply' }
          return c.ok ? { ok: true } : { ok: false, error: c.error }
        }
        ;[plain, repaired] = await Promise.all([check(visualizerMessages(t)), check(visualizerRepairMessages(t, firstCheck.error))])
      }
      return { rep, topic: slug, firstOk: firstCheck.ok, format: firstCheck.ok ? firstCheck.diagram.format : null, error: firstCheck.ok ? undefined : firstCheck.error, plain, repaired, ms: first.ms }
    }),
  )
  const rows = await pool(jobs)
  for (const row of rows) console.log([row.topic.padEnd(24), row.firstOk ? `ok ${row.format}` : 'INVALID', row.error ?? '', row.plain ? `plain: ${row.plain.ok ? 'ok' : row.plain.error}` : '', row.repaired ? `repair: ${row.repaired.ok ? 'ok' : row.repaired.error}` : ''].join('  '))
  results.push(...rows)
  const failed = rows.filter((r) => !r.firstOk)
  summary = { firstInvalid: `${failed.length}/${rows.length}`, plainRetryOk: `${failed.filter((r) => r.plain?.ok).length}/${failed.length}`, repairedOk: `${failed.filter((r) => r.repaired?.ok).length}/${failed.length}`, ascii: rows.filter((r) => r.format === 'ascii').length }
}

// ---- ambiguity -------------------------------------------------------------------------------------------------
const AMBIGUOUS = [
  { name: 'tomato', text: 'Moved the tomato pots from the garden bed to the balcony rail for more sun; the Sungolds already look happier.', topics: ['garden', 'balcony'] },
  { name: 'lisbon', text: 'Lisbon: found a tram 28 day pass for 6.80 EUR, useful for the days before and after the wedding.', topics: ['friends-wedding-trip', 'portugal-vacation'] },
  { name: 'dough', text: 'Used the sourdough starter discard in the pizza dough instead of fresh yeast, 48h cold proof.', topics: ['sourdough-baking', 'pizza-dough'] },
]
const CLEAR = [
  { name: 'sourdough', text: 'Swapped the dutch oven for a cast iron combo cooker: 20 min lid on at 250C, then 22 min lid off gave a much darker ear and a crisper crust.', topic: 'sourdough-baking' },
  { name: 'forgejo', text: 'The matrix build across bun 1.2 and 1.3 doubles the runner queue. Limiting the matrix to PRs labelled compat and running a single version on push.', topic: 'forgejo-ci-pipelines' },
  { name: 'marathon', text: 'Booked a sports massage before the taper. Physio thinks the tight left calf comes from too many downhill km, so a flatter route for the next long run.', topic: 'marathon-training' },
  { name: 'network', text: 'The upstairs Deco keeps dropping to 2.4GHz; pinned the office laptop to the 5GHz band and speeds doubled.', topic: 'home-network' },
  { name: 'lights', text: 'Added a motion sensor in the hallway, lights at 20% between 23:00 and 6:00.', topic: 'smart-home-lights' },
  { name: 'wedding', text: 'Bought the suit for the wedding, light grey linen, tailor needs two weeks.', topic: 'friends-wedding-trip' },
]

async function ambiguity() {
  const garden = topic('garden', 'Garden', ['Raised bed in the garden: tomatoes, courgettes and beans, watered every evening.', 'Mulched the garden bed with straw, the soil stays moist much longer.', 'Tomatoes in the garden bed got blight on the lower leaves, removed them.'])
  const balcony = topic('balcony', 'Balcony', ['Balcony boxes: herbs and two tomato pots, south facing.', 'Put up a trellis on the balcony rail for the climbing beans.', 'Balcony gets full sun from 11 to 5 now that the tree was cut.'])
  const views = [...corpus.map((s) => topic(s.slug, s.title, s.notes).view), garden.view, balcony.view]
  const relevance = relevanceBackends[config.relevance](config, { cacheDir: tmpdir() })
  const docs = topicDocs(views)
  const rows = []
  for (const p of [...AMBIGUOUS.map((a) => ({ ...a, kind: 'ambiguous' as const })), ...CLEAR.map((c) => ({ ...c, kind: 'clear' as const, topics: [c.topic] }))]) {
    const ranking = await rankAll(relevance, p.text, docs)
    const [top, second] = ranking.scored
    const slugOf = (id?: string) => id?.split('/')[1]
    const row = { probe: p.name, kind: p.kind, backend: ranking.backend, min: ranking.minRelatedScore, top: slugOf(top?.id), topScore: top?.score, second: slugOf(second?.id), secondScore: second?.score, gap: (top?.score ?? 0) - (second?.score ?? 0), expected: p.topics }
    console.log([p.kind.padEnd(9), p.name.padEnd(10), `${row.top} ${row.topScore?.toFixed(3)}`.padEnd(34), `${row.second} ${row.secondScore?.toFixed(3)}`.padEnd(34), `gap ${row.gap.toFixed(3)}`].join('  '))
    rows.push(row)
  }
  results.push(...rows)
  summary = { backend: rows[0]?.backend, minRelatedScore: rows[0]?.min }
}

const items: Record<string, () => Promise<void>> = { retitle, rewrite, merge, links, summary: summaries, svg, ambiguity }
const run = items[args.item ?? '']
if (!run) throw new Error(`--item must be one of ${Object.keys(items).join(', ')}`)
await run()
const report = { item: args.item, label: args.label, reps, model: config.chat?.model ?? `${config.modelBackend} ${config.harness.model ?? 'default'}`, summary }
console.log(JSON.stringify(report))
if (args.out) await Bun.write(args.out, JSON.stringify({ ...report, results }, null, 2))
