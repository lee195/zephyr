import { expect, mock, test } from 'claude-code/testing'
import type { HttpInit, On } from 'claude-code'

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

// Stands in for the engine: one session, a server answering `status` (or refusing, or hanging), a model that echoes.
function engine(on: On, opts: { deny?: string; status?: string | 'refused' | 'hangs' } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/Users/me' })
  const session = mock.session(on)
  const seen = { filled: [] as string[], fetched: [] as Fetched[] }
  const status = { text: opts.status }
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
    const text = e.url.endsWith('/status') ? (status.text ?? '{"up":true,"runsInFlight":0,"lastViewAt":null}') : '{}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="beneath">
        <Text>beneath</Text>
      </Box>
    )
  })
  const notes = () =>
    session.appended().map(r => {
      const block = r.message.content[0]
      return block && 'text' in block ? String(block.text) : ''
    })
  return { clock, seen, status, notes }
}

test('off by default: a prompt reaches the model', async ($, on) => {
  const { notes } = engine(on)
  expect(await $.prompt.submit(typed('hello'))).toEqual({ text: 'hello' })
  expect(notes()).toEqual([])
})

test('in notes mode a prompt is appended as a note and dropped, and the box clears', async ($, on) => {
  const { clock, seen, notes } = engine(on)
  await $.command.run(TOGGLE)
  expect(await $.prompt.submit(typed('buy milk'))).toEqual({ drop: 'noted' })
  expect(notes()).toEqual(['[zephyr] buy milk'])
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
  const { clock, seen } = engine(on, { deny: 'quota' })
  await $.command.run(TOGGLE)
  expect(await $.prompt.submit(typed('buy milk'))).toEqual({ drop: 'not noted: quota' })
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
