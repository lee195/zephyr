import { isAbsolute, join, normalize, resolve } from 'node:path'
import type { Zephyr } from './zephyr'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function sse(zephyr: Zephyr, signal: AbortSignal) {
  const enc = new TextEncoder()
  let unsubscribe: () => unknown = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const cleanup = () => {
        unsubscribe()
        clearInterval(heartbeat)
      }
      send(': connected\n\n')
      unsubscribe = zephyr.subscribe((e) => send(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`))
      heartbeat = setInterval(() => send(': ping\n\n'), 15_000)
      signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {}
      })
    },
    cancel() {
      unsubscribe()
      clearInterval(heartbeat)
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}

async function registerSession(zephyr: Zephyr, req: Request) {
  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400)
  }
  const { harness, sessionId, transcriptPath } = body ?? {}
  if (typeof harness !== 'string' || typeof sessionId !== 'string' || !sessionId)
    return json({ ok: false, error: 'harness and sessionId are required strings' }, 400)
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath))
    return json({ ok: false, error: 'transcriptPath must be an absolute path' }, 400)
  try {
    await zephyr.registerSession(harness, sessionId, transcriptPath)
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 400)
  }
  return json({ ok: true })
}

async function hints(zephyr: Zephyr, params: URLSearchParams) {
  const q = params.get('q')
  if (q === null) return json({ ok: false, error: 'q is required' }, 400)
  const limit = params.get('limit') ?? '3'
  if (!/^[1-5]$/.test(limit)) return json({ ok: false, error: 'limit must be an integer from 1 to 5' }, 400)
  return json(await zephyr.hints(q, Number(limit)))
}

/** Defense in depth behind the viewer's own rendering rules: no inline or foreign script can run in the page. */
export const CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"

function fileResponse(file: ReturnType<typeof Bun.file>) {
  return new Response(file, file.type.startsWith('text/html') ? { headers: { 'content-security-policy': CSP } } : undefined)
}

async function serveStatic(distDir: string, pathname: string) {
  const root = resolve(distDir)
  const target = resolve(join(root, normalize(decodeURIComponent(pathname))))
  if (target.startsWith(root + '/')) {
    const file = Bun.file(target)
    if (await file.exists()) return fileResponse(file)
  }
  const index = Bun.file(join(root, 'index.html'))
  if (await index.exists()) return fileResponse(index)
  return new Response('viewer not built; run `bun run build`', { status: 503 })
}

export function serve(zephyr: Zephyr, opts: { port: number; distDir: string }) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url)
      const route = `${req.method} ${pathname}`
      switch (route) {
        case 'POST /sessions':
          return registerSession(zephyr, req)
        case 'GET /status':
          return json(zephyr.status())
        case 'GET /api/views':
          return json(zephyr.listViews())
        case 'GET /api/entries':
          return json(zephyr.listEntries())
        case 'GET /api/runs':
          return json(zephyr.listRuns())
        case 'GET /hints':
          return hints(zephyr, searchParams)
        case 'GET /events':
          return sse(zephyr, req.signal)
      }
      if (req.method === 'GET') return serveStatic(opts.distDir, pathname)
      return json({ ok: false, error: 'not found' }, 404)
    },
  })
}
