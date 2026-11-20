import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createPostgresGlobalSearchSources } from '../../../src/search/postgres.js'
import { createSqliteConversationSearch } from '../../../src/search/sqlite-conversations.js'
import { createKyselySqliteGlobalSearchSources } from '../../../src/search/sqlite.js'
import { createGlobalSearchOperations } from '../../../src/search/global-search.js'
import { parseGlobalSearchQuery } from '../../../src/search/query.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
const stamp = (microsecond: number) => `2026-01-01 00:00:00.${String(microsecond).padStart(6, '0')}`

async function withDatabases(work: (context: {
  owner: string
  foreign: string
  pool: pg.Pool
  sqlite: SqlDataRuntime
  session(id: number, title: string, microsecond: number, user?: string): Promise<void>
  message(id: number, sessionId: number, role: string, content: string, microsecond: number): Promise<void>
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-search-conversation-parity-'))
  const schema = `gugu_conversation_parity_${randomUUID().replaceAll('-', '')}`
  let sqlite: SqlDataRuntime | undefined, pool: pg.Pool | undefined, admin: pg.Pool | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    sqlite = opened.runtime
    const owner = opened.ownerId, foreign = randomUUID()
    admin = new pg.Pool({ connectionString: url, max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC`, max: 2 })
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,title text NOT NULL,updated_at timestamptz NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL REFERENCES conversation_sessions(id),role text NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL);`)
    const sqliteSessionIds = new Set<number>()
    const session = async (id: number, title: string, microsecond: number, user = owner) => {
      const value = stamp(microsecond)
      await pool!.query('INSERT INTO conversation_sessions VALUES ($1,$2,$3,$4)', [id, user, title, value.replace(' ', 'T') + 'Z'])
      const insert = () => sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at)
        VALUES (${id},${user.replaceAll('-', '')},${title},0,'','web',1,${value},${value})`.execute(sqlite!.db)
      if (user !== owner) {
        // 正式SQLite只允许本地owner；证明异owner写入被原trigger拒绝，不绕过约束播种。
        await expect(insert()).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' })
      } else {
        await insert()
        sqliteSessionIds.add(id)
      }
    }
    const message = async (id: number, sessionId: number, role: string, content: string, microsecond: number) => {
      const value = stamp(microsecond)
      await pool!.query('INSERT INTO conversation_messages VALUES ($1,$2,$3,$4,$5)', [id, sessionId, role, content, value.replace(' ', 'T') + 'Z'])
      // PG可拥有其他owner会话；正式SQLite没有该被拒绝的会话，不能绕过FK补种消息。
      if (!sqliteSessionIds.has(sessionId)) return
      // 每条记录使用唯一sequence，正式SQLite唯一约束与FK均保持启用。
      await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,created_at)
        VALUES (${id},${sessionId},${id},${role},${content},${value})`.execute(sqlite!.db)
    }
    await work({ owner, foreign, pool, sqlite, session, message })
  } finally {
    try { await sqlite?.close() } finally {
      try { await pool?.end() } finally {
        try {
          if (admin) {
            if (!/^gugu_conversation_parity_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
          }
        } finally { await admin?.end(); await rm(directory, { recursive: true, force: true }) }
      }
    }
  }
}

// 此文件仅进入显式PG套件；缺少隔离连接时跳过，不连接默认或真实用户数据库。
describe.skipIf(!url)('独立conversation来源的真实PostgreSQL/正式临时SQLite对照', () => {
  it('等价子集保留多词、原生微秒排序、全role、title优先去重、前8条消息及owner隔离', async () => {
    await withDatabases(async ({ owner, foreign, pool, sqlite, session, message }) => {
      for (const [id, title, micros] of [[1, 'target', 1], [2, 'target', 2], [3, 'target扩展', 9], [4, '前target后', 8],
        [5, '正文甲', 5], [6, '正文乙', 6], [7, '正文丙', 7], [9, '微秒旧', 123000], [10, '微秒新', 123456],
        [11, '重复窗口会话', 11], [12, '窗口外会话', 12]] as const) await session(id, title, micros)
      await session(8, 'target 目标', 999999, foreign)
      await message(1, 1, 'user', 'target重复正文', 900000)
      await message(5, 5, 'user', '目标 alpha', 5)
      await message(6, 6, 'assistant', '目标 beta', 6)
      await message(7, 7, 'tool', '目标 alpha beta', 7)
      await message(8, 8, 'system', '目标 alpha beta', 999999)
      await message(9, 9, 'assistant', '微秒排序', 123000)
      await message(10, 10, 'tool', '微秒排序', 123456)
      await message(12, 12, 'user', '窗口探针', 100000)
      for (let n = 0; n < 8; n++) await message(100 + n, 11, ['user', 'assistant', 'tool', 'system'][n % 4]!, '窗口探针', 200000 + n)
      const postgres = createPostgresGlobalSearchSources(pool).find(source => source.type === 'conversation')!
      const local = createSqliteConversationSearch(sqlite.db)
      for (const input of [
        { q: 'target', per_type: '20' }, { q: 'target', per_type: '2' }, { q: '目标', per_type: '20' },
        { queries: ['目标', 'alpha'], mode: 'AND', per_type: '20' }, { queries: ['目标', 'beta'], mode: 'OR', per_type: '20' },
        { q: '微秒排序', per_type: '20' }, { q: '窗口探针', per_type: '20' },
      ]) {
        const query = parseGlobalSearchQuery({ ...input, types: 'conversation' })
        expect(await local.search(owner, query)).toEqual(await postgres.search(owner, query))
      }
      expect((await local.search(owner, parseGlobalSearchQuery({ q: 'target', per_type: '20' }))).map(row => row.id)).toEqual([2, 1, 3, 4])
      const roles = await local.search(owner, parseGlobalSearchQuery({ q: '目标', per_type: '20' }))
      expect(roles.map(row => row.id)).toEqual([7, 6, 5])
      expect(roles.every(row => 'message_id' in row)).toBe(true)
      expect((await local.search(owner, parseGlobalSearchQuery({ q: '微秒排序' }))).map(row => row.id)).toEqual([10, 9])
      expect((await local.search(owner, parseGlobalSearchQuery({ q: '窗口探针', per_type: '20' }))).map(row => row.id)).toEqual([11])
      const byForeign = parseGlobalSearchQuery({ q: '目标' })
      expect(await local.search(foreign, byForeign)).toEqual([])
      expect((await postgres.search(foreign, byForeign)).map(row => row.id)).toEqual([8])
    })
  })

  it('反斜线转义与PG一致，非ASCII仍保留数据库语言环境差异', async () => {
    await withDatabases(async ({ owner, pool, sqlite, session, message }) => {
      await session(1, 'a_b', 1); await session(2, 'a\\xb', 2)
      await session(3, 'Änne', 3); await session(4, 'ASCII', 4)
      await session(5, 'a%b', 5); await session(6, 'a\\b', 6); await session(7, 'a%zzz', 7)
      await session(8, '正文目标', 8); await message(1, 8, 'tool', 'a_b a%b a\\b', 9)
      await session(9, '结束a%', 9)
      const postgres = createPostgresGlobalSearchSources(pool).find(source => source.type === 'conversation')!
      const local = createSqliteConversationSearch(sqlite.db)
      const actual: Array<{ term: string; postgres: unknown[]; sqlite: unknown[] }> = []
      for (const term of ['a\\_b', 'a\\%b', 'a\\', 'a\\\\b', 'a_b', 'a%b', 'änne', 'ascii']) {
        const query = parseGlobalSearchQuery({ q: term, types: 'conversation', per_type: '20' })
        const nativePg = await pool.query<{ id: number }>('SELECT id FROM conversation_sessions WHERE user_id=$1 AND title ILIKE $2 ORDER BY updated_at DESC', [owner, '%' + term + '%'])
        const nativeSqlite = await sql<{ id: number }>`SELECT id FROM conversation_sessions WHERE user_id=${owner.replaceAll('-', '')}
          AND lower(title) LIKE lower(${'%' + term + '%'}) ESCAPE ${'\\'} ORDER BY updated_at DESC`.execute(sqlite.db)
        const pgRows = await postgres.search(owner, query), localRows = await local.search(owner, query)
        expect(pgRows.filter(row => !('message_id' in row)).map(row => row.id).sort()).toEqual(nativePg.rows.map(row => row.id).sort())
        expect(localRows.filter(row => !('message_id' in row)).map(row => row.id).sort()).toEqual(nativeSqlite.rows.map(row => row.id).sort())
        if (term !== 'änne') expect(localRows).toEqual(pgRows)
        actual.push({ term, postgres: pgRows.map(row => row.id), sqlite: localRows.map(row => row.id) })
      }
      // 仅合成查询与ID，无用户正文/凭据；输出供本轮验收记录当前PG collation结果。
      process.stdout.write('独立会话来源原生差异: ' + JSON.stringify(actual) + '\n')
    })
  })

  it('独立source对照不授予公共能力，SQLite显式conversation请求仍拒绝', async () => {
    await withDatabases(async ({ owner, pool, sqlite, session }) => {
      await session(1, '命中', 1)
      const query = parseGlobalSearchQuery({ q: '命中', types: 'conversation' })
      expect(await createSqliteConversationSearch(sqlite.db).search(owner, query)).toEqual(
        await createPostgresGlobalSearchSources(pool).find(source => source.type === 'conversation')!.search(owner, query))
      const postgresOperations = createGlobalSearchOperations(createPostgresGlobalSearchSources(pool))
      expect(postgresOperations.availableTypes).toHaveLength(9)
      expect(postgresOperations.missingTypes).toEqual(['file', 'folder'])
      const operations = createGlobalSearchOperations(createKyselySqliteGlobalSearchSources(sqlite.db))
      expect(operations.availableTypes).not.toContain('conversation')
      await expect(operations.search(owner, query)).rejects.toMatchObject({ code: 'conflict' })
    })
  })
})
