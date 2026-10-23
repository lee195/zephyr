/** What the last `GET /status` said, or that it has not answered yet. */
export type Server =
  | { kind: 'unknown' }
  | { kind: 'down'; checkedAt: number }
  | { kind: 'up'; checkedAt: number; entries: number; runsInFlight: number; lastViewAt: number | null; lastNote: LastNote | null }

/** The newest note and the titles of the topics it is filed under so far. */
export type LastNote = { id: string; topics: readonly string[] }

/** Where the person asked the next note to go: a new topic of its own, or a new topic in a new space. */
export type Placement = 'topic' | 'space'

declare module 'claude-code' {
  interface PluginState {
    zephyr: {
      /** The session notes mode is on for; any other session, including after /clear, is off. */
      notesFor: string | null
      /** Where the next note of that session goes, asked for by `/zephyr new`; cleared once a note takes it. */
      placeNext: { sessionId: string; placement: Placement } | null
      server: Server
    }
  }
}
