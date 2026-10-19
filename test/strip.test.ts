import { expect, test } from 'bun:test'
import type { Run, RunStatus } from '../src/domain'
import { stripOf } from '../viewer/src/live'

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

test('only the newest twelve done runs show, newest first', () => {
  const done = Array.from({ length: 15 }, (_, i) => run('organizer', 'done', `2026-10-19T10:${String(i).padStart(2, '0')}:00Z`))
  const s = stripOf(done)
  expect(s.runs).toHaveLength(12)
  expect(s.runs[0]).toBe(done[14]!)
})
