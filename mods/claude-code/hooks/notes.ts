import type { PromptSubmitInput } from 'claude-code'

import type { Server } from '../types'

export const NOTE_PREFIX = '[zephyr] '

/** Origins where a person typed the text; everything else reaches the model untouched. */
const TYPED: ReadonlySet<PromptSubmitInput['origin']['kind']> = new Set(['composer', 'bridge'])

export type SubmitDecision = { kind: 'pass' } | { kind: 'note'; text: string } | { kind: 'refuse'; reason: string }

export function decide(
  e: Pick<PromptSubmitInput, 'text' | 'command' | 'isMeta' | 'origin' | 'attachments'>,
  isNotesOn: boolean,
): SubmitDecision {
  const text = e.text.trim()
  if (!isNotesOn || e.command || e.isMeta || !TYPED.has(e.origin.kind) || !text) return { kind: 'pass' }
  // The transcript row takes text blocks only, and passing through would send the note to the model.
  if (e.attachments?.length) return { kind: 'refuse', reason: 'not noted: attachments are not supported' }
  return { kind: 'note', text: `${NOTE_PREFIX}${text}` }
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
