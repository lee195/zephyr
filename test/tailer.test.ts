import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import type { Batch } from '../src/domain'
import { readComplete, Tailer } from '../src/tailer'
import { gate, tempDir } from './helpers'

async function tempFile(content: string) {
  const path = join(await tempDir(), 't.jsonl')
  await writeFile(path, content)
  return path
}

test('a partial trailing line is held back until it completes', async () => {
  const path = await tempFile('{"a":1}\n{"b":')
  const first = await readComplete(path, 0)
  expect(first.lines).toEqual(['{"a":1}'])

  await appendFile(path, '2}\n')
  const second = await readComplete(path, first.offset)
  expect(second.lines).toEqual(['{"b":2}'])
})

test('resuming from a stored offset yields only lines written after it', async () => {
  const path = await tempFile('one\ntwo\n')
  const { offset } = await readComplete(path, 0)
  await appendFile(path, 'three\n')
  expect((await readComplete(path, offset)).lines).toEqual(['three'])
  expect((await readComplete(path, (await readComplete(path, offset)).offset)).lines).toEqual([])
})

test('multi-byte text keeps byte offsets exact', async () => {
  const path = await tempFile('ünïcødé ✓\n')
  const first = await readComplete(path, 0)
  await appendFile(path, 'next\n')
  expect((await readComplete(path, first.offset)).lines).toEqual(['next'])
})

test('a missing file reads as empty without moving the offset', async () => {
  expect(await readComplete('/nonexistent/zephyr.jsonl', 5)).toEqual({ lines: [], offset: 5 })
})

test('a read in flight when the tailer stops delivers nothing, and no further read starts', async () => {
  const g = gate()
  g.hold()
  let reads = 0
  const delivered: Batch[] = []
  const tailer = new Tailer(
    '/nonexistent/t.jsonl',
    0,
    async () => {
      reads++
      await g.pass()
      return { rows: [{ id: 'r1', sessionId: 's', at: '2026-10-20T00:00:00Z', role: 'user', text: '[zephyr] note' }], offset: 10 }
    },
    async (batch) => void delivered.push(batch),
    60_000,
  )
  const first = tailer.start()
  await Bun.sleep(5)
  void tailer.poke()
  tailer.stop()
  g.release()
  await first
  expect([reads, delivered.length]).toEqual([1, 0])
})
