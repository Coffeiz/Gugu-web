import { statfsSync } from 'node:fs'
import type { Pool } from 'pg'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { resolve } from 'node:path'

export interface AdminStorageSnapshotRow {
  category: string
  taken_at: Date | string
  object_count: number | string | bigint
  total_bytes: number | string | bigint
}

export type AdminStorageSnapshotQuery = (
  sql: string,
  values: unknown[],
) => Promise<AdminStorageSnapshotRow[]>

export interface AdminStorageSnapshotOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminStorageSnapshotQuery
  diskUsage(): Promise<StorageDiskUsage | null> | StorageDiskUsage | null
  now?: () => Date | string
}

export interface StorageDiskUsage {
  total_bytes: number | bigint
  used_bytes: number | bigint
  free_bytes: number | bigint
}

export interface StorageLocation {
  backend: 'local' | 'oss'
  localPath: string
}

export const STORAGE_SNAPSHOTS_SQL = `
SELECT category,
       to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS taken_at,
       object_count,
       total_bytes
FROM storage_category_snapshots
WHERE taken_at >= $1::timestamptz
ORDER BY taken_at ASC
`

export function createPostgresAdminStorageSnapshotQuery(pool: Pick<Pool, 'query'>): AdminStorageSnapshotQuery {
  return async (sql, values) => (await pool.query(sql, values as never[])).rows as AdminStorageSnapshotRow[]
}

/** 与 Python shutil.disk_usage 一样区分实际已用和调用者可用空间。 */
export function diskUsageForStorage(storage: StorageLocation): StorageDiskUsage | null {
  if (storage.backend === 'oss') return null
  try {
    const stats = statfsSync(resolve(storage.localPath), { bigint: true })
    return {
      total_bytes: stats.bsize * stats.blocks,
      used_bytes: (stats.blocks - stats.bfree) * stats.bsize,
      free_bytes: stats.bavail * stats.bsize,
    }
  } catch {
    return null
  }
}

function isoUtc(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('invalid timestamp')
    return value.toISOString()
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value)
  if (match) {
    const fraction = match[2]
    return `${match[1]}${fraction && !/^0+$/.test(fraction) ? `.${fraction.padEnd(6, '0')}` : ''}Z`
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp')
  return date.toISOString()
}

function integerValue(value: number | string | bigint): number | bigint {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('invalid integer')
    return value
  }
  if (!/^-?\d+$/.test(value)) throw new Error('invalid integer')
  const parsed = BigInt(value)
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) && parsed >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(parsed)
    : parsed
}

function jsonWithBigInt(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('invalid JSON value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(jsonWithBigInt).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}:${jsonWithBigInt(item)}`).join(',')}}`
  }
  throw new Error('invalid JSON value')
}

function cutoffIso(value: Date | string, days: number): string {
  if (value instanceof Date) {
    const cutoff = new Date(value.getTime() - days * 86_400_000)
    if (Number.isNaN(cutoff.getTime())) throw new Error('invalid clock')
    return cutoff.toISOString()
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) {
    const cutoff = new Date(new Date(value).getTime() - days * 86_400_000)
    if (Number.isNaN(cutoff.getTime())) throw new Error('invalid clock')
    return cutoff.toISOString()
  }
  const wholeSecond = new Date(`${match[1]}${match[3] ?? 'Z'}`)
  if (Number.isNaN(wholeSecond.getTime())) throw new Error('invalid clock')
  const cutoffSecond = new Date(wholeSecond.getTime() - days * 86_400_000).toISOString().slice(0, 19)
  const fraction = match[2]?.padEnd(6, '0')
  return `${cutoffSecond}${fraction && /[1-9]/.test(fraction) ? `.${fraction}` : ''}Z`
}

function safeFailure(): Error & { statusCode: number } {
  return Object.assign(new Error('服务器内部错误，请稍后重试'), { statusCode: 500 })
}

export function registerAdminStorageSnapshotsRoute(app: FastifyInstance, options: AdminStorageSnapshotOptions): void {
  app.get<{ Querystring: { days?: number } }>(
    '/api/v1/admin/ops/storage-snapshots',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        },
      },
    },
    async (request, reply) => {
      const days = request.query.days ?? 30
      let cutoff: string
      try {
        cutoff = cutoffIso(options.now?.() ?? new Date(), days)
        const rows = await options.query(STORAGE_SNAPSHOTS_SQL, [cutoff])
        const categories: Record<string, Array<{
          taken_at: string
          object_count: number | bigint
          total_bytes: number | bigint
        }>> = {}
        for (const row of rows) {
          if (typeof row.category !== 'string') throw new Error('invalid category')
          ;(categories[row.category] ??= []).push({
            taken_at: isoUtc(row.taken_at),
            object_count: integerValue(row.object_count),
            total_bytes: integerValue(row.total_bytes),
          })
        }
        let disk: StorageDiskUsage | null
        try { disk = await options.diskUsage() } catch { disk = null }
        return reply.type('application/json').send(jsonWithBigInt({ categories, disk }))
      } catch {
        throw safeFailure()
      }
    },
  )
}
