import { isAbsolute, join, normalize, resolve } from 'node:path'
import { parseAdjustment } from './adjust'
import { MAX_HINT_LIMIT } from './hints'
import { mcp } from './mcp'
import { reviewBrief } from './review'
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
/** The Vite dev server's port; viewer/vite.config.ts pins it with strictPort so the two cannot drift apart. */
export const VIEWER_DEV_PORT = 5173

/**
 * Every mutating route passes this first. Only pages served by this server or by the viewer's dev server may send
 * an Origin; any other page, including another local app or a rebound DNS name that resolves here, is refused. The
 * harness plugins send none. Requiring a JSON body keeps a cross-site form post, which cannot set that content type,
 * from reaching a route at all.
 */
function refuseMutation(req: Request, ownPort: number): Response | null {
  const origin = req.headers.get('origin')
  if (origin !== null && !isOwnOrigin(origin, ownPort)) return fail('cross-origin requests are refused', 403)
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('content-type must be application/json', 415)
  return null
}

function isOwnOrigin(origin: string, ownPort: number) {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && [ownPort, VIEWER_DEV_PORT].includes(Number(url.port))
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

/**
 * 200 with the result when the op applied, 409 when the data it names does not allow it, 202 when it failed partway
 * and is applied again, and 503 when it could not even be logged, so nothing changed.
 */
async function adjust(zephyr: Zephyr, req: Request) {
  const parsed = await jsonBody(req)
  if (!parsed.ok) return fail('body must be JSON')
  const adjustment = parseAdjustment(parsed.body)
  if (!adjustment.ok) return fail(adjustment.error)
  let result: Awaited<ReturnType<Zephyr['adjust']>>
  try {
    result = await zephyr.adjust(adjustment.adjustment)
  } catch (err) {
    return fail(`the adjustment could not be logged, so nothing changed: ${(err as Error).message}`, 503)
  }
  return json(result, result.ok ? 200 : 'pending' in result ? 202 : 409)
}

const MAX_HISTORY_PAGE = 200

async function runHistory(zephyr: Zephyr, params: URLSearchParams) {
  const limit = params.get('limit') ?? '50'
  const n = Number(limit)
  if (!/^\d+$/.test(limit) || n < 1 || n > MAX_HISTORY_PAGE) return fail(`limit must be an integer from 1 to ${MAX_HISTORY_PAGE}`)
  const page = await zephyr.runHistory(params.get('before'), n)
  return json(page)
}

async function hints(zephyr: Zephyr, params: URLSearchParams) {
  const q = params.get('q')
  if (q === null) return fail('q is required')
  const limit = params.get('limit') ?? '3'
  const n = Number(limit)
  if (!/^\d+$/.test(limit) || n < 1 || n > MAX_HINT_LIMIT) return fail(`limit must be an integer from 1 to ${MAX_HINT_LIMIT}`)
  return json(await zephyr.hints(q, n))
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
    async fetch(req, server) {
      const { pathname, searchParams } = new URL(req.url)
      const route = `${req.method} ${pathname}`
      if (req.method !== 'GET') {
        const refused = refuseMutation(req, server.port!)
        if (refused) return refused
      }
      switch (route) {
        case 'POST /sessions':
          return registerSession(zephyr, req)
        case 'POST /api/review/done':
          return finishReview(zephyr, req)
        case 'POST /api/adjustments':
          return adjust(zephyr, req)
        case 'POST /mcp':
          return mcp(zephyr, req)
        case 'GET /mcp':
          return new Response(null, { status: 405, headers: { allow: 'POST' } })
        case 'GET /api/review':
          return json(await zephyr.review())
        case 'GET /api/review/brief':
          return new Response(reviewBrief(await zephyr.review()), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
        case 'GET /status':
          return json(zephyr.status())
        case 'GET /api/views':
          return json(zephyr.listViews())
        case 'GET /api/entries':
          return json(zephyr.listEntries())
        case 'GET /api/runs':
          return json(zephyr.listRuns())
        case 'GET /api/runs/history':
          return runHistory(zephyr, searchParams)
        case 'GET /hints':
          return hints(zephyr, searchParams)
        case 'GET /events':
          return sse(zephyr, req.signal)
      }
      if (req.method === 'GET' && pathname.startsWith('/api/purge/')) {
        const noteId = decodeURIComponent(pathname.slice('/api/purge/'.length))
        const status = await zephyr.purgeStatus(noteId)
        return status ? json(status) : fail(`note ${noteId} was not purged`, 404)
      }
      if (req.method === 'GET') return serveStatic(opts.distDir, pathname)
      return fail('not found', 404)
    },
  })
}
