import { expect, mock, test } from 'claude-code/testing'
import type { Engine, EngineCall } from 'claude-code/testing'
import type { HttpInit, On, PromptEditInput } from 'claude-code'

type Fetched = { url: string; init?: HttpInit }

const BAND = {
  plugin: 'zephyr',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const TOGGLE = {
  command: 'zephyr',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

/** Typing `added` at the end of `draft`. */
const keyed = (draft: string, added: string): PromptEditInput => ({
  origin: { kind: 'composer' },
  text: draft,
  cursor: draft.length,
  start: draft.length,
  end: draft.length,
  inputText: added,
})

// The kit raises these as the engine does, but its `Engine` type lists only what a plugin's own `$` may call.
const box = ($: Engine) => $.prompt as Engine['prompt'] & { edit: EngineCall<'prompt.edit'>; change: EngineCall<'prompt.change'> }

const HINTS = JSON.stringify({
  hints: [
    { entryId: 'e1', text: 'oat milk is cheaper\nat the corner shop', at: '2026-10-18T09:00:00Z', score: 0.9, topic: { slug: 'groceries', title: 'Groceries' } },
    { entryId: 'e2', text: 'call mum', at: '2026-10-17T09:00:00Z', score: 0.4, topic: null },
  ],
})

// Stands in for the engine: one session, a server answering `status` and `hints` (or refusing, or hanging), a model that echoes.
// `hints: 'held'` keeps each hints request open until the test answers it through `answer`.
function engine(on: On, opts: { deny?: string; status?: string | 'refused' | 'hangs'; hints?: string | 'held'; review?: string } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/me' })
  const session = mock.session(on)
  const seen = { filled: [] as string[], fetched: [] as Fetched[], edits: [] as PromptEditInput[] }
  const status = { text: opts.status }
  const held: Array<(text: string) => void> = []
  const reply = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/Users/me/ai-workspace/zephyr' }))
  if (opts.deny) on('session.append', { door: 'note' }, () => ({ deny: opts.deny ?? '' }))
  on('prompt.fill', (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: 0 }
  })
  on('http.fetch', (_$, e) => {
    seen.fetched.push(e)
    if (status.text === 'refused') throw new Error('connection refused')
    if (status.text === 'hangs') return new Promise<never>(() => undefined)
    if (e.url.endsWith('/status')) return reply(status.text ?? '{"up":true,"runsInFlight":0,"lastViewAt":null}')
    if (e.url.endsWith('/api/review')) return reply(opts.review ?? '{}')
    if (!e.url.includes('/hints?')) return reply('{}')
    if (opts.hints === 'held') return new Promise<ReturnType<typeof reply>>(resolve => held.push(text => resolve(reply(text))))
    return reply(opts.hints ?? HINTS)
  })
  on('prompt.edit', (_$, e) => {
    seen.edits.push(e)
    return { text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }
  })
  on('prompt.change', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="beneath">
        <Text>beneath</Text>
      </Box>
    )
  })
  const rows = (type: string) =>
    session
      .appended()
      .filter(r => r.message.type === type)
      .map(r => {
        const block = r.message.content[0]
        return block && 'text' in block ? String(block.text) : ''
      })
  const notes = () => rows('user')
  const notices = () => rows('system')
  const hintRequests = () => seen.fetched.filter(f => f.url.includes('/hints?')).map(f => f.url)
  const answer = (i: number, text: string) => held[i]?.(text)
  return { clock, seen, status, notes, notices, hintRequests, answer }
}

async function bandTexts($: Engine) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  await ui.unmount()
  return texts
}

test('off by default: a prompt reaches the model', async ($, on) => {
  const { notes } = engine(on)
  expect(await $.prompt.submit(typed('hello'))).toEqual({ text: 'hello' })
  expect(notes()).toEqual([])
})

test('in notes mode a prompt is appended as a note and dropped, and the box clears', async ($, on) => {
  const { clock, seen, notes, notices } = engine(on)
  await $.command.run(TOGGLE)
  expect(await $.prompt.submit(typed('buy milk'))).toEqual({ drop: 'noted' })
  expect(notes()).toEqual(['[zephyr] buy milk'])
  expect(notices()).toEqual(['✎ buy milk'])
  await clock.settle()
  expect(seen.filled).toEqual([''])
})

