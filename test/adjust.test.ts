import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { Adjustment, AdjustmentResult, ChatMessage, ModelBackend, View } from '../src/domain'
import { parseAdjustment } from '../src/adjust'
import { kinds } from '../src/kinds'
import { Zephyr } from '../src/zephyr'
import { entry, eventually, filesUnder, gate, payloadOf, tempDir } from './helpers'

type Call = 'file' | 'tasks' | 'rewrite' | 'draw'

/**
 * Plays every kind. Organizer: "<slug>: text" files text under <slug>, appending when the topic exists;
 * "<slug>: text => Title" also retitles; "cite <id>" in the text cites that note too. Tasks: a note containing "todo <x>" adds task x. A rewrite makes the page
 * one bullet per note it is shown. The visualizer draws the title as ASCII. calls logs "<call> <detail>" in order;
 * hold(call) holds calls of that type until release().
 */
function desk() {
  const calls: string[] = []
  const held = gate<[call: Call]>()
  const sent: Record<Call, any[]> = { file: [], tasks: [], rewrite: [], draw: [] }
  const backend: ModelBackend = {
    async complete(messages: ChatMessage[]) {
      const p = payloadOf(messages)
      const call: Call = 'notes' in p ? 'rewrite' : 'openTasks' in p ? 'tasks' : 'openTopics' in p ? 'file' : 'draw'
      sent[call].push(p)
      calls.push(`${call} ${call === 'rewrite' ? p.slug : call === 'draw' ? p.title : p.newEntries.map((e: any) => e.id).join(',')}`)
      await held.pass(call)
      if (call === 'rewrite') return { json: { slug: p.slug, title: p.title, sources: p.notes.map((n: any) => n.id), body: p.notes.map((n: any) => `- ${n.text}`).join('\n') } }
      if (call === 'draw') return { json: { format: 'ascii', body: p.title } }
      if (call === 'tasks') {
        const ops = p.newEntries.flatMap((e: any) => {
          const m = /todo (.*)$/.exec(e.text)
          return m ? [{ op: 'add', text: m[1], sources: [e.id] }] : []
        })
        return { json: { ops } }
      }
      const known = new Set<string>([...p.openTopics.map((t: any) => t.slug), ...p.topicIndex.map((l: string) => l.split(' | ')[0])])
      const ops = p.newEntries.flatMap((e: any) => {
        const m = /^([a-z-]+): (.*?)(?: => (.*))?$/.exec(e.text)
        if (!m) return []
        const [, slug, body, retitle] = m
        const op = known.has(slug!) ? { op: 'append', ...(retitle && { title: retitle }) } : { op: 'write', title: slug!.toUpperCase() }
        known.add(slug!)
        const extra = [...e.text.matchAll(/cite (\S+)/g)].map((c) => c[1])
        return [{ ...op, slug, sources: [e.id, ...extra], body }]
      })
      return { json: { ops } }
    },
  }
  return { backend, calls, sent, hold: (call: Call) => held.hold((c) => c === call), release: held.release }
}

const ALL = { organizer: kinds.organizer!, tasks: kinds.tasks!, visualizer: kinds.visualizer! }

async function started(opts: { dir?: string; kinds?: typeof ALL | { organizer: typeof ALL.organizer } } = {}) {
  const d = desk()
  const dir = opts.dir ?? (await tempDir())
  const z = new Zephyr({ dataDir: dir, backend: d.backend, kinds: opts.kinds ?? ALL, retryDelaysMs: [] })
  await z.start()
  await z.idle()
  let n = 0
  const note = async (...texts: string[]) => {
    await z.ingest(texts.map((t) => entry(`e${++n}`, t)))
    await z.idle()
  }
  const view = (id: string) => z.listViews().find((v) => v.id === id)
  const adjust = async (a: Adjustment) => {
    const result = await z.adjust(a)
    await z.idle()
    return result
  }
  return { z, d, dir, note, view, adjust }
}

const ok = (over: Partial<Extract<AdjustmentResult, { ok: true }>>) => ({ id: expect.any(String), ok: true as const, written: [], deleted: [], rewrites: [], warnings: [], ...over })

