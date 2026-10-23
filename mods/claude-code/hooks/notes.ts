import type { PromptSubmitInput } from 'claude-code'

import type { LastNote, Placement, Server } from '../types'

export const NOTE_PREFIX = '[zephyr] '

/** The server reads these as a note that asks for its placement. */
const PLACED_PREFIX: Record<Placement, string> = { topic: '[zephyr new topic] ', space: '[zephyr new space] ' }

/** Origins where a person typed the text; everything else reaches the model untouched. */
const TYPED: ReadonlySet<PromptSubmitInput['origin']['kind']> = new Set(['composer', 'bridge'])

export type SubmitDecision = { kind: 'pass' } | { kind: 'note'; text: string; echo: string } | { kind: 'refuse'; reason: string }

export function decide(
  e: Pick<PromptSubmitInput, 'text' | 'command' | 'isMeta' | 'origin' | 'attachments'>,
  isNotesOn: boolean,
  placement: Placement | null = null,
): SubmitDecision {
  const text = e.text.trim()
  if (!isNotesOn || e.command || e.isMeta || !TYPED.has(e.origin.kind) || !text) return { kind: 'pass' }
  // The transcript row takes text blocks only, and passing through would send the note to the model.
  if (e.attachments?.length) return { kind: 'refuse', reason: 'not noted: attachments are not supported' }
  if (placement) return { kind: 'note', text: `${PLACED_PREFIX[placement]}${text}`, echo: `✎ new ${placement} · ${text}` }
  return { kind: 'note', text: `${NOTE_PREFIX}${text}`, echo: `✎ ${text}` }
}

/** Claude Code's name for a project folder under ~/.claude/projects. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^A-Za-z0-9-]/g, '-')
}

export function transcriptPathFor(home: string, root: string, sessionId: string): string {
  return `${home}/.claude/projects/${encodeProjectDir(root)}/${sessionId}.jsonl`
}

/** The body of `GET /status`; anything unreadable counts as the server being down. */
export function parseStatus(text: string, checkedAt: number): Server {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'down', checkedAt }
  }
  if (typeof raw !== 'object' || raw === null || (raw as { up?: unknown }).up !== true) return { kind: 'down', checkedAt }
  const r = raw as { entries?: unknown; runsInFlight?: unknown; lastViewAt?: unknown; lastNote?: unknown }
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const at =
    typeof r.lastViewAt === 'number' ? r.lastViewAt : typeof r.lastViewAt === 'string' ? Date.parse(r.lastViewAt) : NaN
  return {
    kind: 'up',
    checkedAt,
    entries: count(r.entries),
    runsInFlight: count(r.runsInFlight),
    lastViewAt: Number.isFinite(at) ? at : null,
    lastNote: parseLastNote(r.lastNote),
  }
}

function parseLastNote(raw: unknown): LastNote | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as { id?: unknown; topics?: unknown }
  return typeof r.id === 'string' ? { id: r.id, topics: topicTitles(r.topics) } : null
}

/** The readable titles of a `topics` list from the server; anything else counts as no topics. */
function topicTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(t => {
    const title = typeof t === 'object' && t !== null ? oneLine((t as { title?: unknown }).title) : ''
    return title ? [title] : []
  })
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

export function isBandShown(isNotesOn: boolean, server: Server): boolean {
  return isNotesOn || (server.kind === 'up' && server.runsInFlight > 0)
}

/** The band's one line, or null while it stays hidden. */
export function bandLine(isNotesOn: boolean, server: Server, now: number, placement: Placement | null = null): string | null {
  if (!isBandShown(isNotesOn, server)) return null
  const parts = ['zephyr', isNotesOn ? 'notes on' : 'notes off']
  if (isNotesOn && placement) parts.push(`next note → new ${placement}`)
  if (server.kind === 'unknown') parts.push('server …')
  else if (server.kind === 'down') parts.push('server down')
  else {
    parts.push('server up')
    if (server.runsInFlight > 0) parts.push(`${server.runsInFlight} ${server.runsInFlight === 1 ? 'run' : 'runs'}`)
    if (server.lastViewAt !== null) parts.push(`last view ${ago(now - server.lastViewAt)} ago`)
  }
  return parts.join(' · ')
}

/**
 * Where the newest note went, for the band while notes mode is on: its topics once filed, "filing…" while runs are
 * in flight, otherwise nothing.
 */
