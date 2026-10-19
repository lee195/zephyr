import { Database } from 'bun:sqlite'
import type { Row, TranscriptAdapter } from '../domain'

/** One text part of a user message, as opencode stores it: message and part are separate rows, each with a JSON `data` column. */
export interface OpencodeRecord {
  id: string
  sessionId: string
  at: number
  message: string
  part: string
}

// Only user text parts: assistant parts are most of the database, and no note is ever among them.
const USER_TEXT = `
  SELECT m.id AS id, m.session_id AS sessionId, m.time_created AS at, m.data AS message, p.data AS part
  FROM message m JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ?1 AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'
  ORDER BY m.time_created, m.id, p.id`

export function parseOpencode(record: OpencodeRecord): Row[] {
  const role = JSON.parse(record.message).role
  const part = JSON.parse(record.part)
  if ((role !== 'user' && role !== 'assistant') || part.type !== 'text' || typeof part.text !== 'string') return []
  return [{ id: record.id, sessionId: record.sessionId, at: new Date(record.at).toISOString(), role, text: part.text }]
}

/**
 * The transcript is opencode's SQLite database; transcriptPath is its file (`opencode db path`). A message's parts are
 * inserted after the message, and a revert deletes rows, so no stored position is safe to resume from: every read
 * returns the session's user text again and entry-id dedupe absorbs the repeats. The offset stays 0.
 */
export const opencode: TranscriptAdapter = {
  harness: 'opencode',
  async read(transcriptPath, sessionId, offset) {
    let db: Database
    try {
      db = new Database(transcriptPath, { readonly: true })
    } catch {
      return { rows: [], offset }
    }
    try {
      return { rows: db.query<OpencodeRecord, [string]>(USER_TEXT).all(sessionId).flatMap(parseOpencode), offset }
    } finally {
      db.close()
    }
  },
  locate: (transcriptPath, sessionId, rowId) => `the opencode database ${transcriptPath}, message ${rowId} of session ${sessionId} and its parts`,
}
