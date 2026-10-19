import type { PromptSubmitInput } from 'claude-code'

import type { Server } from '../types'

export const NOTE_PREFIX = '[zephyr] '

/** Origins where a person typed the text; everything else reaches the model untouched. */
const TYPED: ReadonlySet<PromptSubmitInput['origin']['kind']> = new Set(['composer', 'bridge'])

export type SubmitDecision = { kind: 'pass' } | { kind: 'note'; text: string; echo: string } | { kind: 'refuse'; reason: string }

export function decide(
  e: Pick<PromptSubmitInput, 'text' | 'command' | 'isMeta' | 'origin' | 'attachments'>,
  isNotesOn: boolean,
): SubmitDecision {
  const text = e.text.trim()
  if (!isNotesOn || e.command || e.isMeta || !TYPED.has(e.origin.kind) || !text) return { kind: 'pass' }
  // The transcript row takes text blocks only, and passing through would send the note to the model.
  if (e.attachments?.length) return { kind: 'refuse', reason: 'not noted: attachments are not supported' }
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
  const r = raw as { entries?: unknown; runsInFlight?: unknown; lastViewAt?: unknown }
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const at =
    typeof r.lastViewAt === 'number' ? r.lastViewAt : typeof r.lastViewAt === 'string' ? Date.parse(r.lastViewAt) : NaN
  return {
    kind: 'up',
    checkedAt,
    entries: count(r.entries),
    runsInFlight: count(r.runsInFlight),
    lastViewAt: Number.isFinite(at) ? at : null,
  }
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
export function bandLine(isNotesOn: boolean, server: Server, now: number): string | null {
  if (!isBandShown(isNotesOn, server)) return null
  const parts = ['zephyr', isNotesOn ? 'notes on' : 'notes off']
  if (server.kind === 'unknown') parts.push('server …')
  else if (server.kind === 'down') parts.push('server down')
  else {
    parts.push('server up')
    if (server.runsInFlight > 0) parts.push(`${server.runsInFlight} ${server.runsInFlight === 1 ? 'run' : 'runs'}`)
    if (server.lastViewAt !== null) parts.push(`last view ${ago(now - server.lastViewAt)} ago`)
  }
  return parts.join(' · ')
}

/** One hint as the band shows it: the matching note's topic title, when it has one, and its text. */
export type Hint = { topic: string | null; text: string }

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

/** The body of `GET /hints`; anything unreadable counts as no hints. */
export function parseHints(text: string): readonly Hint[] {
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
      const r = h as { text?: unknown; topic?: unknown }
      const text = oneLine(r.text)
      const topic = typeof r.topic === 'object' && r.topic !== null ? oneLine((r.topic as { title?: unknown }).title) : ''
      return text ? [{ topic: topic || null, text }] : []
    })
    .slice(0, HINT_LIMIT)
}

export function hintLine(hint: Hint): string {
  return `↳ ${hint.topic ?? 'note'} · ${hint.text}`
}