test('a rename made while an organizer run is held applies after that run, and later retitles are dropped', async () => {
  const { z, d, note, view } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue')
  d.hold('file')
  await z.ingest([entry('late', 'party: cake')])
  await eventually(() => d.calls.includes('file late'))
  const renamed = z.adjust({ op: 'renameTopic', slug: 'party', title: 'Summer Party' })
  await Bun.sleep(20)
  d.release()
  expect(await renamed).toEqual(ok({ written: ['organizer/party'] }))
  await z.idle()
  expect(view('organizer/party')).toMatchObject({ title: 'Summer Party', sources: ['e1', 'late'], body: 'venue\n\ncake', pins: { title: true } })

  await note('party: music => Party Time')
  expect(view('organizer/party')!.title).toBe('Summer Party')
  expect(z.listRuns().at(-1)!.dropped).toEqual(['append party: title is pinned, "Party Time" dropped'])
})

test('a moved note leaves its old page, which is rewritten without it, with the old body in .history', async () => {
  const { d, dir, note, view, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'party: cake', 'garden: tomatoes')
  const before = view('organizer/party')!

  expect(await adjust({ op: 'moveNote', noteId: 'e2', from: 'party', to: 'garden' })).toEqual(
    ok({ written: ['organizer/party', 'organizer/garden'], rewrites: ['organizer/party', 'organizer/garden'] }),
  )
  expect(view('organizer/party')).toMatchObject({ sources: ['e1'], body: '- party: venue', pins: { excluded: ['e2'] } })
  expect(view('organizer/party')!.bodyStale).toBeUndefined()
  expect(view('organizer/garden')).toMatchObject({ sources: ['e2', 'e3'], body: '- party: cake\n- garden: tomatoes' })
  expect(d.sent.rewrite.find((p) => p.slug === 'party').notes.map((n: any) => n.id)).toEqual(['e1'])
  const history = await filesUnder(join(dir, 'views/organizer/.history/party'))
  expect(await Promise.all(history.map((f) => readFile(join(dir, 'views/organizer/.history/party', f), 'utf8')))).toContain(before.body)
  expect(before.body).toBe('venue\n\ncake')

  await note('party: cake again')
  expect(view('organizer/party')!.sources).toEqual(['e1', 'e4'])
})

test('a filing reply that cites a moved note on its old page drops it with a reason', async () => {
  const { z, note, view, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'party: cake', 'garden: tomatoes')
  await adjust({ op: 'moveNote', noteId: 'e2', from: 'party', to: 'garden' })
  await note('party: more cake, cite e2')
  expect(view('organizer/party')!.sources).toEqual(['e1', 'e4'])
  expect(view('organizer/garden')!.sources).toEqual(['e2', 'e3'])
  expect(z.listRuns().at(-1)!.dropped).toEqual(['append party: excluded from this topic: e2'])
})

test('move and detach refuse what would orphan a note or misname the op, and change nothing', async () => {
  const { z, note, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'garden: tomatoes', 'garden: beans')
  const views = JSON.stringify(z.listViews())
  expect(await adjust({ op: 'moveNote', noteId: 'e1', from: 'party', to: 'garden' })).toEqual({ id: expect.any(String), ok: false, error: 'note e1 is the only note on party; merge party into garden instead' })
  expect(await adjust({ op: 'detachNote', noteId: 'e2', from: 'garden', to: 'party' })).toMatchObject({ ok: false, error: 'topic party does not cite note e2; moveNote puts it there' })
  expect(await adjust({ op: 'moveNote', noteId: 'e2', from: 'garden', to: 'nowhere' })).toMatchObject({ ok: false, error: 'no topic nowhere' })
  expect(JSON.stringify(z.listViews())).toBe(views)
})

