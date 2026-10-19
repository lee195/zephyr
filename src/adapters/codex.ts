import type { Row, TranscriptAdapter } from '../domain'
import { readComplete } from '../tailer'

/**
 * One line of a Codex rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`). A message is a
 * `response_item` whose payload is a user or assistant message with its own id. The rollout echoes each user message
 * once more as an `event_msg` with a different id; reading only response items keeps one row per message.
 */
export function parseCodex(line: string, sessionId: string): Row[] {
  let item: any
  try {
    item = JSON.parse(line)
  } catch {
    return []
  }
  const message = item?.type === 'response_item' ? item.payload : null
  if (message?.type !== 'message' || (message.role !== 'user' && message.role !== 'assistant') || typeof message.id !== 'string')
    return []
  const part = Array.isArray(message.content) ? message.content.find((c: any) => typeof c?.text === 'string') : null
  if (!part) return []
  return [
    {
      id: message.id,
      sessionId,
      at: typeof item.timestamp === 'string' ? item.timestamp : new Date().toISOString(),
      role: message.role,
      text: part.text,
    },
  ]
}

export const codex: TranscriptAdapter = {
  harness: 'codex',
  async read(transcriptPath, sessionId, offset) {
    const chunk = await readComplete(transcriptPath, offset)
    return { rows: chunk.lines.flatMap((line) => parseCodex(line, sessionId)), offset: chunk.offset }
  },
}
