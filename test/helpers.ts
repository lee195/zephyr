import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, Entry, ModelBackend, Run, View } from '../src/domain'
import { Store } from '../src/store'

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

/** A finished run of this kind that covered these entries, so a start does not queue them again for it. */
export const doneRun = (kind: string, entryIds: string[]): Run => ({ id: `done-${kind}`, kind, entryIds, status: 'done', attempt: 1 })

/** A data dir holding these entries, these finished runs, and these views, as the store writes them. No runs: a data dir from before runs.jsonl. */
export async function seedDataDir(opts: { entries: Entry[]; runs?: Run[]; views?: Omit<View, 'id'>[] }) {
  const dir = await tempDir()
  const store = new Store(dir)
  await store.init()
  await store.appendEntries(opts.entries)
  for (const r of opts.runs ?? []) await store.appendRun(r)
  for (const v of opts.views ?? []) await store.writeView({ id: `${v.kind}/${v.slug}`, ...v })
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

/**
 * A fake /embeddings endpoint: a text's vector counts its a, b and c characters. Keeps every input batch it was
 * sent. While hold(input) says so, a request waits until release().
 */
export function fakeEmbeddings() {
  const batches: string[][] = []
  let held: Array<() => void> = []
  const state = { hold: (_input: string[]) => false }
  const fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] }
    batches.push(input)
    if (state.hold(input)) await new Promise<void>((r) => held.push(r))
    const data = input.map((text, index) => ({ index, embedding: ['a', 'b', 'c'].map((ch) => text.split(ch).length - 1) }))
    return Response.json({ data })
  }) as typeof globalThis.fetch
  return {
    fetch,
    batches,
    sentTexts: () => batches.flat(),
    hold: (when: (input: string[]) => boolean) => (state.hold = when),
    release: () => {
      state.hold = () => false
      for (const r of held) r()
      held = []
    },
  }
}