export function filedLine(server: Server): string | null {
  if (server.kind !== 'up' || !server.lastNote) return null
  if (server.lastNote.topics.length > 0) return `✎ last note → ${server.lastNote.topics.join(', ')}`
  return server.runsInFlight > 0 ? '✎ last note → filing…' : null
}

/** `notes.count` from the body of `GET /api/review`; null when unreadable. */
export function parseReviewCount(text: string): number | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const notes = typeof raw === 'object' && raw !== null ? (raw as { notes?: unknown }).notes : undefined
  const count = typeof notes === 'object' && notes !== null ? (notes as { count?: unknown }).count : undefined
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null
}

/** What ending notes mode says about the notes waiting for review; null when there are none. */
export function reviewNotice(count: number): string | null {
  return count > 0 ? `${count} ${count === 1 ? 'note' : 'notes'} since last review · /zephyr review` : null
}

/** The review acts only through the zephyr MCP server's tools; this one stands for all of them. */
export const REVIEW_TOOL = 'mcp__zephyr__finish_review'

/** What `/zephyr review` says when the session has no zephyr MCP tools, so no review turn could act. */
export function mcpMissing(base: string): string {
  return [
    'The zephyr MCP server is not connected in this session, so a review could not change anything.',
    `Set it up once with: claude mcp add --transport http --scope user zephyr ${base}/mcp`,
    'then start a new session, or reconnect it with /mcp if it is set up.',
  ].join('\n')
}

/** One hint as the band shows it: the titles of the matching note's topics, and its text and time. */
export type Hint = { topics: readonly string[]; text: string; at: string }

export const HINT_LIMIT = 3

const NO_HINTS: readonly Hint[] = []

/**
 * The hints for the draft in the box. `waiting` is a draft settling or its request out: only the reply tagged
 * `seq` lands, and the hints of the draft before stay up meanwhile.
 */
export type Hints =
  | { kind: 'idle' }
  | { kind: 'waiting'; seq: number; draft: string; hints: readonly Hint[] }
  | { kind: 'shown'; draft: string; hints: readonly Hint[] }

export const NO_DRAFT: Hints = { kind: 'idle' }

export function shownHints(hints: Hints): readonly Hint[] {
  return hints.kind === 'idle' ? NO_HINTS : hints.hints
}

/** A draft under two words asks for nothing and clears what was shown; the same draft (a cursor move) changes nothing. */
export function draftChanged(hints: Hints, draft: string, seq: number): Hints {
  const text = draft.trim()
  if (text.split(/\s+/).length < 2) return NO_DRAFT
  if (hints.kind !== 'idle' && hints.draft === text) return hints
  return { kind: 'waiting', seq, draft: text, hints: shownHints(hints) }
}

export function hintsArrived(hints: Hints, seq: number, arrived: readonly Hint[]): Hints {
  return hints.kind === 'waiting' && hints.seq === seq ? { kind: 'shown', draft: hints.draft, hints: arrived } : hints
}

const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** The body of `GET /hints`, up to `limit` hints; anything unreadable counts as no hints. */
export function parseHints(text: string, limit = HINT_LIMIT): readonly Hint[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return NO_HINTS
  }
  const list = typeof raw === 'object' && raw !== null ? (raw as { hints?: unknown }).hints : undefined
  if (!Array.isArray(list)) return NO_HINTS
  return list
    .flatMap((h: unknown): Hint[] => {
      if (typeof h !== 'object' || h === null) return []
      const r = h as { text?: unknown; topics?: unknown; at?: unknown }
      const text = oneLine(r.text)
      return text ? [{ topics: topicTitles(r.topics), text, at: typeof r.at === 'string' ? r.at : '' }] : []
    })
    .slice(0, limit)
}

const where = (hint: Hint) => (hint.topics.length > 0 ? hint.topics.join(', ') : 'no topic yet')

export function hintLine(hint: Hint): string {
  return `↳ ${hint.topics.length > 0 ? hint.topics.join(', ') : 'note'} · ${hint.text}`
}

/** The most notes `/zephyr where` lists; the server's own cap. */
export const WHERE_LIMIT = 10

/** What `/zephyr where` says: each matching note's date, its topics and its text, best match first. */
export function whereReply(query: string, hints: readonly Hint[]): string {
  if (hints.length === 0) return `No notes match "${query}".`
  return [`Notes matching "${query}", best first:`, ...hints.map(h => `${h.at.slice(0, 10) || '?'} · ${where(h)} · ${h.text}`)].join('\n')
}
