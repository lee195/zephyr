/** What the last `GET /status` said, or that it has not answered yet. */
export type Server =
  | { kind: 'unknown' }
  | { kind: 'down'; checkedAt: number }
  | { kind: 'up'; checkedAt: number; entries: number; runsInFlight: number; lastViewAt: number | null; lastNote: LastNote | null }

/** The newest note and the titles of the topics it is filed under so far. */
export type LastNote = { id: string; topics: readonly string[] }

declare module 'claude-code' {
  interface PluginState {
    zephyr: {
      /** The session notes mode is on for; any other session, including after /clear, is off. */
      notesFor: string | null
      server: Server
    }
  }
}
