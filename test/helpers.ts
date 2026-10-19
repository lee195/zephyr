import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, Entry, ModelBackend, View } from '../src/domain'

export const entry = (id: string, text = id, at = '2026-10-19T09:00:00Z'): Entry => ({ id, harness: 'claude-code', sessionId: 's', at, text })

export const tempDir = () => mkdtemp(join(tmpdir(), 'zephyr-test-'))

export async function eventually(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error('condition not met in time')
}

/** A data dir holding these entries, these finished runs, and these views on disk. */
export async function seedDataDir(opts: { entries: Entry[]; runs?: object[]; views?: Omit<View, 'id'>[] }) {
  const dir = await tempDir()
  await writeFile(join(dir, 'entries.jsonl'), opts.entries.map((e) => JSON.stringify(e) + '\n').join(''))
  await writeFile(join(dir, 'runs.jsonl'), (opts.runs ?? []).map((r) => JSON.stringify(r) + '\n').join(''))
  for (const v of opts.views ?? []) {
    const ext = { md: 'md', svg: 'svg', ascii: 'txt' }[v.format]
    await mkdir(join(dir, 'views', v.kind), { recursive: true })
    const { body, ...meta } = v
    await writeFile(join(dir, 'views', v.kind, `${v.slug}.${ext}`), body)
    await writeFile(join(dir, 'views', v.kind, `${v.slug}.json`), JSON.stringify({ id: `${v.kind}/${v.slug}`, ...meta }))
  }
  return dir
}

export const filesUnder = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()

/** The user message's JSON payload, which every kind sends as its last message. */
export const payloadOf = (messages: ChatMessage[]) => JSON.parse(messages.at(-1)!.content)

/** Replies to each call with the next scripted reply (the last one repeats), and keeps what it was sent. */
export function scripted(...replies: unknown[]) {
  const sent: ChatMessage[][] = []
  const backend: ModelBackend = {
    async complete(messages) {
      sent.push(messages)
      return { json: replies[Math.min(sent.length - 1, replies.length - 1)] }
    },
  }
  return { backend, sent }
}
