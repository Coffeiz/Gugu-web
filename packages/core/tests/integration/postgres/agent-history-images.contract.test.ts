import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { expect, it } from 'vitest'
import { createSqlPostgresHistoryImages } from '../../../src/agent/context/history/images-postgres.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('必须提供隔离的 PG 测试地址')
it('历史图片两阶段读取按 owner 与用户消息限制，膨胀时不传输载荷', async () => {
  const schema = `gugu_history_images_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,provider_image_content json)`)
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1),(2,$2)', [owner, other])
    const content = [{ type: 'text', text: '合成' }, { type: 'image', source: { type: 'base64', data: 'synthetic' } }]
    await pool.query(`INSERT INTO conversation_messages VALUES (1,1,'user',$1),(2,2,'user',$1),(3,1,'assistant',$1),(4,1,'user',NULL),(5,1,'user','null'),(6,1,'user','{"type":"image"}')`, [JSON.stringify(content)])
    const read = createSqlPostgresHistoryImages(db), identity = { ownerId: owner, sessionId: '1' }
    const sizes = await read.readSizes(identity, ['1','2','3','4','5','6','7'])
    expect([...sizes.keys()].sort()).toEqual(['1','5','6'])
    expect(sizes.get('1')).toBe(Buffer.byteLength(JSON.stringify(content)))
    const data = await read.readPayloads(identity, ['1','2','3','4','5','6','7'])
    expect([...data.entries()]).toEqual([['1', content]])
    expect((await read.readPayloads({ ownerId: other, sessionId: '1' }, ['1'])).size).toBe(0)
    const signal = new AbortController(); signal.abort(new Error('合成取消'))
    await expect(read.readSizes(identity, ['1'], signal.signal)).rejects.toThrow('合成取消')
    await pool.query("UPDATE conversation_messages SET provider_image_content=json_build_array(json_build_object('type','image','data',repeat('x', $1))) WHERE id=1", [8 * 1024 * 1024])
    let observed: readonly Record<string, unknown>[] = []
    const checked = createSqlPostgresHistoryImages(db.withPlugin({ transformQuery(args) { return args.node }, async transformResult(args) { observed = args.result.rows as readonly Record<string, unknown>[]; return args.result } }))
    await expect(checked.readPayloads(identity, ['1'])).rejects.toMatchObject({ code: 'storage_error', message: '历史图片快照超过读取上限' })
    expect(observed).toHaveLength(1)
    expect(observed[0]?.oversized).toBe(true)
    expect(observed[0]?.payload).toBeNull()
  } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
