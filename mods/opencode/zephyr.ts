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

  async function keep(sessionID: string, value: string) {
    const text = value.trim()
    if (!text) return api.ui.dialog.clear()
    const res = await api.client.session.prompt({ sessionID, noReply: true, parts: [{ type: 'text', text: NOTE_PREFIX + text }] })
    if (res.error) {
      api.ui.toast({ variant: 'error', message: 'not noted' })
      return api.ui.dialog.clear()
    }
    api.ui.toast({ variant: 'success', message: 'noted' })
    register(sessionID)
    ask(sessionID)
  }

  function ask(sessionID: string) {
    api.ui.dialog.replace(() =>
      api.ui.DialogPrompt({
        title: 'Zephyr note',
        placeholder: 'Enter keeps it, with no model reply. Esc ends notes.',
        onConfirm: (value) => void keep(sessionID, value),
        onCancel: () => api.ui.dialog.clear(),
      }),
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
