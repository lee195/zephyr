import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register, Timer } from 'claude-code'

import type { Placement, Server } from '../types'
import type { Hints } from './notes'
import {
  bandLine,
  decide,
  draftChanged,
  filedLine,
  HINT_LIMIT,
  hintLine,
  hintsArrived,
  isBandShown,
  mcpMissing,
  NO_DRAFT,
  parseHints,
  parseReviewCount,
  parseStatus,
  REVIEW_TOOL,
  reviewNotice,
  shownHints,
  transcriptPathFor,
  WHERE_LIMIT,
  whereReply,
} from './notes'

const notesFor = atom({ plugin: 'zephyr', key: 'notesFor' } as const, null)
const placeNext = atom({ plugin: 'zephyr', key: 'placeNext' } as const, null)
const server = atom({ plugin: 'zephyr', key: 'server' } as const, { kind: 'unknown' } as Server)

const DEFAULT_PORT = 7317
const POLL_MS = 5000
const TIMEOUT_MS = 1500
const QUIET_MS = 1000

let base = `http://127.0.0.1:${DEFAULT_PORT}`
let poller: Timer | null = null
let isPolling = false
let hints: Hints = NO_DRAFT
let lastSeq = 0
let quiet: Timer | null = null

async function isNotesOn($: EngineInterface) {
  return (await read($, notesFor)) === (await $.session.id())
}

async function placementFor($: EngineInterface): Promise<Placement | null> {
  const next = await read($, placeNext)
  return next && next.sessionId === (await $.session.id()) ? next.placement : null
}

/** Resolves null when the server does not answer in time; the request itself keeps going. */
async function call($: EngineInterface, path: string, init?: HttpInit) {
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => null)
  return Promise.race([$.http.fetch(`${base}${path}`, init).catch(() => null), timeout])
}

// `transcript_path` rides only the classic events, which skip a person-installed mod under managed settings.
async function transcriptPath($: EngineInterface, sessionId: string) {
  const [home, root] = await Promise.all([$.env.get('HOME'), $.session.root()])
  return transcriptPathFor(home ?? '', root, sessionId)
}

async function poll($: EngineInterface) {
  if (isPolling) return
  isPolling = true
  try {
    const res = await call($, '/status')
    const now = await $.clock.now()
    const next: Server = res?.ok ? parseStatus(res.text, now) : { kind: 'down', checkedAt: now }
    const before = await read($, server)
    await update($, server, () => next)
    const isOn = await isNotesOn($)
    // A server that was down missed the registration, and notes typed meanwhile only reach it once it knows the session.
    if (isOn && before.kind === 'down' && next.kind === 'up') void registerSession($).catch(() => undefined)
    if (!isBandShown(isOn, next)) {
      poller?.cancel()
      poller = null
    }
  } finally {
    isPolling = false
  }
}

function setHints($: EngineInterface, next: Hints) {
  const before = shownHints(hints)
  hints = next
  if (shownHints(next) !== before) $.ui.invalidate('ui.render')
}

function clearHints($: EngineInterface) {
  quiet?.cancel()
  quiet = null
  setHints($, NO_DRAFT)
}

async function requestHints($: EngineInterface, seq: number) {
  if (hints.kind !== 'waiting' || hints.seq !== seq) return
  const path = `/hints?q=${encodeURIComponent(hints.draft)}&limit=${HINT_LIMIT}`
  const res = (await isNotesOn($)) ? await call($, path) : null
  setHints($, hintsArrived(hints, seq, res?.ok ? parseHints(res.text) : []))
}

// Synchronous, so edits apply in the order they were typed; notes mode is checked once the draft settles.
function onDraft($: EngineInterface, draft: string) {
  try {
    const next = draftChanged(hints, draft, ++lastSeq)
    if (next === hints) return
    quiet?.cancel()
    quiet = null
    setHints($, next)
    if (hints.kind !== 'waiting') return
    const seq = hints.seq
    quiet = $.clock.after(QUIET_MS, () => void requestHints($, seq).catch(() => undefined))
  } catch {
    // Hints never stand in the way of typing.
  }
}

function startPolling($: EngineInterface) {
  void poll($).catch(() => undefined)
  poller ??= $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
}

