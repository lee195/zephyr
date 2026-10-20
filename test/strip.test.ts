import { expect, test } from 'bun:test'
import type { Run, RunStatus } from '../src/domain'
import { hrefOf, parseRoute, stripOf } from '../viewer/src/live'

let seq = 0
const run = (kind: string, status: RunStatus, endedAt?: string, extra: Partial<Run> = {}): Run => ({
  id: `r${seq++}`,
  kind,
  entryIds: ['n0'],
  status,
  attempt: 1,
  endedAt,
  ...extra,
})

test('failed runs collapse to one group per kind, after in-flight and done runs', () => {
  const s = stripOf([
    run('organizer', 'done', '2026-10-19T10:00:00Z'),
    run('tasks', 'failed', '2026-10-19T10:01:00Z', { error: 'old' }),
    run('visualizer', 'failed', '2026-10-19T10:01:00Z'),
    run('tasks', 'failed', '2026-10-19T10:03:00Z', { error: 'newest' }),
    run('tasks', 'failed', '2026-10-19T10:02:00Z', { error: 'middle' }),
    run('organizer', 'running'),
  ])
  expect(s.runs.map((r) => `${r.kind}:${r.status}`)).toEqual(['organizer:running', 'organizer:done'])
  expect(s.failed.map((g) => [g.kind, g.count, g.latest.error])).toEqual([
    ['tasks', 3, 'newest'],
    ['visualizer', 1, undefined],
  ])
})

test('a kind done after its latest failure is marked recovered and sorts after current failures', () => {
  const s = stripOf([
    run('tasks', 'failed', '2026-10-19T10:01:00Z'),
    run('tasks', 'done', '2026-10-19T10:02:00Z'),
    run('visualizer', 'failed', '2026-10-19T09:00:00Z'),
  ])
  expect(s.failed.map((g) => [g.kind, g.recoveredAt])).toEqual([
    ['visualizer', undefined],
    ['tasks', '2026-10-19T10:02:00Z'],
  ])
})

test('only the newest three done runs show, newest first; the rest are on the activity page', () => {
  const done = Array.from({ length: 15 }, (_, i) => run('organizer', 'done', `2026-10-19T10:${String(i).padStart(2, '0')}:00Z`))
  const s = stripOf(done)
  expect(s.runs).toEqual([done[14], done[13], done[12]])
  expect(s.runs[0]).toBe(done[14]!)
})

test('done runs that needed no model call stay out of the strip', () => {
  const called = run('map', 'done', '2026-10-19T10:00:00Z')
  const idle = { ...run('map', 'done', '2026-10-19T10:01:00Z'), noCall: true as const }
  expect(stripOf([called, idle]).runs).toEqual([called])
})

test('every page route reads back from the hash it writes, summaries included', () => {
  for (const r of [{ page: 'space', slug: 'home-life' }, { page: 'tasks' }, { page: 'activity' }, { page: 'summaries' }, { page: 'all' }] as const)
    expect(parseRoute(hrefOf(r))).toEqual(r)
  expect(parseRoute('#/nowhere')).toBeNull()
})
