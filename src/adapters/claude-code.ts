import type { Row, TranscriptAdapter } from '../domain'
import { readComplete } from '../tailer'

function firstText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (typeof block === 'string') return block
    if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string')
      return (block as any).text
  }
  return null
}

/** One line of a Claude Code session .jsonl. Tool results, summaries and torn lines carry no row. */
export function parseClaudeCode(line: string): Row[] {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return []
  }
  if (!row || (row.type !== 'user' && row.type !== 'assistant') || typeof row.uuid !== 'string') return []
  const text = firstText(row.message?.content)
  if (text === null) return []
  return [
    {
      id: row.uuid,
      sessionId: String(row.sessionId ?? ''),
      at: typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString(),
      role: row.type,
      text,
    },
  ]
}

export const claudeCode: TranscriptAdapter = {
  harness: 'claude-code',
  async read(transcriptPath, _sessionId, offset) {
    const chunk = await readComplete(transcriptPath, offset)
    return { rows: chunk.lines.flatMap(parseClaudeCode), offset: chunk.offset }
  },
}
