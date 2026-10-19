import { NOTE_MARKER, type Entry, type TranscriptAdapter } from './domain'

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

const claudeCode: TranscriptAdapter = {
  harness: 'claude-code',
  parseLine(line) {
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      return null
    }
    if (!row || row.type !== 'user' || typeof row.uuid !== 'string') return null
    const text = firstText(row.message?.content)
    if (text === null || !text.startsWith(NOTE_MARKER)) return null
    const entry: Entry = {
      id: row.uuid,
      harness: 'claude-code',
      sessionId: String(row.sessionId ?? ''),
      at: typeof row.timestamp === 'string' ? row.timestamp : new Date().toISOString(),
      text: text.slice(NOTE_MARKER.length),
    }
    return entry
  },
}

export const adapters: Record<string, TranscriptAdapter> = {
  [claudeCode.harness]: claudeCode,
}
