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

test('archived versions and saved summaries are listed and read, and a name outside their folders is refused', async () => {
  const dataDir = await tempDir()
  const z = new Zephyr({ dataDir, backend: scripted({ ops: [] }).backend, kinds: {} })
  await z.start()
  const view = { id: 'organizer/garden', kind: 'organizer', slug: 'garden', title: 'Garden', format: 'md' as const, body: 'old body', sources: [], updatedAt: '2026-10-20T08:00:00.000Z' }
  await z.store.archiveView(view)
  await z.store.archiveView({ ...view, body: 'older body', updatedAt: '2026-10-19T08:00:00.000Z' })
  await z.store.saveSummary({ since: null, until: '2026-10-20T09:00:00.000Z', noteIds: ['a', 'b'], summary: 'We talked about tomatoes.' })
  const server = serve(z, { port: 0, distDir: '/nonexistent' })
  try {
    const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`)
    expect(await (await get('/api/history/organizer/garden')).json()).toEqual([
      { at: '2026-10-20T08:00:00.000Z', format: 'md' },
      { at: '2026-10-19T08:00:00.000Z', format: 'md' },
    ])
    expect(await (await get(`/api/history/organizer/garden/${encodeURIComponent('2026-10-19T08:00:00.000Z')}`)).json()).toEqual({ at: '2026-10-19T08:00:00.000Z', format: 'md', body: 'older body' })
    expect(await (await get('/api/history/organizer/unknown')).json()).toEqual([])
    expect((await get('/api/history/organizer/garden/2026-01-01T00:00:00.000Z')).status).toBe(404)
    // Lists answer an empty list for a name that is not one; reads answer 404.
    for (const bad of ['/api/history/..%2F..%2Fentries/x']) expect(await (await get(bad)).json()).toEqual([])
    for (const bad of ['/api/history/organizer/%2E%2E', '/api/history/organizer/garden/..%2F..%2Fgarden', '/api/summaries/..%2Freview', '/api/history/a/b/c/d']) expect((await get(bad)).status).toBe(404)
    expect(await (await get('/api/summaries')).json()).toEqual([{ since: null, until: '2026-10-20T09:00:00.000Z', noteCount: 2 }])
    expect(await (await get(`/api/summaries/${encodeURIComponent('2026-10-20T09:00:00.000Z')}`)).json()).toEqual({ since: null, until: '2026-10-20T09:00:00.000Z', noteCount: 2, summary: 'We talked about tomatoes.' })
    expect((await get('/api/summaries/2026-10-21T09:00:00.000Z')).status).toBe(404)
  } finally {
    server.stop(true)
    z.stop()
  }
})
