import { lstat } from 'node:fs/promises'
import { ansi, epoch, fileIdentity, formatTime, lineDate, openLog, readLogHistory, type HistoryPosition } from '@gugu/log/file/read'
import { webLogFile } from '../../shared/log-files.js'

import { basename,dirname,join } from 'node:path'

import { fileURLToPath } from 'node:url'

import type { FastifyReply,FastifyRequest } from 'fastify'

import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { utc } from '@gugu/core/shared/timestamps'

export type AdminDebugLogSource = 'web' | 'worker' | 'gateway'
export interface AdminDebugLogOptions {
  requireAdmin: preHandlerHookHandler
  /** 每次轮询都重新确认 token 与 auth-version；不得只信任连接建立时的身份。 */
  verifyAdmin: (request: FastifyRequest) => Promise<boolean>
  paths: Record<AdminDebugLogSource, string>
  webCandidates: string[]
  pollIntervalMs?: number
}

export function resolveAdminDebugLogFiles(logFile: string | null): Pick<AdminDebugLogOptions, 'paths' | 'webCandidates'> {
  const directory = logFile ? dirname(logFile) : fileURLToPath(new URL('../../../logs/', import.meta.url))
  const web = webLogFile(logFile)
  return {
    paths: { web, worker: join(directory, 'gugu-worker.log'), gateway: join(directory, 'gugu-gateway.log') },
    webCandidates: logFile ? [web] : [join(directory, 'gugu-web-dev.log'), web],
  }
}

type Cursor = Partial<Record<AdminDebugLogSource, number>>
type HistoryCursor = Partial<Record<AdminDebugLogSource, HistoryPosition | number | null>>
const sources: AdminDebugLogSource[] = ['web', 'worker', 'gateway']

function decodeCursor(raw?: string): HistoryCursor {
  if (!raw) return {}
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const payload: unknown = JSON.parse(decoded)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
    const result: HistoryCursor = {}
    for (const [name, value] of Object.entries(payload)) {
      const source = name as AdminDebugLogSource
      if (!sources.includes(source)) continue
      if (value === null) { result[source] = null; continue }
      if (typeof value === 'object' && /^\d+:\d+$/.test(value.file)
        && Number.isSafeInteger(value.end) && value.end > 0) {
        result[source] = { file: value.file, end: value.end }
        continue
      }
      if (!['number', 'string'].includes(typeof value)) continue
      const position = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(value, 10)
      if (!Number.isFinite(position)) return {}
      result[name as AdminDebugLogSource] = Math.max(0, position)
    }
    return result
  } catch { return {} }
}

function encodeCursor(positions: HistoryCursor): string | null {
  const entries = Object.entries(positions).filter(([name]) => sources.includes(name as AdminDebugLogSource))
  if (!entries.length || !entries.some(([, position]) => position !== null)) return null
  const sorted = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
  return Buffer.from(JSON.stringify(sorted), 'utf8').toString('base64url')
}

async function resolveWebPath(options: AdminDebugLogOptions): Promise<string> {
  let newest: { path: string; mtime: number } | undefined
  for (const path of options.webCandidates) {
    try {
      const info = await lstat(path)
      if (!info.isFile() || basename(path) === 'gugu-diag.log') continue
      if (!newest || info.mtimeMs > newest.mtime) newest = { path, mtime: info.mtimeMs }
    } catch { /* 缺少某个候选日志时继续检查其他候选。 */ }
  }
  return newest?.path ?? options.paths.web
}

function disconnected(request: FastifyRequest, reply: FastifyReply): boolean {
  return request.raw.aborted || reply.raw.destroyed || !reply.raw.writable
}