test('in notes mode slash commands and plugin prompts pass through', async ($, on) => {
  const { notes } = engine(on)
  await $.command.run(TOGGLE)
  const command = { ...typed('/model'), command: { name: 'model', args: '' } }
  expect(await $.prompt.submit(command)).toEqual({ text: '/model' })
  const fromPlugin = { text: 'run checks', wait: false, origin: { kind: 'plugin' as const, name: 'other' } }
  expect(await $.prompt.submit(fromPlugin)).toEqual({ text: 'run checks' })
  expect(notes()).toEqual([])
})

test('a refused append drops with the reason and keeps the draft', async ($, on) => {
  const { clock, seen, notices } = engine(on, { deny: 'quota' })
  await $.command.run(TOGGLE)
  expect(await $.prompt.submit(typed('buy milk'))).toEqual({ drop: 'not noted: quota' })
  expect(notices()).toEqual([])
  await clock.settle()
  expect(seen.filled).toEqual([])
})

test('toggling off lets prompts through again', async ($, on) => {
  const { notes } = engine(on)
  await $.command.run(TOGGLE)
  await $.command.run(TOGGLE)
  expect(await $.prompt.submit(typed('hello'))).toEqual({ text: 'hello' })
  expect(notes()).toEqual([])
})

test('turning notes on registers the session with the server', async ($, on) => {
  const { clock, seen } = engine(on)
  await $.command.run(TOGGLE)
  await clock.settle()
  const post = seen.fetched.find(f => f.url === 'http://127.0.0.1:7317/sessions')
  expect(post?.init?.method).toBe('POST')
  expect(JSON.parse(post?.init?.body ?? '{}')).toEqual({
    harness: 'claude-code',
    sessionId: 'sess-1',
    transcriptPath: '/Users/me/.claude/projects/-Users-me-ai-workspace-zephyr/sess-1.jsonl',
  })
})

test('the port comes from the plugin options', { options: { port: 9001 } }, async ($, on) => {
  const { clock, seen } = engine(on)
  await $.command.run(TOGGLE)
  await clock.settle()
  expect(seen.fetched.some(f => f.url === 'http://127.0.0.1:9001/sessions')).toBe(true)
})

test('the band is hidden while notes mode is off', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /zephyr/ })).toBeUndefined()
  expect(await ui.find({ text: /beneath/ })).toBeDefined()
  await ui.unmount()
})

test('the band shows the server, keeps what is beneath, and says down within one poll of the server stopping', async ($, on) => {
  const { clock, status, notes } = engine(on, { status: '{"up":true,"runsInFlight":2,"lastViewAt":940000}' })
  await $.command.run(TOGGLE)
  await clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /zephyr · notes on · server up · 2 runs · last view 1m ago/ })).toBeDefined()
    expect(await ui.find({ text: /beneath/ })).toBeDefined()
    await ui.unmount()
  }

  status.text = 'refused'
  await clock.advance(5000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /zephyr · notes on · server down/ })).toBeDefined()
  await ui.unmount()
  expect(await $.prompt.submit(typed('still here'))).toEqual({ drop: 'noted' })
  expect(notes()).toEqual(['[zephyr] still here'])
})

test('a server that hangs counts as down once the request times out', async ($, on) => {
  const { clock } = engine(on, { status: 'hangs' })
  await $.command.run(TOGGLE)
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /server down/ })).toBeDefined()
  await ui.unmount()
})

test('hints wait for 1 s of quiet, and an edit within it restarts the wait', async ($, on) => {
  const { clock, hintRequests } = engine(on)
  await $.command.run(TOGGLE)
  await clock.settle()
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(999)
  expect(hintRequests()).toEqual([])
  await box($).edit(keyed('buy oat milk', ' today'))
  await clock.advance(999)
  expect(hintRequests()).toEqual([])
  await clock.advance(1)
  expect(hintRequests()).toEqual(['http://127.0.0.1:7317/hints?q=buy%20oat%20milk%20today&limit=3'])
  await clock.advance(5000)
  expect(hintRequests()).toHaveLength(1)
})

test('moving the cursor through a settled draft asks for nothing new', async ($, on) => {
  const { clock, hintRequests } = engine(on)
  await $.command.run(TOGGLE)
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  await box($).edit({ ...keyed('buy oat milk', ''), start: 3, end: 3 })
  await clock.advance(2000)
  expect(hintRequests()).toHaveLength(1)
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toHaveLength(2)
})

test('a one-word draft asks for no hints', async ($, on) => {
  const { clock, hintRequests } = engine(on)
  await $.command.run(TOGGLE)
  await box($).edit(keyed('', 'milk '))
  await clock.advance(2000)
  expect(hintRequests()).toEqual([])
})

