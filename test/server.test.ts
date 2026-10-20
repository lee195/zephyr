import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { scripted, seedDataDir, tempDir } from './helpers'

const POLICY = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"

test('HTML responses carry the content security policy; other files do not need it', async () => {
  const dist = await tempDir()
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>z</title>')
  await writeFile(join(dist, 'assets/app.js'), 'console.log(1)')
  const z = new Zephyr({ dataDir: await tempDir(), backend: scripted({ ops: [] }).backend })
  await z.start()
  const server = serve(z, { port: 0, distDir: dist })
  try {
    const base = `http://127.0.0.1:${server.port}`
    for (const path of ['/', '/index.html', '/some/client/route']) {
      const res = await fetch(base + path)
      expect(res.headers.get('content-security-policy')).toBe(POLICY)
      expect(await res.text()).toContain('<title>z</title>')
    }
    expect((await fetch(`${base}/assets/app.js`)).headers.get('content-security-policy')).toBeNull()
  } finally {
    server.stop(true)
    z.stop()
  }
})

test('run history pages through runs.jsonl newest first, and says when older runs remain', async () => {
  const at = (i: number) => `2026-10-20T08:00:${String(i).padStart(2, '0')}.000Z`
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, kind: 'organizer', entryIds: [], status: 'done' as const, attempt: 1, endedAt: at(i) }))
  const z = new Zephyr({ dataDir: await seedDataDir({ entries: [], runs: [...runs].reverse() }), backend: scripted({ ops: [] }).backend, kinds: {} })
  await z.start()
  const server = serve(z, { port: 0, distDir: '/nonexistent' })
  try {
    const page = async (query: string) => (await fetch(`http://127.0.0.1:${server.port}/api/runs/history?${query}`)).json()
    const first = await page('limit=2')
    expect([first.runs.map((r: { id: string }) => r.id), first.more]).toEqual([['r4', 'r3'], true])
    const second = await page(`limit=2&before=${encodeURIComponent(first.runs[1].endedAt)}`)
    expect([second.runs.map((r: { id: string }) => r.id), second.more]).toEqual([['r2', 'r1'], true])
    const last = await page(`limit=2&before=${encodeURIComponent(second.runs[1].endedAt)}`)
    expect([last.runs.map((r: { id: string }) => r.id), last.more]).toEqual([['r0'], false])
    for (const bad of ['limit=0', 'limit=201', 'limit=x']) expect((await fetch(`http://127.0.0.1:${server.port}/api/runs/history?${bad}`)).status).toBe(400)
  } finally {
    server.stop(true)
    z.stop()
  }
})
