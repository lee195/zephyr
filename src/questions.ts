import type { AdjustState } from './adjust'
import type { Adjustment, Closed, EntryId, Question, QuestionLine, TaskId } from './domain'
import { sanitizeSlug } from './kinds/common'
import { topicsIn } from './kinds/organizer'
import { currentTasks } from './kinds/tasks'

export const KEEP = 'keep'

export type Asked = Extract<QuestionLine, { type: 'asked' }>

/** Every answer a question takes. `keep` leaves the note as it was filed; each other answer is one adjustment. */
export const answersFor = (q: Question): string[] => (q.kind === 'whichTopic' ? [KEEP, ...q.alternatives] : [KEEP, 'deleteTask'])

const topic = (s: AdjustState, slug: string) => topicsIn(s.views).find((v) => v.slug === sanitizeSlug(slug))

/** Why the question no longer applies, such as its note moved or removed since; undefined while it does. */
export function mootReason(q: Question, s: AdjustState): string | undefined {
  if (!s.entries.some((e) => e.id === q.noteId)) return `note ${q.noteId} was removed`
  if (q.kind === 'isTask') return currentTasks(s.views).some((t) => t.id === q.taskId) ? undefined : `task ${q.taskId} was deleted`
  const chosen = topic(s, q.chosen)
  if (!chosen) return `topic ${q.chosen} no longer exists`
  if (!chosen.sources.includes(q.noteId)) return `note ${q.noteId} is no longer on ${q.chosen}`
}

export type Resolution = { close: Exclude<Closed, { how: 'applied' }> } | { adjustment: Adjustment } | { error: string }

/**
 * What an answer does, read against the state now. A note that leaves `chosen` moves to the answered topic; if that
 * topic already cites it, it is only detached; if it was the only note on `chosen`, the topic merges into the answer.
 */
export function resolveAnswer(q: Question, answer: string, s: AdjustState): Resolution {
  const answers = answersFor(q)
  if (!answers.includes(answer)) return { error: `answer must be one of: ${answers.join(', ')}` }
  const moot = mootReason(q, s)
  if (moot) return { close: { how: 'moot', reason: moot } }
  if (answer === KEEP) return { close: { how: 'kept' } }
  if (q.kind === 'isTask') return { adjustment: { op: 'deleteTask', taskId: q.taskId } }
  const to = topic(s, answer)
  if (!to) return { error: `topic ${answer} no longer exists; answer keep or another topic` }
  const from = topic(s, q.chosen)!
  if (to.sources.includes(q.noteId)) return { adjustment: { op: 'detachNote', noteId: q.noteId, from: from.slug, to: to.slug } }
  if (from.sources.length === 1) return { adjustment: { op: 'mergeTopics', from: from.slug, into: to.slug } }
  return { adjustment: { op: 'moveNote', noteId: q.noteId, from: from.slug, to: to.slug } }
}

type Ref = { slug: string; title?: string }

/** An open question as the person is asked it: the note's and topics' current text, read now, never stored. */
export type QuestionView = { id: string; askedAt: string; note: { id: EntryId; text?: string }; answers: string[]; moot?: string } & (
  | { kind: 'whichTopic'; chosen: Ref; alternatives: Ref[] }
  | { kind: 'isTask'; task: { id: TaskId; text?: string } }
)

export function questionView(a: Asked, s: AdjustState): QuestionView {
  const q = a.question
  const moot = mootReason(q, s)
  const base = { id: a.id, askedAt: a.at, note: { id: q.noteId, text: s.entries.find((e) => e.id === q.noteId)?.text }, answers: answersFor(q), ...(moot && { moot }) }
  const ref = (slug: string): Ref => ({ slug, title: topic(s, slug)?.title })
  if (q.kind === 'isTask') return { ...base, kind: 'isTask', task: { id: q.taskId, text: currentTasks(s.views).find((t) => t.id === q.taskId)?.text } }
  return { ...base, kind: 'whichTopic', chosen: ref(q.chosen), alternatives: q.alternatives.map(ref) }
}
