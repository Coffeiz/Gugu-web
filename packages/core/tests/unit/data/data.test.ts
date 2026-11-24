import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import SQLite from 'better-sqlite3'
import { sql } from 'kysely'
import { dataContext } from '../../../src/contracts/index.js'
import {
  initializeSqlite,
  migrateSqlite,
  openSqliteRuntime,
} from '../../../src/data/sqlite.js'

const temporary: string[] = []
function file(): string {
  const folder = mkdtempSync(join(tmpdir(), 'gugu-core-data-'))
  temporary.push(folder)
  return join(folder, '项目 # 空间.db')
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const folder of temporary.splice(0))
    rmSync(folder, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
})

describe('共享 SQL 数据契约', () => {
  it('桌面旧任务的不可解析文件编号迁成空路径列表并删除编号列', async () => {
    const path = file()
    await initializeSqlite(path)
    const initial = await openSqliteRuntime(path)
    const owner = initial.ownerId.replaceAll('-', '')
    await initial.runtime.close()

    const legacy = new SQLite(path)
    legacy.exec('ALTER TABLE scheduled_tasks RENAME COLUMN email_attachment_file_paths TO email_attachment_file_ids')
    legacy.prepare(`INSERT INTO scheduled_tasks(user_id,name,payload,cron,channels,enabled,email_attachment_file_ids,created_at,updated_at)
      VALUES (?,'旧附件任务','{}','0 * * * *','desktop',1,'[17]','2026-11-24 00:00:00','2026-11-24 00:00:00')`).run(owner)
    legacy.close()

    const migrated = await openSqliteRuntime(path)
    await migrated.runtime.close()
    const current = new SQLite(path)
    try {
      const columns = current.pragma('table_info(scheduled_tasks)') as { name: string }[]
      expect(columns.some(column => column.name === 'email_attachment_file_ids')).toBe(false)
      expect(columns.some(column => column.name === 'email_attachment_file_paths')).toBe(true)
      expect(current.prepare('SELECT email_attachment_file_paths FROM scheduled_tasks WHERE name=?').pluck().get('旧附件任务')).toBe('[]')
    } finally { current.close() }
  })

  it('编号基线可读写正式 RAG 索引表', async () => {
    const path = file()
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    try {
      expect(opened.schemaVersion).toBe('18')
      const owner = opened.ownerId.replaceAll('-', '')
      await sql`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,document_version,chunk_index,chunk_count,title,summary,content,content_hash,metadata_json,indexed_at) VALUES(${owner},'conversation','m-1','owner','','web','','','conversation:m-1','session:1','1',0,1,'合成索引','','合成正文',${'a'.repeat(64)},'{}','2026-11-15 00:00:00.000000')`.execute(opened.runtime.db)
      const rows = await sql<{ source_type: string; content: string }>`SELECT source_type,content FROM knowledge_index_entries WHERE owner_user_id=${owner}`.execute(opened.runtime.db)
      expect(rows.rows).toEqual([{ source_type: 'conversation', content: '合成正文' }])
    } finally { await opened.runtime.close() }
  })
  it('部分唯一索引不能冒充覆盖全部操作收据的唯一约束', async () => {
    const path = file()
    await initializeSqlite(path)
    const db = new SQLite(path)
    db.exec(`ALTER TABLE core_operation_receipts RENAME TO old_receipts;
      CREATE TABLE core_operation_receipts AS SELECT * FROM old_receipts;
      DROP TABLE old_receipts;
      CREATE UNIQUE INDEX partial_receipts ON core_operation_receipts(owner_id,operation_id) WHERE method='never-used'`)
    db.close()
    const before = readFileSync(path)
    let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
    try {
      await expect(
        openSqliteRuntime(path).then((value) => {
          opened = value
          return value
        }),
      ).rejects.toMatchObject({ code: 'storage_error' })
    } finally {
      await opened?.runtime.close()
    }
    expect(readFileSync(path)).toEqual(before)
  })
  it('列相同但唯一约束丢失的损坏库拒绝写入且不自动修复', async () => {
    const path = file()
    await initializeSqlite(path)
    const db = new SQLite(path)
    db.exec(
      'ALTER TABLE projects RENAME TO broken_projects; CREATE TABLE projects AS SELECT * FROM broken_projects; DROP TABLE broken_projects',
    )
    db.close()
    const before = readFileSync(path)
    await expect(openSqliteRuntime(path)).rejects.toThrow('唯一约束缺失')
    expect(readFileSync(path)).toEqual(before)
  })
  it('跨项目/联系人一起提交，后续异常和取消回滚先前写入', async () => {
    const path = file()
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const context = dataContext(ownerId),
      controller = new AbortController()
    try {
      await runtime.transaction(context, async (data) => {
        await data.projects.create({ name: '联合计划' })
        await data.clients.create({ name: '小北' })
      })
      await expect(
        runtime.transaction(context, async (data) => {
          await data.projects.create({ name: '不应留下' })
          await data.clients.create({ name: '' })
        }),
      ).rejects.toThrow()
      await expect(
        runtime.transaction(
          context,
          async (data) => {
            await data.projects.create({ name: '取消计划' })
            controller.abort()
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'cancelled' })
      await runtime.transaction(context, async (data) => {
        expect((await data.projects.list()).map((row) => row.name)).toEqual(['联合计划'])
        expect((await data.clients.list()).map((row) => row.name)).toEqual(['小北'])
      })
    } finally {
      await runtime.close()
    }
    await expect(
      runtime.transaction(context, async (data) => data.projects.list()),
    ).rejects.toMatchObject({ code: 'closed' })
  })
  it('所有者不能枚举或修改他人数据，CAS 只允许一个胜者，完成时间可恢复', async () => {
    const path = file()
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path, {
      clock: () => '2026-11-10T10:00:00.123456Z',
    })
    const owner = dataContext(ownerId),
      other = dataContext(randomUUID())
    try {
      const project = await runtime.transaction(owner, (data) =>
        data.projects.create({ name: '初始计划', client: '小北' }),
      )
      expect(await runtime.transaction(owner, (data) => data.projects.get(project.id))).toMatchObject({
        id: project.id,
        name: '初始计划',
      })
      await runtime.transaction(other, async (data) => {
        expect(await data.projects.list()).toEqual([])
        expect(await data.projects.get(project.id)).toBeNull()
        await expect(
          data.projects.update(project.id, 1, { name: '越权' }),
        ).rejects.toMatchObject({
          code: 'not_found',
        })
      })
      const results = await Promise.allSettled(
        ['先写', '后写'].map((name) =>
          runtime.transaction(owner, (data) =>
            data.projects.update(project.id, 1, { name, status: 'done' }),
          ),
        ),
      )
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const same = await runtime.transaction(owner, (data) =>
        data.projects.update(project.id, 2, { status: 'done' }),
      )
      expect(same.client).toBe('小北')
      expect(same.done_at).toBe('2026-11-10 10:00:00.123456+00:00')
      expect(
        (
          await runtime.transaction(owner, (data) =>
            data.projects.update(project.id, 3, { status: 'active' }),
          )
        ).done_at,
      ).toBeNull()
    } finally {
      await runtime.close()
    }
  })
  it('回收站列表含 cutoff 边界且仅列出当前所有者的近期 tombstone', async () => {
    const path = file()
    await initializeSqlite(path)
    const initial = await openSqliteRuntime(path, {
      clock: () => '2026-11-10T10:00:00.000Z',
    })
    const owner = dataContext(initial.ownerId)
    const other = dataContext(randomUUID())
    let recentId = 0
    let expiredId = 0
    let otherId = 0
    try {
      recentId = (await initial.runtime.transaction(owner, (data) =>
        data.projects.create({ name: '保留边界内项目' }),
      )).id
      expiredId = (await initial.runtime.transaction(owner, (data) =>
        data.projects.create({ name: '过期项目' }),
      )).id
      otherId = (await initial.runtime.transaction(other, (data) =>
        data.projects.create({ name: '其他用户项目' }),
      )).id
    } finally {
      await initial.runtime.close()
    }
    const database = new SQLite(path)
    const setDeletedAt = database.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?')
    setDeletedAt.run('2026-10-11 10:00:00.000000', recentId)
    setDeletedAt.run('2026-10-10 10:00:00.000000', expiredId)
    setDeletedAt.run('2026-10-11 10:00:00.000000', otherId)
    database.close()
    const reopened = await openSqliteRuntime(path)
    try {
      const deleted = await reopened.runtime.transaction(owner, (data) =>
        data.projects.listDeleted('2026-10-11T10:00:00.000Z'),
      )
      expect(deleted.map((project) => project.id)).toEqual([recentId])
      expect(await reopened.runtime.transaction(owner, (data) => data.projects.list())).toEqual([])
    } finally {
      await reopened.runtime.close()
    }
  })
  it('收据与写入同事务，重试不重复创建，跨用户不可读且不同内容冲突', async () => {
    const path = file()
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path),
      context = dataContext(ownerId),
      operationId = randomUUID()
    try {
      const create = () =>
        runtime.operation(
          context,
          operationId,
          'projects.create',
          { name: '一次创建' },
          (data) => data.projects.create({ name: '一次创建' }),
        )
      expect(await create()).toEqual(await create())
      await expect(
        runtime.operation(
          context,
          operationId,
          'projects.create',
          { name: '不同内容' },
          (data) => data.projects.create({ name: '不同内容' }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await runtime.receipt(dataContext(randomUUID()), operationId)).toBeNull()
      const failedId = randomUUID()
      await expect(
        runtime.operation(context, failedId, 'batch', {}, async (data) => {
          await data.projects.create({ name: '不完整操作' })
          throw new Error('合成事务故障')
        }),
      ).rejects.toThrow()
      expect(await runtime.receipt(context, failedId)).toBeNull()
      expect(
        await runtime.transaction(context, (data) => data.projects.list()),
      ).toHaveLength(1)
    } finally {
      await runtime.close()
    }
  })
  it('画布全局关系唯一索引损坏时拒绝打开', async () => {
    const path = file(); await initializeSqlite(path)
    const db = new SQLite(path)
    db.exec('DROP INDEX uq_mind_relation_legacy; CREATE UNIQUE INDEX uq_mind_relation_legacy ON mind_relations(user_id,src_node_id,dst_node_id,rel_type,edge_key) WHERE canvas_id IS NOT NULL')
    db.close()
    await expect(openSqliteRuntime(path)).rejects.toMatchObject({ code: 'storage_error' })
  })
  it('初始化不覆盖，未知库不修复，身份及微秒重开不变', async () => {
    const path = file()
    writeFileSync(path, '合成用户资料')
    await expect(initializeSqlite(path)).rejects.toThrow('已存在')
    expect(readFileSync(path, 'utf8')).toBe('合成用户资料')
    const fresh = file()
    await initializeSqlite(fresh)
    const first = await openSqliteRuntime(fresh),
      owner = first.ownerId
    await first.runtime.close()
    const second = await openSqliteRuntime(fresh)
    expect(second.ownerId).toBe(owner)
    await second.runtime.close()
    const db = new SQLite(fresh)
    db.exec("UPDATE core_runtime_meta SET value='999' WHERE key='schema_version'")
    db.close()
    await expect(openSqliteRuntime(fresh)).rejects.toMatchObject({
      code: 'schema_upgrade_required',
    })
  })
  it('对话外键、身份与结构校验拒绝损坏并保护空值', async () => {
    const path = file(); await initializeSqlite(path)
    const db = new SQLite(path); db.pragma('foreign_keys=ON')
    const owner = String(db.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    const timestamp = '2026-01-01 00:00:00.123456'
    db.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (?,'',0,'',NULL,1,?,?)").run(owner,timestamp,timestamp)
    expect(() => db.prepare("INSERT INTO conversation_batches(session_id,version,digest,created_at) VALUES (2,'v1','d',?)").run(timestamp)).toThrow()
    db.prepare("INSERT INTO conversation_batches(session_id,version,digest,created_at) VALUES (1,'v1','d',?)").run(timestamp)
    db.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (?,'',0,'','web',1,?,?)").run(owner,timestamp,timestamp)
    expect(() => db.prepare("INSERT INTO conversation_messages(session_id,conversation_seq,role,content,canonical_batch_id,created_at) VALUES (2,1,'user','',1,?)").run(timestamp)).toThrow()

    expect(() => db.prepare("INSERT INTO conversation_batches(session_id,version,digest,created_at) VALUES (1,'v1','d',?)").run(timestamp)).toThrow()
    db.prepare("INSERT INTO conversation_messages(session_id,conversation_seq,role,content,content_json,canonical_batch_id,created_at) VALUES (1,1,'user','',NULL,1,?),(1,2,'user','','null',1,?)").run(timestamp,timestamp)
    expect(db.prepare('SELECT content_json FROM conversation_messages ORDER BY id').pluck().all()).toEqual([null,'null'])
    db.prepare("INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at) VALUES (2,1,'user','',?)").run(timestamp)
    expect(() => db.prepare("UPDATE conversation_messages SET canonical_batch_id=1 WHERE session_id=2").run()).toThrow()
    expect(() => db.prepare("UPDATE conversation_batches SET session_id=2 WHERE id=1").run()).toThrow()
    expect(() => db.prepare("UPDATE conversation_messages SET session_id=2 WHERE id=1").run()).toThrow()

    expect(() => db.prepare("INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at) VALUES (?,'q',1,'[]',?)").run('f'.repeat(32),timestamp)).toThrow()
    db.exec('DELETE FROM conversation_batches WHERE id=1')
    expect(db.prepare('SELECT canonical_batch_id FROM conversation_messages ORDER BY id').pluck().all()).toEqual([null,null,null])
    db.exec('DROP INDEX ix_conversation_messages_run_id'); db.close()
    await expect(openSqliteRuntime(path)).rejects.toMatchObject({ code: 'storage_error' })
  })

  it('编号基线只读检查、并发创建、重复应用并拒绝无台账格式', async () => {
    const path = file()
    expect(await migrateSqlite(path, 'check')).toBe('pending')
    expect(existsSync(path)).toBe(false)
    const results = await Promise.all([migrateSqlite(path, 'apply'), migrateSqlite(path, 'apply')])
    expect(results.sort()).toEqual(['applied', 'unchanged'])
    expect(await migrateSqlite(path, 'check')).toBe('applied')

    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      await runtime.transaction(dataContext(ownerId), data => data.projects.create({ name: '保留计划' }))
    } finally {
      await runtime.close()
    }
    expect(await migrateSqlite(path, 'apply')).toBe('unchanged')

    const db = new SQLite(path)
    expect(db.prepare('SELECT name FROM projects').pluck().all()).toEqual(['保留计划'])
    db.exec("DELETE FROM core_runtime_meta WHERE key='migration_revision'")
    db.close()
    const original = readFileSync(path)
    await expect(migrateSqlite(path, 'check')).rejects.toMatchObject({ code: 'schema_upgrade_required' })
    await expect(migrateSqlite(path, 'apply')).rejects.toMatchObject({ code: 'schema_upgrade_required' })
    expect(readFileSync(path)).toEqual(original)
  })

  it('编号基线为 MCP 快照限制 owner', async () => {
    const path = file()
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    expect(opened.schemaVersion).toBe('18')
    const db = new SQLite(path)
    expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'validate_user_mcp_%_owner_%'").pluck().get()).toBe(4)
    const owner = opened.ownerId.replaceAll('-', '')
    expect(() => db.prepare("INSERT INTO user_mcp_tool_schema_snapshots(user_id,config_digest,schemas,refreshed_at) VALUES (?,'digest','[]',CURRENT_TIMESTAMP)").run('f'.repeat(32))).toThrow()
    db.prepare("INSERT INTO user_mcp_tool_schema_snapshots(user_id,config_digest,schemas,refreshed_at) VALUES (?,'digest','[]',CURRENT_TIMESTAMP)").run(owner)
    db.close(); await opened.runtime.close()
  })
})
