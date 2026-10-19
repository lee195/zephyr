#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'

const MARKER = '[zephyr] '

/** What Codex's `notify` passes as its last argument after each turn. */
interface TurnComplete {
  type: string
  'thread-id'?: string
  'input-messages'?: string[]
}

/** The thread to register, or null when the turn held no note. */
export function noteThread(payload: TurnComplete): string | null {
  if (payload.type !== 'agent-turn-complete' || !payload['thread-id']) return null
  return (payload['input-messages'] ?? []).some((m) => m.startsWith(MARKER)) ? payload['thread-id'] : null
}

/** A rollout is named after its thread and filed under the day it started, which may not be today. */
export async function findRollout(codexHome: string, threadId: string): Promise<string | null> {
  const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl`)
  for await (const path of glob.scan({ cwd: join(codexHome, 'sessions'), absolute: true, onlyFiles: true })) return path
  return null
}

async function main(argv: string[]) {
  const portAt = argv.indexOf('--port')
  const port = portAt === -1 ? 7317 : Number(argv[portAt + 1])
  const payload: TurnComplete = JSON.parse(argv.at(-1) ?? '{}')
  const threadId = noteThread(payload)
  if (!threadId) return
  const transcriptPath = await findRollout(process.env.CODEX_HOME || join(homedir(), '.codex'), threadId)
  if (!transcriptPath) return
  await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness: 'codex', sessionId: threadId, transcriptPath }),
    signal: AbortSignal.timeout(2000),
  })
}

// A server that is down loses nothing: the note stays in the rollout and the next note's turn registers again.
if (import.meta.main) await main(process.argv.slice(2)).catch(() => {})
