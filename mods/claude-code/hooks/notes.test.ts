import { expect, test } from 'claude-code/testing'

import { ago, bandLine, decide, encodeProjectDir, hintLine, parseHints, parseReviewCount, parseStatus, reviewNotice, transcriptPathFor } from './notes'

const typed = (text: string) => ({ text, origin: { kind: 'composer' as const } })

test('in notes mode a typed prompt becomes a prefixed note', () => {
  expect(decide(typed('  buy milk \n'), true)).toEqual({ kind: 'note', text: '[zephyr] buy milk', echo: '✎ buy milk' })
  expect(decide({ text: 'from my phone', origin: { kind: 'bridge' } }, true)).toEqual({
    kind: 'note',
    text: '[zephyr] from my phone',
    echo: '✎ from my phone',
  })
})

test('commands, meta prompts, other origins, empty text and off mode pass through', () => {
  const pass = { kind: 'pass' }
  expect(decide(typed('buy milk'), false)).toEqual(pass)
  expect(decide({ ...typed('/zephyr'), command: { name: 'zephyr', args: '' } }, true)).toEqual(pass)
  expect(decide({ ...typed('hidden'), isMeta: true }, true)).toEqual(pass)
  expect(decide({ text: 'hi', origin: { kind: 'plugin', name: 'other' } }, true)).toEqual(pass)
  expect(decide({ text: 'done', origin: { kind: 'task-notification' } }, true)).toEqual(pass)
  expect(decide(typed('   '), true)).toEqual(pass)
})

test('a note with an image is refused, not sent to the model', () => {
  const d = decide({ ...typed('look'), attachments: [{ type: 'image' }] }, true)
  expect(d.kind).toBe('refuse')
})

test('the transcript path follows Claude Code project naming', () => {
  expect(encodeProjectDir('/Users/me/ai-workspace/example-project')).toBe('-Users-me-ai-workspace-example-project')
  expect(transcriptPathFor('/Users/me', '/Users/me/ai-workspace/zephyr', 'abc')).toBe(
    '/Users/me/.claude/projects/-Users-me-ai-workspace-zephyr/abc.jsonl',
  )
})

test('status parsing reads the server, and anything else is down', () => {
  expect(parseStatus('{"up":true,"entries":4,"runsInFlight":2,"lastViewAt":1000,"sessions":1}', 9)).toEqual({
    kind: 'up',
    checkedAt: 9,
    entries: 4,
    runsInFlight: 2,
    lastViewAt: 1000,
  })
  const iso = parseStatus('{"up":true,"lastViewAt":"2026-10-19T10:00:00Z"}', 9)
  expect(iso.kind === 'up' && iso.lastViewAt).toBe(Date.parse('2026-10-19T10:00:00Z'))
  expect(parseStatus('{"up":true,"lastViewAt":null}', 9)).toEqual({
    kind: 'up',
    checkedAt: 9,
    entries: 0,
    runsInFlight: 0,
    lastViewAt: null,
  })
  expect(parseStatus('<html>', 9)).toEqual({ kind: 'down', checkedAt: 9 })
  expect(parseStatus('{"up":false}', 9)).toEqual({ kind: 'down', checkedAt: 9 })
})

test('the band line names mode, server, runs and the last view', () => {
  const up = { kind: 'up' as const, checkedAt: 0, entries: 3, runsInFlight: 2, lastViewAt: 0 }
  expect(bandLine(true, up, 120_000)).toBe('zephyr · notes on · server up · 2 runs · last view 2m ago')
  expect(bandLine(true, { ...up, runsInFlight: 0, lastViewAt: null }, 0)).toBe('zephyr · notes on · server up')
  expect(bandLine(true, { kind: 'down', checkedAt: 0 }, 0)).toBe('zephyr · notes on · server down')
  expect(bandLine(false, { ...up, runsInFlight: 1 }, 5_000)).toBe('zephyr · notes off · server up · 1 run · last view 5s ago')
  expect(bandLine(false, { ...up, runsInFlight: 0 }, 0)).toBeNull()
  expect(bandLine(false, { kind: 'unknown' }, 0)).toBeNull()
})

test('ages round down to the largest unit', () => {
  expect(ago(59_000)).toBe('59s')
  expect(ago(3_599_000)).toBe('59m')
  expect(ago(7_200_000)).toBe('2h')
  expect(ago(3 * 86_400_000)).toBe('3d')
})

test('hints parsing keeps up to three readable hints, and anything else is none', () => {
  const hint = (text: unknown, topic: unknown = null) => ({ entryId: 'e', text, at: '', score: 1, topic })
  const body = (hints: unknown) => JSON.stringify({ hints })
  expect(parseHints(body([hint('a  b\nc', { slug: 's', title: 'Shopping' }), hint(''), hint(7), hint('d', { slug: 's' })]))).toEqual([
    { topic: 'Shopping', text: 'a b c' },
    { topic: null, text: 'd' },
  ])
  expect(parseHints(body(['1', '2', '3', '4'].map(t => hint(t))))).toHaveLength(3)
  expect(parseHints('<html>')).toEqual([])
  expect(parseHints('null')).toEqual([])
  expect(parseHints('{"hints":{}}')).toEqual([])
  expect(hintLine({ topic: null, text: 'call mum' })).toBe('↳ note · call mum')
})

test('the review notice counts notes, singular for one, and is absent for none', () => {
  expect(reviewNotice(1)).toBe('1 note since last review')
  expect(reviewNotice(12)).toBe('12 notes since last review')
  expect(reviewNotice(0)).toBeNull()
})

test('the review count is read from notes.count; anything unreadable is no count', () => {
  expect(parseReviewCount('{"notes":{"count":4,"ids":["a","b","c","d"]}}')).toBe(4)
  expect(parseReviewCount('{"notes":{"count":0,"ids":[]}}')).toBe(0)
  for (const text of ['not json', '{}', '{"notes":{"count":"4"}}', '{"notes":{"count":-1}}', 'null']) expect(parseReviewCount(text)).toBeNull()
})
