import { open, stat } from 'node:fs/promises'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export type AdminDebugLogSource = 'web' | 'worker' | 'gateway'
export interface AdminDebugLogOptions {
  requireAdmin: preHandlerHookHandler
  /** 每次轮询都重新确认 token 与 auth-version；不得只信任连接建立时的身份。 */
  verifyAdmin: (request: FastifyRequest) => Promise<boolean>
  paths: Record<AdminDebugLogSource, string>
  webCandidates: string[]
  pollIntervalMs?: number
}

type Cursor = Partial<Record<AdminDebugLogSource, number>>
type LogPage = { lines: string[]; start: number; carried: Date }
const sources: AdminDebugLogSource[] = ['web', 'worker', 'gateway']
const epoch = new Date(0)
const timestamp = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/
const ansi = /\x1b\[[0-9;]*[mK]/g
const chunkSize = 64 * 1024

function decodeCursor(raw?: string): Cursor {
  if (!raw) return {}
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    const payload: unknown = JSON.parse(decoded)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
    const result: Cursor = {}
    for (const [name, value] of Object.entries(payload)) {
      if (!sources.includes(name as AdminDebugLogSource) || !['number', 'string'].includes(typeof value)) continue
      const position = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(value, 10)
      if (!Number.isFinite(position)) return {}
      result[name as AdminDebugLogSource] = Math.max(0, position)
    }
    return result
  } catch { return {} }
}

function encodeCursor(positions: Cursor): string | null {
  const entries = Object.entries(positions).filter(([name]) => sources.includes(name as AdminDebugLogSource))
  if (!entries.length || !entries.some(([, position]) => (position ?? 0) > 0)) return null
  const sorted = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
  return Buffer.from(JSON.stringify(sorted), 'utf8').toString('base64url')
}

function lineDate(line: string, carried: Date): Date {
  const match = timestamp.exec(line)
  if (!match) return carried
  const [, month, day, hour, minute, second] = match
  const parsed = new Date(Date.UTC(new Date().getUTCFullYear(), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
  return parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day) ? parsed : carried
}

function formatTime(date: Date): string {
  if (date.getTime() <= epoch.getTime()) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function splitLines(raw: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 10) {
      lines.push(raw.subarray(start, index))
      start = index + 1
    }
  }
  lines.push(raw.subarray(start))
  return lines
}

async function findPreviousTimestamp(path: string, offset: number): Promise<Date> {
  let cursor = Math.max(0, offset)
  try {
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkSize)
      const handle = await open(path, 'r')
      let raw: Buffer
      try { raw = Buffer.alloc(cursor - start); await handle.read(raw, 0, raw.length, start) }
      finally { await handle.close() }
      for (const line of raw.toString('utf8').split('\n').reverse()) {
        const carried = lineDate(line, epoch)
        if (carried > epoch) return carried
      }
      cursor = start
    }
  } catch { return epoch }
  return epoch
}

async function readLogPage(path: string, end: number | undefined, count: number): Promise<LogPage> {
  try {
    const size = (await stat(path)).size
    const upper = Math.min(size, Math.max(0, end ?? size))
    if (upper <= 0) return { lines: [], start: 0, carried: epoch }
    let cursor = upper
    let raw = Buffer.alloc(0)
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkSize)
      const handle = await open(path, 'r')
      let part: Buffer
      try { part = Buffer.alloc(cursor - start); await handle.read(part, 0, part.length, start) }
      finally { await handle.close() }
      raw = Buffer.concat([part, raw])
      cursor = start
      const newlineCount = raw.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0)
      if (newlineCount + (cursor === 0 ? 1 : 0) >= count || cursor === 0) break
    }
    let lines = splitLines(raw)
    const discardedPrefix = cursor > 0 && lines.length ? lines[0]!.length + 1 : 0
    if (cursor > 0 && lines.length) lines = lines.slice(1)
    if (lines.at(-1)?.length === 0) lines.pop()
    if (!lines.length) return { lines: [], start: cursor, carried: epoch }
    const selected = lines.slice(-count)
    const prefixLines = lines.slice(0, lines.length - selected.length)
    const prefixLength = prefixLines.reduce((sum, line) => sum + line.length + 1, 0)
    const pageStart = cursor + discardedPrefix + prefixLength
    let carried = epoch
    for (const line of prefixLines.reverse()) {
      carried = lineDate(line.toString('utf8'), epoch)
      if (carried > epoch) break
    }
    if (carried === epoch && pageStart > 0) carried = await findPreviousTimestamp(path, pageStart)
    return {
      lines: selected.map((line) => line.toString('utf8').replace(ansi, '')).filter((line) => line.trim().length > 0),
      start: pageStart,
      carried,
    }
  } catch { return { lines: [], start: 0, carried: epoch } }
}

async function resolveWebPath(options: AdminDebugLogOptions): Promise<string> {
  let newest: { path: string; mtime: number } | undefined
  for (const path of options.webCandidates) {
    try {
      const info = await stat(path)
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
  const carried: Partial<Record<AdminDebugLogSource, Date>> = {}
  for (const item of selectedSources) {
    try { positions[item] = (await stat(paths[item]!)).size }
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
          const size = (await stat(path)).size
          const position = positions[item] ?? size
          if (size <= position) continue
          const handle = await open(path, 'r')
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
      const positions: Cursor = {}
      const rows: { time: Date; source: AdminDebugLogSource; index: number; line: string }[] = []
      const needle = query?.trim().toLocaleLowerCase() ?? ''
      for (const item of selectedSources) {
        const path = item === 'web' ? await resolveWebPath(options) : options.paths[item]
        let end = previous[item]
        let matched = 0
        while (true) {
          const page = await readLogPage(path, end, lines)
          positions[item] = page.start
          let carried = page.carried
          page.lines.forEach((line, index) => {
            carried = lineDate(line, carried)
            if (needle && !line.toLocaleLowerCase().includes(needle)) return
            rows.push({ time: carried, source: item, index, line })
            matched += 1
          })
          if (!needle || matched >= lines || page.start <= 0 || page.lines.length === 0) break
          end = page.start
        }
      }
      rows.sort((a, b) => a.time.getTime() - b.time.getTime() || a.source.localeCompare(b.source) || a.index - b.index)
      return {
        lines: rows.map(({ time, source: item, line }) => ({ source: item, line, time: formatTime(time) })),
        next_cursor: encodeCursor(positions),
        has_more: Object.values(positions).some((position) => (position ?? 0) > 0),
      }
    },
  )

  app.get<{ Querystring: { source?: string } }>(
    '/api/v1/admin/debug/logs/stream',
    { preHandler: options.requireAdmin, schema: { querystring: { type: 'object', properties: { source: { type: 'string' } } } } },
    (request, reply) => streamLogs(request, reply, options),
  )
}
