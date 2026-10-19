import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { readComplete } from '../src/tailer'

async function tempFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'zephyr-tail-'))
  const path = join(dir, 't.jsonl')
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
