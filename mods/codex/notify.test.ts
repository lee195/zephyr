import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'

const THREAD = '01a15448-ee4b-7600-8f8b-407720467e1d'
const script = new URL('./notify.ts', import.meta.url).pathname

const posts: unknown[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    posts.push(await req.json())
    return Response.json({ ok: true })
  },
})
afterEach(() => void posts.splice(0))

async function codexHome() {
  const home = await mkdtemp(join(tmpdir(), 'zephyr-codex-'))
  const day = join(home, 'sessions', '2026', '10', '17')
  await mkdir(day, { recursive: true })
  const rollout = join(day, `rollout-2026-10-17T09-00-00-${THREAD}.jsonl`)
  await writeFile(rollout, '{}\n')
  await writeFile(join(day, 'rollout-2026-10-17T09-00-00-01a15448-0000-7000-8000-000000000000.jsonl'), '{}\n')
  return { home, rollout }
}

async function notify(home: string, inputMessages: string[]) {
  const payload = { type: 'agent-turn-complete', 'thread-id': THREAD, 'turn-id': 't', cwd: '/work', client: 'codex-tui', 'input-messages': inputMessages, 'last-assistant-message': '.' }
  const proc = Bun.spawn(['bun', script, '--port', String(server.port), JSON.stringify(payload)], { env: { ...process.env, CODEX_HOME: home } })
  expect(await proc.exited).toBe(0)
}

test("a turn that held a note registers the thread's rollout, found under the day the thread started", async () => {
  const { home, rollout } = await codexHome()
  await notify(home, ['[zephyr] buy oat milk'])
  expect(posts).toEqual([{ harness: 'codex', sessionId: THREAD, transcriptPath: rollout }])
})

test('a turn without a note registers nothing', async () => {
  const { home } = await codexHome()
  await notify(home, ['what is in this repo?'])
  expect(posts).toEqual([])
})

test('a server that is down does not fail the notify command', async () => {
  const { home } = await codexHome()
  const payload = { type: 'agent-turn-complete', 'thread-id': THREAD, 'input-messages': ['[zephyr] x'] }
  const proc = Bun.spawn(['bun', script, '--port', '1', JSON.stringify(payload)], { env: { ...process.env, CODEX_HOME: home }, stderr: 'pipe' })
  expect(await proc.exited).toBe(0)
})
