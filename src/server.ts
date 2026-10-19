import { isAbsolute, join, normalize, resolve } from 'node:path'
import type { Zephyr } from './zephyr'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const fail = (error: string, status = 400) => json({ ok: false, error }, status)

function sse(zephyr: Zephyr, signal: AbortSignal) {
  const enc = new TextEncoder()
  let unsubscribe: () => unknown = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    unsubscribe()
    clearInterval(heartbeat)
  }
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk))
        } catch {
          cleanup()
        }
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
    cancel: cleanup,
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Every mutating route passes this first. A browser page on another host, including a rebound DNS name that
 * resolves here, sends its own Origin and is refused; the harness plugins send none. Requiring a JSON body keeps a
 * cross-site form post, which cannot set that content type, from reaching a route at all.
 */
function refuseMutation(req: Request): Response | null {
  const origin = req.headers.get('origin')
  if (origin !== null && !isLoopback(origin)) return fail('cross-origin requests are refused', 403)
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('content-type must be application/json', 415)
  return null
}

function isLoopback(origin: string) {
  try {
    return LOOPBACK.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

async function jsonBody(req: Request): Promise<{ ok: true; body: any } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false }
  }
}

async function registerSession(zephyr: Zephyr, req: Request) {
  const parsed = await jsonBody(req)
  if (!parsed.ok) return fail('body must be JSON')
  const { harness, sessionId, transcriptPath } = parsed.body ?? {}
  if (typeof harness !== 'string' || typeof sessionId !== 'string' || !sessionId)
    return fail('harness and sessionId are required strings')
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath))
    return fail('transcriptPath must be an absolute path')
  try {
    await zephyr.registerSession(harness, sessionId, transcriptPath)
  } catch (err) {
    return fail((err as Error).message)
  }
  return json({ ok: true })
}

async function finishReview(zephyr: Zephyr, req: Request) {
  const parsed = await jsonBody(req)
  if (!parsed.ok) return fail('body must be JSON')
  const closed = await zephyr.finishReview(parsed.body?.until)
  return closed.ok ? json({ ok: true, lastReviewedAt: closed.until }) : fail(closed.error)
}

async function hints(zephyr: Zephyr, params: URLSearchParams) {
  const q = params.get('q')
  if (q === null) return fail('q is required')
  const limit = params.get('limit') ?? '3'
  if (!/^[1-5]$/.test(limit)) return fail('limit must be an integer from 1 to 5')
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
      if (req.method !== 'GET') {
        const refused = refuseMutation(req)
        if (refused) return refused
      }
      switch (route) {
        case 'POST /sessions':
          return registerSession(zephyr, req)
        case 'POST /api/review/done':
          return finishReview(zephyr, req)
        case 'GET /api/review':
          return json(await zephyr.review())
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
      return fail('not found', 404)
    },
  })
}