// The server is idempotent on this and backfills from offset 0, so a note typed while it was down is not lost.
async function registerSession($: EngineInterface) {
  const sessionId = await $.session.id()
  const body = JSON.stringify({ harness: 'claude-code', sessionId, transcriptPath: await transcriptPath($, sessionId) })
  await call($, '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
}

async function announce($: EngineInterface) {
  startPolling($)
  await registerSession($)
}

// A notice row is drawn in the transcript and never read by the model; nothing shows when the server is down.
async function noticeUnreviewed($: EngineInterface) {
  const res = await call($, '/api/review')
  const count = res?.ok ? parseReviewCount(res.text) : null
  const text = count === null ? null : reviewNotice(count)
  if (text) await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
}

// The brief is the server's: the digest and the rules of the review, naming the server's tools. The model reads it as
// this plugin's message and the person directs the turns after it.
async function startReview($: EngineInterface) {
  const res = await call($, '/api/review/brief')
  if (!res?.ok) return { text: `Zephyr is not reachable on ${base}.` }
  if (!(await $.tool.list()).some(t => t.name === REVIEW_TOOL)) return { text: mcpMissing(base) }
  // A submit from inside command.run would wait on the turn this hook holds, so it goes on the next tick.
  $.clock.after(0, () => void $.prompt.submit({ text: res.text }).catch(err => $.ui.log(`zephyr review did not start: ${String(err)}`)))
  return { text: 'Zephyr review started.' }
}

const USAGE =
  '/zephyr toggles notes mode; /zephyr new topic or /zephyr new space files the next note in a new topic or space; /zephyr review reviews the notes since the last review; /zephyr where <words> finds where notes went.'

const PLACED_REPLY: Record<Placement, string> = { topic: 'The next note starts a new topic.', space: 'The next note starts a new topic in a new space.' }

// Turns notes mode on when it is off; asked again, the newer placement wins.
async function placeNextNote($: EngineInterface, placement: Placement) {
  const sessionId = await $.session.id()
  const was = await read($, notesFor)
  await update($, notesFor, () => sessionId)
  await update($, placeNext, () => ({ sessionId, placement }))
  if (was !== sessionId) void announce($).catch(() => undefined)
  return { text: `${was === sessionId ? 'Notes mode is on.' : 'Notes mode on.'} ${PLACED_REPLY[placement]}` }
}

// Ranked like the hints, so it never calls a model; works with notes mode off too.
async function findNotes($: EngineInterface, query: string) {
  const res = await call($, `/hints?q=${encodeURIComponent(query)}&limit=${WHERE_LIMIT}`)
  if (!res?.ok) return { text: `Zephyr is not reachable on ${base}.` }
  return { text: whereReply(query, parseHints(res.text, WHERE_LIMIT)) }
}

export const register: Register = (on, options) => {
  const port = options.port
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) base = `http://127.0.0.1:${port}`

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'zephyr',
      description:
        'Toggle notes mode: prompts are kept as notes, with no reply. /zephyr new topic|space files the next note in a new topic or space; /zephyr review reviews the notes; /zephyr where <words> finds them.',
      argumentHint: '[new topic | new space | review | where <words>]',
    })
    if (await isNotesOn($)) void announce($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'zephyr' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'review') return startReview($)
    const query = /^where\s+(.+)$/s.exec(args)?.[1]?.trim()
    if (query) return findNotes($, query)
    const placement = /^new\s+(topic|space)$/.exec(args)?.[1] as Placement | undefined
    if (placement) return placeNextNote($, placement)
    if (args) return { text: USAGE }
    const sessionId = await $.session.id()
    const now = await update($, notesFor, was => (was === sessionId ? null : sessionId))
    if (now === null) {
      await update($, placeNext, () => null)
      void noticeUnreviewed($).catch(() => undefined)
      return { text: 'Notes mode off.' }
    }
    void announce($).catch(() => undefined)
    return { text: 'Notes mode on. Prompts are kept as notes, with no reply.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const placement = await placementFor($)
    const decision = decide(e, await isNotesOn($), placement)
    if (decision.kind === 'pass') return next(e)
    if (decision.kind === 'refuse') return { drop: decision.reason }

    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: decision.text }] } })
    // A refused append keeps the draft in the box: the drop hands it back and nothing clears it.
    if (r.deny !== undefined) return { drop: `not noted: ${r.deny}` }
    // The note row is meta, which the transcript never draws; this notice is what the person sees, and the model never reads it.
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: decision.echo }] } })
    if (placement) {
      await update($, placeNext, () => null)
      $.ui.invalidate('ui.render')
    }
    clearHints($)
    // A drop hands the draft back after this hook returns, so clear it on the next tick.
    $.clock.after(0, () => void $.prompt.fill({ text: '' }))
    return { drop: 'noted' }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'not noted: zephyr failed' }))

  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = null
    quiet?.cancel()
    quiet = null
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    onDraft($, box.text)
    return box
  })

  on('prompt.change', async ($, e, next) => {
    onDraft($, e.text)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isOn = await isNotesOn($)
    const status = await read($, server)
    const line = bandLine(isOn, status, await $.clock.now(), await placementFor($))
    if (!line) return next(e)
    const shown = isOn ? shownHints(hints) : []
    const filed = isOn ? filedLine(status) : null

    const { Box, Text } = $.ui.resolve(e)
    // The band is one tree for every plugin: keep what the hooks beneath drew.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text color="claude" wrap="truncate-end">
          {line}
        </Text>
        {filed && (
          <Text dimColor wrap="truncate-end">
            {filed}
          </Text>
        )}
        {shown.map((hint, i) => (
          <Text key={`hint-${i}`} dimColor wrap="truncate-end">
            {hintLine(hint)}
          </Text>
        ))}
        {below}
      </Box>
    )
  })
}
