import type { TuiPlugin } from '@opencode-ai/plugin/tui'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const NOTE_PREFIX = '[zephyr] '

/** The database `opencode db path` prints on the release channel; it is the transcript Zephyr reads. */
function dbPath(env = process.env) {
  const data = join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')
  const db = env.OPENCODE_DB
  if (db) return isAbsolute(db) ? db : join(data, db)
  return join(data, 'opencode.db')
}

/** What closing the note box says about the notes waiting for review; null when there are none or the reply is unreadable. */
function reviewToast(body: unknown): string | null {
  const count = (body as { notes?: { count?: unknown } } | null)?.notes?.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null
  return `${count} ${count === 1 ? 'note' : 'notes'} since last review · /zephyr-review`
}

/** The topic titles of the newest note in a `GET /status` body, when it was written at or after `since` and is filed. */
function filedTopics(body: unknown, since: number): string[] | null {
  const note = (body as { lastNote?: { at?: unknown; topics?: unknown } } | null)?.lastNote
  if (typeof note?.at !== 'string' || !(Date.parse(note.at) >= since) || !Array.isArray(note.topics)) return null
  const titles = note.topics.flatMap((t: { title?: unknown } | null) => (typeof t?.title === 'string' && t.title ? [t.title] : []))
  return titles.length > 0 ? titles : null
}

const FILED_POLL_MS = 2000
const FILED_WAIT_MS = 60_000

const tui: TuiPlugin = async (api, options) => {
  const port = typeof options?.port === 'number' ? options.port : 7317
  const base = `http://127.0.0.1:${port}`
  const registered = new Set<string>()

  // A note is in the transcript before the server hears of it, so a server that is down loses nothing.
  function register(sessionId: string) {
    if (registered.has(sessionId)) return
    const body = JSON.stringify({ harness: 'opencode', sessionId, transcriptPath: dbPath() })
    fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(
      (res) => res.ok && registered.add(sessionId),
      () => api.ui.toast({ variant: 'warning', message: `noted; Zephyr is not reachable on ${base}` }),
    )
  }

  // Counts note boxes opened; a box's close ends notes only while it is the latest one.
  let boxes = 0

  // Silent when the server is down or slow: the first note's registration already warned.
  function endNotes() {
    boxes++
    api.ui.dialog.clear()
    fetch(`${base}/api/review`, { signal: AbortSignal.timeout(1500) })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const message = reviewToast(body)
        if (message) api.ui.toast({ variant: 'info', message })
      })
      .catch(() => undefined)
  }

  // Only the newest note is watched; each note restarts the watch.
  let watch = 0

  // Says where the note went once the organizer files it; gives up quietly after a minute or when the server is down.
  async function toastWhenFiled(since: number) {
    const mine = ++watch
    for (let waited = 0; waited < FILED_WAIT_MS && mine === watch; waited += FILED_POLL_MS) {
      await new Promise((r) => setTimeout(r, FILED_POLL_MS))
      const body = await fetch(`${base}/status`, { signal: AbortSignal.timeout(1500) })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
      const topics = mine === watch ? filedTopics(body, since) : null
      if (topics) return api.ui.toast({ variant: 'info', message: `✎ → ${topics.join(', ')}` })
    }
  }

  async function keep(sessionID: string, value: string) {
    const text = value.trim()
    if (!text) return endNotes()
    // A second of slack: opencode stamps the message after this, on the same clock.
    const since = Date.now() - 1000
    const res = await api.client.session.prompt({ sessionID, noReply: true, parts: [{ type: 'text', text: NOTE_PREFIX + text }] })
    if (res.error) {
      api.ui.toast({ variant: 'error', message: 'not noted' })
      return api.ui.dialog.clear()
    }
    api.ui.toast({ variant: 'success', message: 'noted' })
    void toastWhenFiled(since)
    register(sessionID)
    ask(sessionID)
  }

  // Esc closes the box through the dialog stack's onClose, which replacing the box after a note also calls.
  function ask(sessionID: string) {
    const box = ++boxes
    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title: 'Zephyr note',
          placeholder: 'Enter keeps it, with no model reply. Esc ends notes.',
          onConfirm: (value) => void keep(sessionID, value),
          onCancel: endNotes,
        }),
      () => box === boxes && endNotes(),
    )
  }

  // From the home screen there is no session yet, so one is started.
  async function currentSession(what: string) {
    const route = api.route.current
    if (route.name === 'session' && typeof route.params?.sessionID === 'string') return route.params.sessionID
    const created = await api.client.session.create({})
    if (!created.data) {
      api.ui.toast({ variant: 'error', message: `could not start a session for ${what}` })
      return null
    }
    api.route.navigate('session', { sessionID: created.data.id })
    return created.data.id
  }

  async function notes() {
    const sessionID = await currentSession('notes')
    if (sessionID) ask(sessionID)
  }

  // The brief is the server's: the digest and the rules of the review, naming the server's tools. It is sent as a
  // prompt, so the model's first turn reads it and the person directs the turns after it.
  async function review() {
    const brief = await fetch(`${base}/api/review/brief`, { signal: AbortSignal.timeout(1500) })
      .then((res) => (res.ok ? res.text() : null))
      .catch(() => null)
    if (brief === null) return api.ui.toast({ variant: 'error', message: `Zephyr is not reachable on ${base}` })
    if (!api.state.mcp().some((m) => m.name === 'zephyr' && m.status === 'connected'))
      return api.ui.toast({ variant: 'error', message: `The zephyr MCP server is not connected, so a review could not change anything. Add "mcp": { "zephyr": { "type": "remote", "url": "${base}/mcp" } } to opencode.json and restart opencode.`, duration: 15_000 })
    const sessionID = await currentSession('the review')
    if (!sessionID) return
    const sent = await api.client.session.promptAsync({ sessionID, parts: [{ type: 'text', text: brief }] })
    if (sent.error) api.ui.toast({ variant: 'error', message: 'the review did not start' })
  }

  const dispose = api.keymap.registerLayer({
    commands: [
      {
        namespace: 'palette',
        name: 'zephyr.note',
        title: 'Zephyr: take notes',
        desc: 'Keep what you type as notes, with no model reply',
        category: 'Zephyr',
        slashName: 'note',
        run: () => void notes(),
      },
      {
        namespace: 'palette',
        name: 'zephyr.review',
        title: 'Zephyr: review notes',
        desc: 'Start a review of the notes since the last review, with the zephyr MCP tools',
        category: 'Zephyr',
        slashName: 'zephyr-review',
        run: () => void review(),
      },
    ],
    bindings: [],
  })
  api.lifecycle.onDispose(dispose)
}

export default { id: 'zephyr', tui }
