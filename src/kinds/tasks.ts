import type { AgentKind, ChatMessage, Entry, EntryId, Run, Task, TaskId, View, ViewWrite, World } from '../domain'
import { rankAll, type RelevanceDoc } from '../relevance'
import { inEntryOrder, jsonPrompt, knownSources, promptEntry } from './common'

/** Open tasks the model sees per run, the ones most relevant to the run's entries; done tasks are never shown. */
const OPEN_SHOWN = 30
export const MAX_DUE_LENGTH = 60

export type TaskOp =
  | { op: 'add'; text: string; due?: string; sources: EntryId[] }
  | { op: 'complete'; taskId: TaskId; sources: EntryId[] }
  | { op: 'update'; taskId: TaskId; text?: string; due?: string; sources: EntryId[] }

export type TaskValidation = { ok: true; ops: TaskOp[]; dropped: string[] } | { ok: false; error: string }

export interface TaskReplyContext {
  /** The run's new entries: the only notes an op may cite. */
  entryIds: ReadonlySet<EntryId>
  /** The open tasks the prompt showed: the only tasks an op may change. */
  openIds: ReadonlySet<TaskId>
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const due = (v: unknown) => {
  const d = text(v)
  return d && d.length <= MAX_DUE_LENGTH ? d : undefined
}

/**
 * Parses `{ ops: [...] }`. A malformed reply fails as a whole. A well-formed op the rules refuse is
 * dropped with a reason: an op with no known sources, an add with no text, a change to a task the
 * prompt did not show as open, or an update that changes nothing.
 */
export function validateTaskOps(json: unknown, ctx: TaskReplyContext): TaskValidation {
  const ops = (json as any)?.ops
  if (!Array.isArray(ops)) return { ok: false, error: 'reply has no ops array' }
  const out: TaskOp[] = []
  const dropped: string[] = []
  for (const [i, o] of ops.entries()) {
    if (!o || typeof o !== 'object') return { ok: false, error: `op ${i} is not an object` }
    if (o.op !== 'add' && o.op !== 'complete' && o.op !== 'update') return { ok: false, error: `op ${i} is not add, complete or update` }
    if (!Array.isArray(o.sources)) return { ok: false, error: `op ${i} sources is not an array` }
    const label = o.op === 'add' ? 'add' : `${o.op} ${String(o.taskId)}`
    const sources = knownSources(o.sources, ctx.entryIds)
    if (sources.length === 0) {
      dropped.push(`${label}: no known sources`)
      continue
    }
    if (o.op === 'add') {
      const t = text(o.text)
      if (!t) dropped.push('add: empty text')
      else out.push({ op: 'add', text: t, ...(due(o.due) && { due: due(o.due) }), sources })
      continue
    }
    if (typeof o.taskId !== 'string' || !ctx.openIds.has(o.taskId)) {
      dropped.push(`${label}: no such open task`)
      continue
    }
    if (o.op === 'complete') {
      out.push({ op: 'complete', taskId: o.taskId, sources })
      continue
    }
    const change = { ...(text(o.text) && { text: text(o.text) }), ...(due(o.due) && { due: due(o.due) }) }
    if (Object.keys(change).length === 0) dropped.push(`${label}: nothing to change`)
    else out.push({ op: 'update', taskId: o.taskId, ...change, sources })
  }
  return { ok: true, ops: out, dropped }
}

const TASKS_SYSTEM = `You keep a person's task list from their notes.
Reply with JSON only: {"ops":[op, ...]} where op is one of
  {"op":"add","text":string,"due":string,"sources":string[]}
  {"op":"complete","taskId":string,"sources":string[]}
  {"op":"update","taskId":string,"text":string,"due":string,"sources":string[]}
The input has openTasks (id, text, due) and newEntries (id, at, text).
- Most notes contain no task. Then reply {"ops":[]}.
- add a task only for something the person still has to do (a TODO, a reminder, "need to"). text is a short imperative in the note's words.
- complete an open task when a new entry says it is done, by its id.
- update an open task when a new entry changes it, such as a new date. Never add a task that duplicates an open one.
- due: when the note names a time, resolve it to an ISO date (YYYY-MM-DD) taking the entry's at as today. If you cannot resolve it, copy the note's words. Leave due out when the note names no time; in update, leave out text or due you do not change.
- sources lists the ids of the new entries the op comes from.`

export function tasksMessages(openTasks: Task[], newEntries: Entry[]): ChatMessage[] {
  return jsonPrompt(TASKS_SYSTEM, {
    openTasks: openTasks.map((t) => ({ id: t.id, text: t.text, ...(t.due && { due: t.due }) })),
    newEntries: newEntries.map(promptEntry),
  })
}

export const currentTasks = (views: readonly View[]): Task[] =>
  views.find((v): v is View & { tasks: Task[] } => v.kind === 'tasks' && v.slug === 'tasks' && !!v.tasks)?.tasks ?? []

const openTasks = (tasks: Task[]) => tasks.filter((t) => !t.done)

/** The open tasks a run ranks: none while they all fit in the prompt. */
const docsToRank = (open: Task[]): RelevanceDoc[] => (open.length > OPEN_SHOWN ? open.map((t) => ({ id: t.id, text: t.text })) : [])

async function shownOpenTasks(world: World, tasks: Task[], newEntries: Entry[]): Promise<Task[]> {
  const open = openTasks(tasks)
  const docs = docsToRank(open)
  if (docs.length === 0) return open
  const { scored } = await rankAll(world.relevance, newEntries.map((e) => e.text).join('\n'), docs)
  const shown = new Set(scored.slice(0, OPEN_SHOWN).map((r) => r.id))
  return open.filter((t) => shown.has(t.id))
}

const idNumber = (id: TaskId) => Number(/^t(\d+)$/.exec(id)?.[1] ?? 0)

export function applyTaskOps(tasks: Task[], ops: TaskOp[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]))
  let next = Math.max(0, ...tasks.map((t) => idNumber(t.id))) + 1
  for (const op of ops) {
    if (op.op === 'add') {
      const id = `t${next++}`
      byId.set(id, { id, text: op.text, ...(op.due && { due: op.due }), done: false, sources: op.sources })
      continue
    }
    const task = byId.get(op.taskId)!
    task.sources = [...new Set([...task.sources, ...op.sources])]
    if (op.op === 'complete') task.done = true
    else Object.assign(task, op.text && { text: op.text }, op.due && { due: op.due })
  }
  return [...byId.values()]
}