async function streamLogs(
  request: FastifyRequest<{ Querystring: { source?: string } }>,
  reply: FastifyReply,
  options: AdminDebugLogOptions,
): Promise<void> {
  const requested = request.query.source
  const selectedSources: AdminDebugLogSource[] = requested && sources.includes(requested as AdminDebugLogSource)
    ? [requested as AdminDebugLogSource]
    : sources
  const paths: Partial<Record<AdminDebugLogSource, string>> = {}
  for (const item of selectedSources) paths[item] = item === 'web' ? await resolveWebPath(options) : options.paths[item]

  const positions: Cursor = {}
  const identities: Partial<Record<AdminDebugLogSource, string>> = {}
  const carried: Partial<Record<AdminDebugLogSource, Date>> = {}
  for (const item of selectedSources) {
    try {
      const info = await lstat(paths[item]!)
      positions[item] = info.size
      identities[item] = fileIdentity(info)
    }
    catch { positions[item] = 0 }
    carried[item] = epoch
  }

  reply.hijack()
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  const write = (value: string) => {
    if (!disconnected(request, reply)) reply.raw.write(value)
  }
  const delay = options.pollIntervalMs ?? 1000
  try {
    while (!disconnected(request, reply)) {
      let authorized = false
      try { authorized = await options.verifyAdmin(request) }
      catch { authorized = false }
      if (!authorized || disconnected(request, reply)) break

      for (const item of selectedSources) {
        if (disconnected(request, reply)) break
        const path = paths[item]!
        try {
          if (basename(path) === 'gugu-diag.log') continue
          const info = await lstat(path)
          if (!info.isFile()) continue
          const size = info.size
          const identity = fileIdentity(info)
          const previous = positions[item] ?? 0
          const position = identities[item] === identity && previous <= size ? previous : 0
          identities[item] = identity
          positions[item] = position
          if (size <= position) continue
          const handle = await openLog(path)
          let bytes: Buffer
          try {
            bytes = Buffer.alloc(size - position)
            await handle.read(bytes, 0, bytes.length, position)
          } finally { await handle.close() }
          positions[item] = size
          for (const rawLine of bytes.toString('utf8').split(/\r?\n/)) {
            const line = rawLine.replace(ansi, '').trim()
            if (!line) continue
            carried[item] = lineDate(line, carried[item] ?? epoch)
            write(`data: ${JSON.stringify({ source: item, line, time: formatTime(carried[item]!) })}\n\n`)
          }
        } catch {
          // 日志文件轮转或短暂不可读时保留连接，下一轮重新检查固定路径。
        }
      }
      write(': keepalive\n\n')
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
    }
  } finally {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end()
  }
}

export function registerAdminDebugLogRoutes(app: FastifyInstance, options: AdminDebugLogOptions): void {
  app.get<{ Querystring: { lines?: number; source?: string; cursor?: string; query?: string } }>(
    '/api/v1/admin/debug/logs/tail',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            lines: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
            source: { type: 'string' },
            cursor: { type: 'string' },
            query: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      const { lines = 200, source, cursor, query } = request.query
      const selectedSources: AdminDebugLogSource[] = source && sources.includes(source as AdminDebugLogSource)
        ? [source as AdminDebugLogSource]
        : sources
      const previous = decodeCursor(cursor)
      const positions: HistoryCursor = {}
      const rows: { time: Date; source: AdminDebugLogSource; index: number; line: string }[] = []
      for (const item of selectedSources) {
        if (previous[item] === null) { positions[item] = null; continue }
        const path = item === 'web' ? await resolveWebPath(options) : options.paths[item]
        const page = await readLogHistory(path, { cursor: previous[item], lines, query })
        positions[item] = page.next
        page.lines.forEach((row, index) => rows.push({ ...row, source: item, index }))
      }
      rows.sort((a, b) => a.time.getTime() - b.time.getTime() || a.source.localeCompare(b.source) || a.index - b.index)
      return {
        lines: rows.map(({ time, source: item, line }) => ({ source: item, line, time: formatTime(time) })),
        next_cursor: encodeCursor(positions),
        has_more: Object.values(positions).some(position => position !== null),
      }
    },
  )

  app.get<{ Querystring: { source?: string } }>(
    '/api/v1/admin/debug/logs/stream',
    { preHandler: options.requireAdmin, schema: { querystring: { type: 'object', properties: { source: { type: 'string' } } } } },
    (request, reply) => streamLogs(request, reply, options),
  )
}

export interface SystemLogOptions {
  requireAdmin: preHandlerHookHandler
  list(limit: number, level: string | null): Promise<{ items: SystemLogRow[] }>
}

export function registerSystemLogRoutes(app: FastifyInstance, options: SystemLogOptions): void {
  app.get('/api/v1/admin/system-logs', { preHandler: options.requireAdmin }, async (request, reply) => {
    const { limit = '200', level } = request.query as Record<string, unknown>
    if (typeof limit !== 'string' || !/^[+-]?\d+$/.test(limit.trim()) || !Number.isSafeInteger(Number(limit)) || (level !== undefined && typeof level !== 'string'))
      return reply.code(422).send({ detail: '系统日志查询参数无效' })
    return options.list(Number(limit), typeof level === 'string' ? level : null)
  })
}

export interface SystemLogRow {
  id: number
  level: string
  module: string
  message: string
  traceback: string | null
  created_at: string
}
export type SystemLogQuery = (text: string, params: unknown[]) => Promise<{ rows: SystemLogRow[] }>

/** 服务端运维日志查询；只有 Host 可信管理员入口可以装配。 */
export function createSystemLogReader(query: SystemLogQuery) {
  return {
    async list(limit = 200, level: string | null = null): Promise<{ items: SystemLogRow[] }> {
      const filter = level ? ' WHERE level=$2' : ''
      const result = await query(`SELECT id,level,module,message,traceback,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00:00' AS created_at
        FROM system_logs${filter} ORDER BY created_at DESC LIMIT $1`, level ? [limit, level.toUpperCase()] : [limit])
      return { items: result.rows.map(row => ({ ...row, id: Number(row.id), created_at: utc(row.created_at).replace(' ', 'T') })) }
    },
  }
}
