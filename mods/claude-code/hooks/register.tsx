import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register, Timer } from 'claude-code'

import type { Server } from '../types'
import { bandLine, decide, isBandShown, parseStatus, transcriptPathFor } from './notes'

const notesFor = atom({ plugin: 'zephyr', key: 'notesFor' } as const, null)
const server = atom({ plugin: 'zephyr', key: 'server' } as const, { kind: 'unknown' } as Server)

const DEFAULT_PORT = 7317
const POLL_MS = 5000
const TIMEOUT_MS = 1500

let base = `http://127.0.0.1:${DEFAULT_PORT}`
let poller: Timer | null = null
let isPolling = false

async function isNotesOn($: EngineInterface) {
  return (await read($, notesFor)) === (await $.session.id())
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
    await update($, server, () => next)
    if (!isBandShown(await isNotesOn($), next)) {
      poller?.cancel()
      poller = null
    }
  } finally {
    isPolling = false
  }
}

function startPolling($: EngineInterface) {
  void poll($).catch(() => undefined)
  poller ??= $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
}

// The server is idempotent on this and backfills from offset 0, so a note typed while it was down is not lost.
async function announce($: EngineInterface) {
  const sessionId = await $.session.id()
  const body = JSON.stringify({ harness: 'claude-code', sessionId, transcriptPath: await transcriptPath($, sessionId) })
  startPolling($)
  await call($, '/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
}

export const register: Register = (on, options) => {
  const port = options.port
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) base = `http://127.0.0.1:${port}`

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zephyr', description: 'Toggle notes mode: prompts are kept as notes, with no reply' })
    if (await isNotesOn($)) void announce($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'zephyr' }, async $ => {
    const sessionId = await $.session.id()
    const now = await update($, notesFor, was => (was === sessionId ? null : sessionId))
    if (now === null) return { text: 'Notes mode off.' }
    void announce($).catch(() => undefined)
    return { text: 'Notes mode on. Prompts are kept as notes, with no reply.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const decision = decide(e, await isNotesOn($))
    if (decision.kind === 'pass') return next(e)
    if (decision.kind === 'refuse') return { drop: decision.reason }

    const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: decision.text }] } })
    // A refused append keeps the draft in the box: the drop hands it back and nothing clears it.
    if (r.deny !== undefined) return { drop: `not noted: ${r.deny}` }
    // A drop hands the draft back after this hook returns, so clear it on the next tick.
    $.clock.after(0, () => void $.prompt.fill({ text: '' }))
    return { drop: 'noted' }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'not noted: zephyr failed' }))

  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = null
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const line = bandLine(await isNotesOn($), await read($, server), await $.clock.now())
    if (!line) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // The band is one tree for every plugin: keep what the hooks beneath drew.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text color="claude" wrap="truncate-end">
          {line}
        </Text>
        {below}
      </Box>
    )
  })
}