test('detach takes a shared note off one topic and keeps it on the other', async () => {
  const { note, view, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'party: flowers for the tables', 'garden: grow flowers, cite e2')
  expect(view('organizer/garden')!.sources).toEqual(['e2', 'e3'])
  expect(await adjust({ op: 'moveNote', noteId: 'e2', from: 'garden', to: 'party' })).toMatchObject({ ok: false, error: 'topic party already cites note e2; detachNote takes it off garden' })
  expect(await adjust({ op: 'detachNote', noteId: 'e2', from: 'garden', to: 'party' })).toEqual(ok({ written: ['organizer/garden'], rewrites: ['organizer/garden'] }))
  expect(view('organizer/garden')).toMatchObject({ sources: ['e3'], body: '- garden: grow flowers, cite e2', pins: { excluded: ['e2'] } })
  expect(view('organizer/party')!.sources).toEqual(['e1', 'e2'])
  expect(await adjust({ op: 'detachNote', noteId: 'e2', from: 'garden', to: 'party' })).toEqual(ok({}))
})

test('a topic that drops below four notes loses its diagram; one still at four or more is redrawn once', async () => {
  const { d, note, view, adjust } = await started()
  await note('party: a', 'party: b', 'party: c', 'party: d', 'garden: x', 'garden: y', 'garden: z', 'garden: w')
  expect(view('visualizer/party')).toBeDefined()
  d.calls.length = 0
  const result = await adjust({ op: 'moveNote', noteId: 'e1', from: 'party', to: 'garden' })
  expect(result).toMatchObject({ ok: true, rewrites: ['organizer/party', 'organizer/garden'] })
  expect(view('visualizer/party')).toBeUndefined()
  expect(d.calls.filter((c) => c.startsWith('draw'))).toEqual(['draw GARDEN'])
  expect(view('visualizer/garden')!.derivedFrom!.updatedAt).toBe(view('organizer/garden')!.updatedAt)
})

test('merge appends the old body to the target, deletes the old page and its diagram, and later notes on the old slug land on the target', async () => {
  const { d, dir, note, view, adjust } = await started()
  await note('camping: tent', 'camping: stove', 'camping: map', 'camping: lamp', 'trip: train')
  const old = view('organizer/camping')!
  expect(view('visualizer/camping')).toBeDefined()
  d.hold('rewrite')
  const merged = adjust({ op: 'mergeTopics', from: 'camping', into: 'trip' })
  await eventually(() => d.calls.includes('rewrite trip'))
  expect(view('organizer/trip')).toMatchObject({ sources: ['e1', 'e2', 'e3', 'e4', 'e5'], body: `train\n\n## CAMPING\n\n${old.body}`, pins: { aliases: ['camping'] }, bodyStale: true })
  d.release()
  expect(await merged).toEqual(ok({ written: ['organizer/trip'], deleted: ['organizer/camping'], rewrites: ['organizer/trip'] }))

  expect(view('organizer/camping')).toBeUndefined()
  expect(view('visualizer/camping')).toBeUndefined()
  expect(await filesUnder(join(dir, 'views/organizer'))).not.toContain('camping.json')
  expect(await filesUnder(join(dir, 'views/visualizer'))).not.toContain('camping.json')
  expect(await readFile(join(dir, 'views/organizer/.history/camping', `${old.updatedAt}.md`), 'utf8')).toBe(old.body)
  expect(view('organizer/trip')!.body).toBe('- camping: tent\n- camping: stove\n- camping: map\n- camping: lamp\n- trip: train')

  await note('camping: sleeping bag')
  expect(view('organizer/camping')).toBeUndefined()
  expect(view('organizer/trip')!.sources.at(-1)).toBe('e6')
})

test('split moves some notes to a new topic with a pinned title; both pages are rewritten', async () => {
  const { note, view, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'party: cake', 'party: budget')
  expect(await adjust({ op: 'splitTopic', slug: 'party', noteIds: ['e3'], into: { slug: 'Party Budget', title: 'Party budget' } })).toEqual(
    ok({ written: ['organizer/party', 'organizer/party-budget'], rewrites: ['organizer/party', 'organizer/party-budget'] }),
  )
  expect(view('organizer/party')).toMatchObject({ sources: ['e1', 'e2'], body: '- party: venue\n- party: cake', pins: { excluded: ['e3'] } })
  expect(view('organizer/party-budget')).toMatchObject({ title: 'Party budget', sources: ['e3'], body: '- party: budget', pins: { title: true } })
  expect(await adjust({ op: 'splitTopic', slug: 'party', noteIds: ['e1', 'e2'], into: { slug: 'x', title: 'X' } })).toMatchObject({ ok: false, error: 'that is every note on party; renameTopic renames it' })
})

