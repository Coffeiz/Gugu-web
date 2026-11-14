import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import {
  createPostgresAdminStorageSnapshotQuery,
  diskUsageForStorage,
  registerAdminStorageSnapshotsRoute,
  STORAGE_SNAPSHOTS_SQL,
  type AdminStorageSnapshotRow,
} from '../../src/domains/admin/admin-storage-snapshots.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

function setup(now: () => Date | string = () => new Date('2026-11-13T12:00:00.000Z')) {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  let rows: AdminStorageSnapshotRow[] = []
  let queryError: Error | undefined
  let diskReads = 0
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminStorageSnapshotsRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未授权' })
    },
    query: async (sql, values) => {
      statements.push({ sql, values })
      if (queryError) throw queryError
      return rows
    },
    diskUsage: () => { diskReads++; return { total_bytes: 1000, used_bytes: 700, free_bytes: 250 } },
    now,
  })
  return {
    app,
    statements,
    set rows(value: AdminStorageSnapshotRow[]) { rows = value },
    set queryError(value: Error | undefined) { queryError = value },
    get diskReads() { return diskReads },
    close: () => app.close(),
  }
}

test('未授权的存储快照请求不读取数据库或磁盘', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/ops/storage-snapshots' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.statements.length, 0)
    assert.equal(ctx.diskReads, 0)
  } finally { await ctx.close() }
})

test('快照按 Python 默认 30 天窗口筛选、升序分组并格式化 UTC 时间', async () => {
  const ctx = setup()
  ctx.rows = [
    { category: 'video_cache', taken_at: '2026-11-13T11:00:00.123000', object_count: 2, total_bytes: '200' },
    { category: 'user_files', taken_at: '2026-11-13T10:00:00.000000', object_count: 5, total_bytes: '5000' },
    { category: 'video_cache', taken_at: '2026-11-13T12:00:00.000000', object_count: 3, total_bytes: '300' },
  ]
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/ops/storage-snapshots', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      categories: {
        video_cache: [
          { taken_at: '2026-11-13T11:00:00.123000Z', object_count: 2, total_bytes: 200 },
          { taken_at: '2026-11-13T12:00:00Z', object_count: 3, total_bytes: 300 },
        ],
        user_files: [{ taken_at: '2026-11-13T10:00:00Z', object_count: 5, total_bytes: 5000 }],
      },
      disk: { total_bytes: 1000, used_bytes: 700, free_bytes: 250 },
    })
    assert.equal(ctx.statements.length, 1)
    assert.equal(ctx.statements[0]!.values[0], '2026-10-14T12:00:00.000Z')
    assert.match(ctx.statements[0]!.sql, /ORDER BY taken_at ASC/)
    assert.equal(ctx.diskReads, 1)
  } finally { await ctx.close() }
})

test('days 接受 1 到 365，越界和非法整数在访问依赖前返回 422', async () => {
  const ctx = setup()
  try {
    const valid = await ctx.app.inject({
      url: '/api/v1/admin/ops/storage-snapshots?days=365',
      headers: { authorization: 'admin' },
    })
    assert.equal(valid.statusCode, 200)
    assert.equal(ctx.statements[0]!.values[0], '2025-11-13T12:00:00.000Z')

    for (const days of ['0', '366', '1.5', 'bad']) {
      const response = await ctx.app.inject({
        url: `/api/v1/admin/ops/storage-snapshots?days=${days}`,
        headers: { authorization: 'admin' },
      })
      assert.equal(response.statusCode, 422)
    }
    assert.equal(ctx.statements.length, 1)
    assert.equal(ctx.diskReads, 1)
  } finally { await ctx.close() }
})

test('数据库异常不回显底层内容', async () => {
  const ctx = setup()
  try {
    ctx.queryError = new Error('postgres://secret-host/private-db')
    const failed = await ctx.app.inject({ url: '/api/v1/admin/ops/storage-snapshots', headers: { authorization: 'admin' } })
    assert.equal(failed.statusCode, 500)
    assert.equal(failed.body.includes('secret-host'), false)
  } finally { await ctx.close() }
})

test('本地磁盘用 statvfs 口径报告总量、实际使用和调用者可用空间', () => {
  const path = mkdtempSync(join(tmpdir(), 'gugu-storage-snapshot-'))
  try {
    const actual = statfsSync(path, { bigint: true })
    const usage = diskUsageForStorage({ localPath: path })
    assert.deepEqual(usage, {
      total_bytes: actual.bsize * actual.blocks,
      used_bytes: (actual.blocks - actual.bfree) * actual.bsize,
      free_bytes: actual.bavail * actual.bsize,
    })
  } finally { rmSync(path, { recursive: true, force: true }) }
})

test('无效本地路径和磁盘查询异常按 Python 约定返回 null', async () => {
  assert.equal(diskUsageForStorage({ localPath: join(tmpdir(), `gugu-missing-${randomUUID()}`) }), null)
  const app = Fastify()
  try {
    installHttpErrorHandler(app)
    registerAdminStorageSnapshotsRoute(app, {
      requireAdmin: async () => {},
      query: async () => [],
      diskUsage: () => { throw new Error('private path') },
    })
    const response = await app.inject({ url: '/api/v1/admin/ops/storage-snapshots' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().disk, null)
  } finally { await app.close() }
})

test('窗口边界保留 Python datetime 的微秒精度，BIGINT 以精确 JSON 整数发送', async () => {
  const ctx = setup(() => '2026-11-13T12:00:00.123456Z')
  ctx.rows = [{
    category: 'archive', taken_at: '2026-11-13T12:00:00.123456',
    object_count: '9007199254740993', total_bytes: '9007199254740995',
  }]
  try {
    const response = await ctx.app.inject({
      url: '/api/v1/admin/ops/storage-snapshots?days=1',
      headers: { authorization: 'admin' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(ctx.statements[0]!.values[0], '2026-11-12T12:00:00.123456Z')
    assert.match(response.body, /"object_count":9007199254740993/)
    assert.match(response.body, /"total_bytes":9007199254740995/)
  } finally { await ctx.close() }
})

test('PostgreSQL 快照 adapter 查询指定时间窗并按时间升序返回', {
  skip: !databaseUrl && '需要 GUGU_WEBUI_TEST_DATABASE_URL 验收真实 SQL 行为',
}, async () => {
  const schema = `admin_storage_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const before = new Date('2026-11-12T00:00:00Z')
  try {
    await pool.query(`CREATE TABLE storage_category_snapshots (
      id bigserial PRIMARY KEY, category varchar(64) NOT NULL,
      taken_at timestamptz NOT NULL, object_count integer NOT NULL, total_bytes bigint NOT NULL
    )`)
    await pool.query(`INSERT INTO storage_category_snapshots (category,taken_at,object_count,total_bytes) VALUES
      ('video_cache','2026-11-13T12:00:00.123456Z',2,200),
      ('user_files','2026-11-12T12:00:00Z',5,5000),
      ('video_cache','2026-11-13T11:00:00Z',1,100)`)
    const query = createPostgresAdminStorageSnapshotQuery(pool)
    const rows = await query(STORAGE_SNAPSHOTS_SQL, [before.toISOString()])
    assert.deepEqual(rows.map(row => row.category), ['user_files', 'video_cache', 'video_cache'])
    assert.equal(rows[2]!.taken_at, '2026-11-13T12:00:00.123456')
    assert.equal(rows[2]!.total_bytes, '200')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