export function renderTasks(tasks: Task[]): string {
  const line = (t: Task) => `- [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ` (due ${t.due})` : ''}`
  return [...openTasks(tasks), ...tasks.filter((t) => t.done)].map(line).join('\n')
}

/** The tasks view holding this list: the rendered body, the tasks as data, and every note a task cites. */
export function tasksWrite(list: Task[], entries: readonly Entry[]): ViewWrite {
  const cited = new Set(list.flatMap((t) => t.sources))
  return { slug: 'tasks', title: 'Tasks', format: 'md', body: renderTasks(list), tasks: list, sources: inEntryOrder(entries, cited) }
}

export const tasks: AgentKind = {
  kind: 'tasks',
  trigger: { on: 'entry' },
  relevanceDocs: (views) => docsToRank(openTasks(currentTasks(views))),
  async plan(run: Run, world: World) {
    const runIds = new Set(run.entryIds)
    const newEntries = world.entries.filter((e) => runIds.has(e.id))
    const current = currentTasks(world.views)
    const shown = await shownOpenTasks(world, current, newEntries)
    const ctx: TaskReplyContext = { entryIds: runIds, openIds: new Set(shown.map((t) => t.id)) }
    return {
      messages: tasksMessages(shown, newEntries),
      settle(json) {
        const result = validateTaskOps(json, ctx)
        if (!result.ok) return result
        // Most notes hold no task, so a valid reply covers every entry of the run, even with no ops.
        const covered = run.entryIds
        if (result.ops.length === 0) return { ok: true, writes: [], dropped: result.dropped, covered }
        return { ok: true, writes: [tasksWrite(applyTaskOps(current, result.ops), world.entries)], dropped: result.dropped, covered }
      },
    }
  },
}