test('an edit changes what kinds and hints see, rewrites the pages citing the note, and does not re-run tasks', async () => {
  const { z, d, note, view, adjust } = await started()
  await note('party: venue is the barn', 'party: todo book the barn')
  const taskCalls = d.calls.filter((c) => c.startsWith('tasks')).length
  expect(await adjust({ op: 'editNote', noteId: 'e1', text: 'party: venue is the boathouse' })).toEqual(ok({ written: ['organizer/party'], rewrites: ['organizer/party'] }))

  expect(z.listEntries().find((e) => e.id === 'e1')!.text).toBe('party: venue is the boathouse')
  expect(view('organizer/party')!.body).toBe('- party: venue is the boathouse\n- party: todo book the barn')
  expect(d.calls.filter((c) => c.startsWith('tasks'))).toHaveLength(taskCalls)
  expect(view('tasks/tasks')!.tasks!.map((t) => t.text)).toEqual(['book the barn'])
  expect((await z.hints('boathouse venue', 3)).hints.map((h) => [h.entryId, h.text])).toEqual([['e1', 'party: venue is the boathouse']])
  await note('party: drinks')
  expect(d.sent.file.at(-1).recentEntries.find((e: any) => e.id === 'e1').text).toBe('party: venue is the boathouse')
})

test('a tombstoned note leaves every source list, hints, and the ids a filing reply may cite', async () => {
  const { z, d, note, view, adjust } = await started()
  await note('party: venue', 'party: todo buy cake', 'garden: cake for the bees')
  const result = await adjust({ op: 'tombstoneNote', noteId: 'e2' })
  expect(result).toEqual(ok({ written: ['organizer/party'], rewrites: ['organizer/party'], warnings: ['task t1 came only from this note and stays; deleteTask removes it'] }))

  expect(z.listEntries().map((e) => e.id)).toEqual(['e1', 'e3'])
  expect(z.listViews().filter((v) => v.sources.includes('e2'))).toEqual([])
  expect(view('tasks/tasks')!.tasks).toEqual([{ id: 't1', text: 'buy cake', done: false, sources: [] }])
  expect(view('organizer/party')!.body).toBe('- party: venue')
  expect((await z.hints('buy cake', 5)).hints.map((h) => h.entryId)).toEqual(['e3'])

  d.calls.length = 0
  await z.ingest([entry('e2', 'party: todo buy cake'), entry('e4', 'party: drinks, cite e2')])
  await z.idle()
  expect(d.calls).toContain('file e4')
  expect(d.sent.file.at(-1).recentEntries.map((e: any) => e.id)).not.toContain('e2')
  expect(view('organizer/party')!.sources).toEqual(['e1', 'e4'])
})

test('a tombstone takes the only note of a topic with the topic and its diagram', async () => {
  const { note, view, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'garden: beans')
  expect(await adjust({ op: 'tombstoneNote', noteId: 'e2' })).toEqual(ok({ deleted: ['organizer/garden'] }))
  expect(view('organizer/garden')).toBeUndefined()
  expect(await adjust({ op: 'tombstoneNote', noteId: 'e2' })).toEqual(ok({}))
})

