import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { View } from '../src/domain'
import { kinds } from '../src/kinds'
import { reviewBrief } from '../src/review'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { started } from './desk'
import { entry, scripted, tempDir } from './helpers'

/** e4 fits garden as well as balcony; the desk files it on balcony and asks. */
const NOTES = ['garden: beans', 'balcony: pots', 'balcony: rail', 'balcony: tomatoes ask:garden']

const state = (views: View[]) =>
  views.map(({ id, title, sources, body, pins, bodyStale }) => ({ id, title, sources, body, pins, bodyStale })).sort((a, b) => a.id.localeCompare(b.id))

async function asked() {
  const s = await started()
  await s.note(...NOTES)
  return s
}

test('a doubtful note is filed by its best guess and raises a question with the answers it takes', async () => {
  const s = await asked()
  expect(s.view('organizer/balcony')!.sources).toEqual(['e2', 'e3', 'e4'])
  expect(s.z.listQuestions()).toEqual([
    {
      id: expect.stringMatching(/^q-/),
      askedAt: expect.any(String),
      kind: 'whichTopic',
      note: { id: 'e4', text: NOTES[3] },
      chosen: { slug: 'balcony', title: 'BALCONY' },
      alternatives: [{ slug: 'garden', title: 'GARDEN' }],
      answers: ['keep', 'garden'],
    },
  ])
  s.z.stop()
})

