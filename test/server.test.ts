import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { serve } from '../src/server'
import { Zephyr } from '../src/zephyr'
import { scripted, tempDir } from './helpers'

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