test('task ops apply through the tasks queue, after a tasks run in flight, and survive it', async () => {
  const { z, d, note, view, adjust } = await started()
  await note('party: todo buy cake', 'party: todo rent chairs')
  d.hold('tasks')
  await z.ingest([entry('e3', 'party: todo hire band')])
  await eventually(() => d.calls.includes('tasks e3'))
  const completed = z.adjust({ op: 'completeTask', taskId: 't1' })
  await Bun.sleep(20)
  expect(view('tasks/tasks')!.tasks!.find((t) => t.id === 't1')!.done).toBe(false)
  d.release()
  expect(await completed).toEqual(ok({ written: ['tasks/tasks'] }))
  await z.idle()
  expect(view('tasks/tasks')!.tasks!.map((t) => [t.id, t.done])).toEqual([['t1', true], ['t2', false], ['t3', false]])

  expect(await adjust({ op: 'editTask', taskId: 't2', text: 'rent 40 chairs', due: '2026-11-01' })).toMatchObject({ ok: true })
  expect(await adjust({ op: 'deleteTask', taskId: 't3' })).toMatchObject({ ok: true })
  expect(view('tasks/tasks')).toMatchObject({ body: '- [ ] rent 40 chairs (due 2026-11-01)\n- [x] buy cake', sources: ['e1', 'e2'] })
  expect(await adjust({ op: 'deleteTask', taskId: 't3' })).toMatchObject({ ok: false, error: 'no task t3' })
})

/** Every view and entry as a restart would compare them. */
const snapshot = (z: Zephyr) => ({ views: z.listViews().sort((a, b) => a.id.localeCompare(b.id)), entries: z.listEntries() })

test('a restart replays adjustments.jsonl to the same views and effective entries, and calls nothing', async () => {
  const { z, dir, note, adjust } = await started()
  await note('party: venue', 'party: cake', 'party: todo buy cake', 'garden: beans', 'trip: train', 'camping: tent')
  await adjust({ op: 'renameTopic', slug: 'party', title: 'Summer Party' })
  await adjust({ op: 'moveNote', noteId: 'e2', from: 'party', to: 'garden' })
  await adjust({ op: 'mergeTopics', from: 'camping', into: 'trip' })
  await adjust({ op: 'editNote', noteId: 'e4', text: 'garden: broad beans' })
  await adjust({ op: 'tombstoneNote', noteId: 'e5' })
  await adjust({ op: 'completeTask', taskId: 't1' })
  const before = snapshot(z)
  z.stop()

  for (let i = 0; i < 2; i++) {
    const again = await started({ dir })
    expect(snapshot(again.z)).toEqual(before)
    expect(again.d.calls).toEqual([])
    again.z.stop()
  }
})

