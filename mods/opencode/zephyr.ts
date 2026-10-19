import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui'
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
  return `${count} ${count === 1 ? 'note' : 'notes'} since last review`
}

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

  async function keep(sessionID: string, value: string) {
    const text = value.trim()
    if (!text) return endNotes()
    const res = await api.client.session.prompt({ sessionID, noReply: true, parts: [{ type: 'text', text: NOTE_PREFIX + text }] })
    if (res.error) {
      api.ui.toast({ variant: 'error', message: 'not noted' })
      return api.ui.dialog.clear()
    }
    api.ui.toast({ variant: 'success', message: 'noted' })
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

  // From the home screen there is no session yet; a new one starts with the first note instead of a model turn.
  async function notes(api: TuiPluginApi) {
    const route = api.route.current
    if (route.name === 'session' && typeof route.params?.sessionID === 'string') return ask(route.params.sessionID)
    const created = await api.client.session.create({})
    if (!created.data) return api.ui.toast({ variant: 'error', message: 'could not start a session for notes' })
    api.route.navigate('session', { sessionID: created.data.id })
    ask(created.data.id)
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
        run: () => void notes(api),
      },
    ],
    bindings: [],
  })
  api.lifecycle.onDispose(dispose)
}

export default { id: 'zephyr', tui }