test('hints show dim under the status line, one line each, above what is beneath', async ($, on) => {
  const { clock } = engine(on)
  await $.command.run(TOGGLE)
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  expect(await bandTexts($)).toEqual([
    'zephyr · notes on · server up',
    '↳ Groceries · oat milk is cheaper at the corner shop',
    '↳ note · call mum',
    'beneath',
  ])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ text: /^↳ note/ }))?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
  await ui.unmount()
})

test('a reply that arrives after a newer edit is never shown', async ($, on) => {
  const { clock, hintRequests, answer } = engine(on, { hints: 'held' })
  await $.command.run(TOGGLE)
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  expect(hintRequests()).toHaveLength(1)
  await box($).edit(keyed('buy oat milk', ' today'))
  answer(0, HINTS)
  await clock.settle()
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toEqual([])

  await clock.advance(1000)
  answer(1, JSON.stringify({ hints: [{ entryId: 'e3', text: 'today is market day', at: '', score: 1, topic: null }] }))
  await clock.settle()
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toEqual(['↳ note · today is market day'])
})

test('submitting a note clears the hints, and so does an emptied box', async ($, on) => {
  const { clock } = engine(on)
  await $.command.run(TOGGLE)
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toHaveLength(2)
  expect(await $.prompt.submit(typed('buy oat milk'))).toEqual({ drop: 'noted' })
  await clock.settle()
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toEqual([])

  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toHaveLength(2)
  await box($).change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  expect((await bandTexts($)).filter(t => t.startsWith('↳'))).toEqual([])
})

test('with notes mode off there are no hint requests and no hints', async ($, on) => {
  const { clock, hintRequests } = engine(on, { status: '{"up":true,"runsInFlight":1,"lastViewAt":null}' })
  await $.command.run(TOGGLE)
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  expect(hintRequests()).toHaveLength(1)
  await $.command.run(TOGGLE)
  expect(await bandTexts($)).toEqual(['zephyr · notes off · server up · 1 run', 'beneath'])

  await box($).edit(keyed('buy oat milk', ' today'))
  await clock.advance(2000)
  expect(hintRequests()).toHaveLength(1)
  expect(await bandTexts($)).toEqual(['zephyr · notes off · server up · 1 run', 'beneath'])
})

test('a server that is down shows no hints and no error beyond server down', async ($, on) => {
  const { clock, hintRequests } = engine(on, { status: 'refused' })
  await $.command.run(TOGGLE)
  await box($).edit(keyed('buy oat', ' milk'))
  await clock.advance(1000)
  expect(hintRequests()).toHaveLength(1)
  expect(await bandTexts($)).toEqual(['zephyr · notes on · server down', 'beneath'])
})

test('edits pass through unchanged, notes mode on or off', async ($, on) => {
  const { seen } = engine(on)
  const edit = keyed('buy oat', ' milk')
  expect(await box($).edit(edit)).toEqual({ text: 'buy oat milk', cursor: 12 })
  await $.command.run(TOGGLE)
  expect(await box($).edit(edit)).toEqual({ text: 'buy oat milk', cursor: 12 })
  expect(seen.edits).toEqual([edit, edit])
})

const REVIEW = (count: number) => JSON.stringify({ since: null, until: '2026-10-19T12:00:00.000Z', notes: { count, ids: [] } })

test('turning notes mode off says how many notes wait for review, below the reply', async ($, on) => {
  const { clock, notices } = engine(on, { review: REVIEW(3) })
  await $.command.run(TOGGLE)
  expect(notices()).toEqual([])
  expect(await $.command.run(TOGGLE)).toEqual({ text: 'Notes mode off.' })
  await clock.settle()
  expect(notices()).toEqual(['3 notes since last review'])
})

test('turning notes mode off says nothing more when no note waits for review', async ($, on) => {
  const { clock, notices } = engine(on, { review: REVIEW(0) })
  await $.command.run(TOGGLE)
  await $.command.run(TOGGLE)
  await clock.settle()
  expect(notices()).toEqual([])
})

test('turning notes mode off says nothing more when the server is down or hangs', async ($, on) => {
  const { clock, status, notices } = engine(on, { review: REVIEW(3), status: 'refused' })
  await $.command.run(TOGGLE)
  await $.command.run(TOGGLE)
  await clock.settle()
  expect(notices()).toEqual([])

  status.text = 'hangs'
  await $.command.run(TOGGLE)
  expect(await $.command.run(TOGGLE)).toEqual({ text: 'Notes mode off.' })
  await clock.advance(2000)
  expect(notices()).toEqual([])
})
