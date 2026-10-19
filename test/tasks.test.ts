import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { Task, View } from '../src/domain'
import { kinds } from '../src/kinds'
import { Zephyr } from '../src/zephyr'
import { doneRun, entry, filesUnder, payloadOf, scripted, seedDataDir, tempDir } from './helpers'

const onlyTasks = { tasks: kinds.tasks! }

const tasksView = (tasks: Task[]): Omit<View, 'id'> => ({
  kind: 'tasks',
  slug: 'tasks',
  title: 'Tasks',
  format: 'md',
  body: '',
  tasks,
  sources: [...new Set(tasks.flatMap((t) => t.sources))],
  updatedAt: '2026-10-18T00:00:00Z',
})

const anna: Task = { id: 't1', text: 'Call Anna about the venue', due: '2026-10-23', done: false, sources: ['e1'] }

/** e1 is covered and t1 is open; e2 arrives on start. */
const annaDir = (extra: Task[] = []) =>
  seedDataDir({
    entries: [entry('e1'), entry('e2', 'called Anna, venue confirmed')],
    runs: [doneRun('tasks', ['e1'])],
    views: [tasksView([anna, ...extra])],
  })

const tasksOf = (z: Zephyr) => z.listViews().find((v) => v.id === 'tasks/tasks')?.tasks

test('a note with a todo adds an open task, stored as data and rendered as markdown', async () => {
  const dir = await tempDir()
  const fake = scripted({ ops: [{ op: 'add', text: 'Call Anna about the venue', due: '2026-10-23', sources: ['e1'] }] })
  const z = new Zephyr({ dataDir: dir, backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.ingest([entry('e1', 'TODO call Anna Friday about the venue', '2026-10-19T09:00:00Z')])
  await z.idle()

  expect(tasksOf(z)).toEqual([{ id: 't1', text: 'Call Anna about the venue', due: '2026-10-23', done: false, sources: ['e1'] }])
  const stored = JSON.parse(await readFile(join(dir, 'views/tasks/tasks.json'), 'utf8'))
  expect(stored.tasks).toEqual(tasksOf(z))
  expect(await readFile(join(dir, 'views/tasks/tasks.md'), 'utf8')).toBe('- [ ] Call Anna about the venue (due 2026-10-23)')
  expect(payloadOf(fake.sent[0]!).newEntries).toEqual([{ id: 'e1', at: '2026-10-19T09:00:00Z', text: 'TODO call Anna Friday about the venue' }])
})

test('a due date the model could not resolve keeps the note\'s words', async () => {
  const fake = scripted({ ops: [{ op: 'add', text: 'Renew passport', due: 'before the summer trip', sources: ['e1'] }] })
  const z = new Zephyr({ dataDir: await tempDir(), backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.ingest([entry('e1', 'renew passport before the summer trip')])
  await z.idle()
  expect(tasksOf(z)?.[0]?.due).toBe('before the summer trip')
})

test('complete marks the task done by id and cites the note that closed it', async () => {
  const fake = scripted({ ops: [{ op: 'complete', taskId: 't1', sources: ['e2'] }] })
  const z = new Zephyr({ dataDir: await annaDir(), backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.idle()

  expect(tasksOf(z)).toEqual([{ ...anna, done: true, sources: ['e1', 'e2'] }])
  expect(z.listViews()[0]!.body).toBe('- [x] Call Anna about the venue (due 2026-10-23)')
  expect(z.listRuns().at(-1)).toMatchObject({ status: 'done' })
})

test('update changes an open task in place', async () => {
  const fake = scripted({ ops: [{ op: 'update', taskId: 't1', due: '2026-10-26', sources: ['e2'] }] })
  const z = new Zephyr({ dataDir: await annaDir(), backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.idle()
  expect(tasksOf(z)).toEqual([{ ...anna, due: '2026-10-26', sources: ['e1', 'e2'] }])
})

test('ops on unknown or done tasks, with empty text, or citing no new entry are dropped; the rest applies', async () => {
  const done: Task = { id: 't2', text: 'Book the train', done: true, sources: ['e1'] }
  const fake = scripted({
    ops: [
      { op: 'complete', taskId: 't9', sources: ['e2'] },
      { op: 'complete', taskId: 't2', sources: ['e2'] },
      { op: 'add', text: '  ', sources: ['e2'] },
      { op: 'add', text: 'Pay the deposit', sources: ['e1', 'ghost'] },
      { op: 'add', text: 'Send the invite', sources: ['e2', 'ghost'] },
    ],
  })
  const z = new Zephyr({ dataDir: await annaDir([done]), backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.idle()

  expect(tasksOf(z)).toEqual([anna, done, { id: 't3', text: 'Send the invite', done: false, sources: ['e2'] }])
  expect(z.listRuns().at(-1)).toMatchObject({
    status: 'done',
    dropped: ['complete t9: no such open task', 'complete t2: no such open task', 'add: empty text', 'add: no known sources'],
  })
})

test('a reply with no ops is a done run that covers its note and writes nothing', async () => {
  const dir = await tempDir()
  const z = new Zephyr({ dataDir: dir, backend: scripted({ ops: [] }).backend, kinds: onlyTasks })
  await z.start()
  await z.ingest([entry('e1', 'the sky was nice today')])
  await z.idle()
  expect(z.listRuns().map((r) => [r.status, r.uncovered])).toEqual([['done', undefined]])
  expect(z.listViews()).toEqual([])
  expect(await filesUnder(join(dir, 'views'))).toEqual([])
})

test('a reply without an ops array fails the run', async () => {
  const z = new Zephyr({ dataDir: await tempDir(), backend: scripted({ tasks: [] }).backend, kinds: onlyTasks, retryDelaysMs: [] })
  await z.start()
  await z.ingest([entry('e1')])
  await z.idle()
  expect(z.listRuns()[0]).toMatchObject({ status: 'failed', error: 'invalid reply: reply has no ops array' })
})

test('the prompt shows open tasks only, never done ones, and at most thirty of them', async () => {
  const open = Array.from({ length: 40 }, (_, i): Task => ({ id: `t${i + 10}`, text: `open chore ${i}`, done: false, sources: ['e1'] }))
  const fake = scripted({ ops: [] })
  const z = new Zephyr({ dataDir: await annaDir([{ id: 't2', text: 'Book the train', done: true, sources: ['e1'] }, ...open]), backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.idle()

  const shown: { id: string }[] = payloadOf(fake.sent[0]!).openTasks
  expect(shown).toHaveLength(30)
  expect(shown.map((t) => t.id)).toContain('t1')
  expect(fake.sent[0]!.map((m) => m.content).join('\n')).not.toContain('Book the train')
  expect(payloadOf(fake.sent[0]!).newEntries.map((e: any) => e.id)).toEqual(['e2'])
})

test('a new task gets the next free id after the existing ones', async () => {
  const fake = scripted({ ops: [{ op: 'add', text: 'Order flowers', sources: ['e2'] }] })
  const z = new Zephyr({ dataDir: await annaDir([{ id: 't7', text: 'x', done: true, sources: ['e1'] }]), backend: fake.backend, kinds: onlyTasks })
  await z.start()
  await z.idle()
  expect(tasksOf(z)?.map((t) => t.id)).toEqual(['t1', 't7', 't8'])
})