test('answering with the other topic moves the note, to the same state as a direct moveNote', async () => {
  const [viaAnswer, direct] = [await asked(), await asked()]
  const [q] = viaAnswer.z.listQuestions()
  const answered = await viaAnswer.z.answerQuestion(q!.id, 'garden')
  await viaAnswer.z.idle()
  expect(answered).toMatchObject({ ok: true, closed: { how: 'applied' }, adjustment: { ok: true, written: ['organizer/balcony', 'organizer/garden'] } })
  expect(await direct.adjust({ op: 'moveNote', noteId: 'e4', from: 'balcony', to: 'garden' })).toMatchObject({ ok: true })
  expect(viaAnswer.view('organizer/garden')!.sources).toEqual(['e1', 'e4'])
  expect(state(viaAnswer.z.listViews())).toEqual(state(direct.z.listViews()))
  const log = (await readFile(join(viaAnswer.dir, 'adjustments.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  expect(log[0]).toMatchObject({ type: 'request', adjustment: { op: 'moveNote', noteId: 'e4', from: 'balcony', to: 'garden' } })
  expect(viaAnswer.z.listQuestions()).toEqual([])
  viaAnswer.z.stop()
  direct.z.stop()
})

test('keep closes the question and changes nothing', async () => {
  const s = await asked()
  const before = state(s.z.listViews())
  const [q] = s.z.listQuestions()
  expect(await s.z.answerQuestion(q!.id, 'keep')).toEqual({ ok: true, questionId: q!.id, closed: { how: 'kept' } })
  await s.z.idle()
  expect(state(s.z.listViews())).toEqual(before)
  expect(await Bun.file(join(s.dir, 'adjustments.jsonl')).exists()).toBe(false)
  expect(s.z.listQuestions()).toEqual([])
  expect(await s.z.answerQuestion(q!.id, 'garden')).toEqual({ ok: false, error: `no open question ${q!.id}` })
  s.z.stop()
})

test('an answer that is not one of the question\'s answers is refused and the question stays open', async () => {
  const s = await asked()
  const [q] = s.z.listQuestions()
  expect(await s.z.answerQuestion(q!.id, 'balcony-two')).toEqual({ ok: false, error: 'answer must be one of: keep, garden' })
  expect(s.z.listQuestions()).toHaveLength(1)
  s.z.stop()
})

test('a question whose note was moved since closes as moot on any answer, and changes nothing', async () => {
  const s = await asked()
  const [q] = s.z.listQuestions()
  await s.adjust({ op: 'splitTopic', slug: 'balcony', noteIds: ['e4'], into: { slug: 'tomatoes', title: 'Tomatoes' } })
  expect(s.z.listQuestions()[0]!.moot).toBe('note e4 is no longer on balcony')
  const before = state(s.z.listViews())
  expect(await s.z.answerQuestion(q!.id, 'garden')).toEqual({ ok: true, questionId: q!.id, closed: { how: 'moot', reason: 'note e4 is no longer on balcony' } })
  expect(state(s.z.listViews())).toEqual(before)
  expect(s.z.listQuestions()).toEqual([])
  s.z.stop()
})

test('a task the run doubts is a question; answering deleteTask deletes it, and a tombstoned note makes it moot', async () => {
  const s = await started()
  await s.note('garden: todo water the beans ask:task', 'garden: todo buy a hose ask:task')
  const [first, second] = s.z.listQuestions()
  expect(second).toMatchObject({ kind: 'isTask', note: { id: 'e2' }, task: { id: 't2', text: 'buy a hose ask:task' }, answers: ['keep', 'deleteTask'] })
  expect(await s.z.answerQuestion(second!.id, 'deleteTask')).toMatchObject({ ok: true, closed: { how: 'applied' } })
  expect(s.view('tasks/tasks')!.tasks!.map((t) => t.id)).toEqual(['t1'])
  await s.adjust({ op: 'tombstoneNote', noteId: 'e1' })
  expect(await s.z.answerQuestion(first!.id, 'deleteTask')).toMatchObject({ ok: true, closed: { how: 'moot', reason: 'note e1 was removed' } })
  expect(s.view('tasks/tasks')!.tasks!.map((t) => t.id)).toEqual(['t1'])
  s.z.stop()
})

test('a malformed or over-cap question is dropped with a reason, and the reply\'s ops still apply', async () => {
  const write = (slug: string, id: string) => ({ op: 'write', slug, title: slug, sources: [id], body: id })
  const ask = (noteId: unknown, chosen: unknown, alternatives: unknown) => ({ kind: 'whichTopic', noteId, chosen, alternatives })
  const { backend } = scripted({
    ops: [write('a', 'n1'), write('b', 'n2'), write('c', 'n3')],
    questions: [ask('n1', 'a', ['b']), ask('n2', 'b', ['zzz']), ask('ghost', 'a', ['b']), 'oops', ask('n2', 'a', ['c']), ask('n2', 'b', 'c'), ask('n2', 'b', ['b']), { kind: 'isTask', noteId: 'n2' }, ask('n1', 'a', ['c']), ask('n2', 'B', ['c']), ask('n3', 'c', ['a'])],
  })
  const z = new Zephyr({ dataDir: await tempDir(), backend, kinds: { organizer: kinds.organizer! }, retryDelaysMs: [] })
  await z.start()
  await z.ingest(['n1', 'n2', 'n3'].map((id) => entry(id)))
  await z.idle()
  expect(z.listViews().map((v) => v.slug).sort()).toEqual(['a', 'b', 'c'])
  expect(z.listRuns().at(-1)).toMatchObject({
    status: 'done',
    dropped: [
      'question 1: no such topic: zzz',
      'question 2: note ghost is not a new entry of this run',
      'question 3: not an object',
      'question 4: note n2 is not on topic a',
      'question 5: alternatives is not an array',
      'question 6: no alternative besides chosen',
      'question 7: kind is not whichTopic',
      'question 8: note n1 was already asked about',
      'question 10: over the cap of 2 questions per run',
    ],
  })
  expect(z.listQuestions().map((q) => [q.note.id, q.answers])).toEqual([
    ['n1', ['keep', 'b']],
    ['n2', ['keep', 'c']],
  ])
  z.stop()
})

test('questions that are not an array are dropped as a whole with a reason; the run is done', async () => {
  const { backend } = scripted({ ops: [{ op: 'write', slug: 'a', title: 'A', sources: ['n1'], body: 'x' }], questions: 'which one?' })
  const z = new Zephyr({ dataDir: await tempDir(), backend, kinds: { organizer: kinds.organizer! }, retryDelaysMs: [] })
  await z.start()
  await z.ingest([entry('n1')])
  await z.idle()
  expect(z.listRuns().at(-1)).toMatchObject({ status: 'done', dropped: ['questions is not an array, so none were asked'] })
  expect(z.listQuestions()).toEqual([])
  z.stop()
})

test('open questions are in the digest, the review brief and list_questions, and answer_question closes one', async () => {
  const s = await asked()
  const server = serve(s.z, { port: 0, distDir: '/nonexistent' })
  const rpc = async (name: string, args: object = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    return (await res.json()).result
  }
  try {
    const open = s.z.listQuestions()
    const digest = await s.z.review()
    expect(digest.questions).toEqual(open)
    expect(reviewBrief(digest)).toContain('answer_question')
    expect(JSON.parse((await rpc('list_questions')).content[0].text)).toEqual(open)
    expect(await rpc('answer_question', { questionId: open[0]!.id, answer: 'nope' })).toEqual({ content: [{ type: 'text', text: 'answer must be one of: keep, garden' }], isError: true })
    expect(JSON.parse((await rpc('answer_question', { questionId: open[0]!.id, answer: 'garden' })).content[0].text)).toMatchObject({ ok: true, closed: { how: 'applied' } })
    expect(JSON.parse((await rpc('list_questions')).content[0].text)).toEqual([])
    expect((await s.z.review()).questions).toEqual([])
  } finally {
    server.stop(true)
    s.z.stop()
  }
})

test('after a restart, open questions are still open and answered ones stay closed', async () => {
  const s = await started()
  await s.note('garden: beans', 'balcony: pots', 'balcony: rail', 'balcony: tomatoes ask:garden', 'balcony: herbs ask:garden')
  const [first, second] = s.z.listQuestions()
  expect(await s.z.answerQuestion(first!.id, 'keep')).toMatchObject({ ok: true })
  s.z.stop()
  const restarted = await started({ dir: s.dir })
  expect(restarted.z.listQuestions().map((q) => q.id)).toEqual([second!.id])
  expect(await restarted.z.answerQuestion(first!.id, 'garden')).toEqual({ ok: false, error: `no open question ${first!.id}` })
  expect(await restarted.z.answerQuestion(second!.id, 'garden')).toMatchObject({ ok: true, closed: { how: 'applied' } })
  restarted.z.stop()
})
