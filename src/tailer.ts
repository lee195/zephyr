import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { Batch } from './domain'

export interface Chunk {
  lines: string[]
  offset: number
}

/** Complete lines after `offset`; the returned offset never moves past an unterminated trailing line. */
export async function readComplete(path: string, offset: number): Promise<Chunk> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return { lines: [], offset }
  }
  // A shrunken file was rewritten; start over and let entry-id dedupe absorb the replay.
  if (size < offset) offset = 0
  if (size === offset) return { lines: [], offset }

  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (lastNewline === -1) return { lines: [], offset }
    const text = buf.subarray(0, lastNewline).toString('utf8')
    return { lines: text.split('\n').filter((l) => l.trim() !== ''), offset: offset + lastNewline + 1 }
  } finally {
    await fh.close()
  }
}

/** Watches one transcript and delivers each batch its adapter reads, serially. */
export class Tailer {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private again = false

  constructor(
    private path: string,
    private offset: number,
    private read: (offset: number) => Promise<Batch>,
    private onBatch: (batch: Batch) => Promise<void>,
    private pollMs = 1000,
  ) {}

  start() {
    try {
      this.watcher = watch(this.path, () => void this.poke())
      this.watcher.on('error', () => {})
    } catch {
      // The file may not exist yet; the poll below covers it.
    }
    this.timer = setInterval(() => void this.poke(), this.pollMs)
    return this.poke()
  }

  stop() {
    this.watcher?.close()
    if (this.timer) clearInterval(this.timer)
    this.watcher = null
    this.timer = null
  }

  async poke(): Promise<void> {
    if (this.reading) {
      this.again = true
      return
    }
    this.reading = true
    try {
      do {
        this.again = false
        const batch = await this.read(this.offset)
        if (batch.rows.length > 0 || batch.offset !== this.offset) {
          await this.onBatch(batch)
          this.offset = batch.offset
        }
      } while (this.again)
    } catch (err) {
      console.error(`[zephyr] tail ${this.path}: ${(err as Error).message}`)
    } finally {
      this.reading = false
    }
  }
}