test('a request a crash left without a result is applied on the next start, once', async () => {
  const { z, dir, note } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue', 'party: cake', 'garden: beans')
  z.stop()
  await appendFile(join(dir, 'adjustments.jsonl'), JSON.stringify({ type: 'request', id: 'adj-crashed', at: '2026-10-19T10:00:00.000Z', adjustment: { op: 'moveNote', noteId: 'e2', from: 'party', to: 'garden' } }) + '\n')

  const restarted = await started({ dir, kinds: { organizer: ALL.organizer } })
  expect(restarted.view('organizer/party')).toMatchObject({ sources: ['e1'], body: '- party: venue' })
  expect(restarted.view('organizer/garden')!.sources).toEqual(['e2', 'e3'])
  const lines = (await readFile(join(dir, 'adjustments.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  expect(lines.at(-1)).toMatchObject({ type: 'result', id: 'adj-crashed', result: { ok: true } })
  const after = snapshot(restarted.z)
  restarted.z.stop()

  const third = await started({ dir, kinds: { organizer: ALL.organizer } })
  expect(snapshot(third.z)).toEqual(after)
  expect(third.d.calls).toEqual([])
})

test('a merge a crash cut short after writing the target finishes on the next start without appending twice', async () => {
  const { z, dir, note, view } = await started({ kinds: { organizer: ALL.organizer } })
  await note('camping: tent', 'trip: train')
  const merge = { op: 'mergeTopics', from: 'camping', into: 'trip' } as const
  const deleteView = z.store.deleteView.bind(z.store)
  z.store.deleteView = async () => {
    throw new Error('disk gone')
  }
  await expect(z.adjust(merge)).rejects.toThrow('disk gone')
  await z.idle()
  const half = view('organizer/trip')!
  expect(half.pins!.aliases).toEqual(['camping'])
  z.store.deleteView = deleteView
  z.stop()

  const restarted = await started({ dir, kinds: { organizer: ALL.organizer } })
  expect(restarted.view('organizer/camping')).toBeUndefined()
  expect(restarted.view('organizer/trip')!.body).toBe('- camping: tent\n- trip: train')
  expect(restarted.d.sent.rewrite.map((p) => p.body)).toEqual([half.body])
  expect(half.body).toBe('train\n\n## CAMPING\n\ntent')
})

test('a note tombstoned while waiting to be filed is never sent to the model and is not retried as uncovered', async () => {
  const { z, d, note, adjust } = await started({ kinds: { organizer: ALL.organizer } })
  await note('party: venue')
  d.hold('file')
  await z.ingest([entry('e2', 'party: cake')])
  await eventually(() => d.calls.includes('file e2'))
  await z.ingest([entry('e3', 'party: oops'), entry('e4', 'party: music')])
  const gone = [z.adjust({ op: 'tombstoneNote', noteId: 'e3' }), z.adjust({ op: 'tombstoneNote', noteId: 'e4' })]
  await Bun.sleep(20)
  d.release()
  await Promise.all(gone)
  await z.idle()
  expect(d.calls.filter((c) => c.startsWith('file'))).toEqual(['file e1', 'file e2'])
  expect(z.listRuns().at(-1)).toMatchObject({ entryIds: ['e3', 'e4'], status: 'done' })

  d.hold('file')
  await z.ingest([entry('e5', 'party: games')])
  await eventually(() => d.calls.includes('file e5'))
  await z.ingest([entry('e6', 'party: oops'), entry('e7', 'party: lights')])
  const one = z.adjust({ op: 'tombstoneNote', noteId: 'e6' })
  await Bun.sleep(20)
  d.release()
  await one
  await z.idle()
  expect(d.calls.at(-1)).toBe('file e7')
  expect(z.listRuns().filter((r) => r.uncovered)).toEqual([])
})

test('parseAdjustment takes each op with its fields and refuses a missing or mistyped one', () => {
  expect(parseAdjustment({ op: 'splitTopic', slug: 'party', noteIds: ['e1', 'e1'], into: { slug: 'cake', title: 'Cake' } })).toEqual({
    ok: true,
    adjustment: { op: 'splitTopic', slug: 'party', noteIds: ['e1'], into: { slug: 'cake', title: 'Cake' } },
  })
  expect(parseAdjustment({ op: 'editTask', taskId: 't1', due: null })).toEqual({ ok: true, adjustment: { op: 'editTask', taskId: 't1', due: null } })
  expect(parseAdjustment({ op: 'editTask', taskId: 't1' })).toEqual({ ok: false, error: 'editTask needs text or due' })
  expect(parseAdjustment({ op: 'editTask', taskId: 't1', text: ' ' })).toEqual({ ok: false, error: 'editTask text must be a non-empty string' })
  expect(parseAdjustment({ op: 'splitTopic', slug: 'party', noteIds: [], into: { slug: 'x', title: 'X' } })).toMatchObject({ ok: false })
  expect(parseAdjustment({ op: 'moveNote', noteId: 'e1', from: 'a' })).toEqual({ ok: false, error: 'moveNote needs non-empty strings: to' })
  expect(parseAdjustment({ op: 'toString' })).toMatchObject({ ok: false })
  expect(parseAdjustment(null)).toMatchObject({ ok: false })
})

test('editing a task due to null clears it', async () => {
  const { note, view, adjust } = await started()
  await note('party: todo buy cake')
  await adjust({ op: 'editTask', taskId: 't1', due: 'Friday' })
  expect(view('tasks/tasks')!.tasks![0]).toEqual({ id: 't1', text: 'buy cake', due: 'Friday', done: false, sources: ['e1'] })
  await adjust({ op: 'editTask', taskId: 't1', due: null })
  expect(view('tasks/tasks')!.tasks![0]).toEqual({ id: 't1', text: 'buy cake', done: false, sources: ['e1'] })
})
