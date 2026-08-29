import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZodError } from 'zod'
import { TraceStore } from '@loopscope/storage'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const allowedOrigins = new Set([
  'http://127.0.0.1:4319',
  'http://localhost:4319',
  ...String(process.env.LOOPSCOPE_CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
])

function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin
  if (origin && allowedOrigins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 24 * 1024 * 1024) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('payload too large')
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : {}
}

function integerParam(url: URL, name: string, fallback: number, min: number, max: number) {
  const raw = url.searchParams.get(name)
  if (raw == null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error('invalid ' + name)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid ' + name)
  return value
}

export function createCollectorServer(store: TraceStore) {
  return createServer(async (req, res) => {
  applyCors(req, res)
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
  const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'))
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: '0.3.0', runtime: 'node', orm: 'drizzle', db: store.connection.path })
      return
    }
    if (req.method === 'POST' && pathname === '/api/collector/runs') {
      sendJson(res, 200, store.ingestRun(await readJson(req)))
      return
    }
    if (req.method === 'GET' && pathname === '/api/sessions') {
      sendJson(res, 200, store.listSessions())
      return
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/(.+)\/runs$/)
    if (req.method === 'GET' && sessionMatch) {
      const limit = integerParam(url, 'limit', 20, 1, 100)
      const beforeRaw = url.searchParams.get('before')
      const before = beforeRaw == null || beforeRaw === '' ? undefined : Number(beforeRaw)
      if (before !== undefined && !Number.isFinite(before)) throw new Error('invalid before')
      sendJson(res, 200, store.listRuns(decodeURIComponent(sessionMatch[1]!), { limit, before }))
      return
    }
    const spansMatch = pathname.match(/^\/api\/runs\/([^/]+)\/spans$/)
    if (req.method === 'GET' && spansMatch) {
      const limit = integerParam(url, 'limit', 100, 1, 200)
      const offset = integerParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
      const result = store.listSpans(decodeURIComponent(spansMatch[1]!), { limit, offset })
      sendJson(res, result ? 200 : 404, result ?? { error: 'run not found' })
      return
    }
    const contextMatch = pathname.match(/^\/api\/runs\/([^/]+)\/context$/)
    if (req.method === 'GET' && contextMatch) {
      sendJson(res, 200, store.listContext(decodeURIComponent(contextMatch[1]!)))
      return
    }
    const usageMatch = pathname.match(/^\/api\/runs\/([^/]+)\/usage$/)
    if (req.method === 'GET' && usageMatch) {
      sendJson(res, 200, store.listUsage(decodeURIComponent(usageMatch[1]!)))
      return
    }
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/)
    if (req.method === 'GET' && runMatch) {
      const includeSpans = url.searchParams.get('include_spans') !== 'false'
      const run = store.getRun(decodeURIComponent(runMatch[1]!), includeSpans)
      sendJson(res, run ? 200 : 404, run ?? { error: 'run not found' })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (error) {
    if (error instanceof ZodError) {
      sendJson(res, 400, { error: 'invalid trace payload', issues: error.issues })
      return
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { error: 'invalid json' })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const status = message === 'payload too large' ? 413 : message.startsWith('invalid ') ? 400 : 500
    sendJson(res, status, { error: status === 500 ? 'internal server error' : message })
  }
  })
}

export function startCollectorServer(options: { host?: string; port?: number; databasePath?: string } = {}) {
  const host = options.host ?? process.env.LOOPSCOPE_HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.LOOPSCOPE_PORT ?? 4320)
  const databasePath = options.databasePath ?? process.env.LOOPSCOPE_DB_PATH ?? path.join(root, 'data', 'loopscope.db')
  const store = new TraceStore(databasePath)
  const server = createCollectorServer(store)
  server.on('listening', () => {
    console.log('[loopscope] collector 0.3 listening on http://' + host + ':' + port)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => { store.close(); process.exit(0) }))
  }
  server.listen(port, host)
  return { server, store }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startCollectorServer()
