import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
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
function removeAgentV6(db: SQLite.Database): void {
  db.exec('DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; DROP TABLE calendar_events; DROP TABLE rag_index_jobs; DROP TABLE mind_maps; DROP TABLE conversation_pending_queues; DROP TABLE conversation_messages; DROP TABLE conversation_batches; DROP TABLE conversation_sessions; DROP TRIGGER protect_core_owner_update; DROP TRIGGER protect_core_owner_delete; DROP INDEX uq_core_runtime_meta_key_value')
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
  it('版本 16 升级为正式 RAG 索引表并保留可恢复备份', async () => {
    const path = file()
    await initializeSqlite(path)
    const before = new SQLite(path)
    before.exec("DROP TABLE knowledge_index_entries; UPDATE core_runtime_meta SET value='16' WHERE key='schema_version'")
    before.close()

    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    try {
      expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('16')
      expect(saved.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_index_entries'").get()).toBeUndefined()
    } finally { saved.close() }

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
  it('旧库显式升级先备份；DDL 故障保留旧版本和数据，恢复后可重试', async () => {
    const path = file()
    await initializeSqlite(path)
    const db = new SQLite(path)
    removeAgentV6(db)
    db.exec(
      "DROP TABLE mind_nodes; DROP TABLE undo_operations; DROP TABLE core_operation_receipts; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='2' WHERE key='schema_version'",
    )
    db.close()
    await expect(openSqliteRuntime(path)).rejects.toMatchObject({
      code: 'schema_upgrade_required',
    })
    const originalExec = SQLite.prototype.exec
    vi.spyOn(SQLite.prototype, 'exec').mockImplementation(function (
      this: SQLite.Database,
      source: string,
    ) {
      if (source.startsWith('CREATE TABLE core_operation_receipts'))
        throw new Error('合成 DDL 故障')
      return originalExec.call(this, source)
    })
    await expect(migrateSqlite(path)).rejects.toThrow('合成 DDL 故障')
    vi.restoreAllMocks()
    const old = new SQLite(path)
    expect(
      old
        .prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'")
        .pluck()
        .get(),
    ).toBe('2')
    expect(
      old
        .prepare("SELECT name FROM sqlite_master WHERE name='core_operation_receipts'")
        .get(),
    ).toBeUndefined()
    old.close()
    expect(
      readdirSync(join(path, '..')).filter((name) => name.includes('.backup-')),
    ).toHaveLength(1)
    const backup = await migrateSqlite(path)
    const checked = new SQLite(backup, { readonly: true })
    expect(checked.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(
      checked
        .prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'")
        .pluck()
        .get(),
    ).toBe('2')
    checked.close()
    const current = await openSqliteRuntime(path)
    await current.runtime.close()
  })
  it('版本 3 显式升级前备份并保留项目、操作收据及 owner', async () => {
    const path = file()
    await initializeSqlite(path)
    const initial = await openSqliteRuntime(path)
    const owner = initial.ownerId, operationId = randomUUID()
    await initial.runtime.operation(dataContext(owner), operationId, 'project.create', {},
      data => data.projects.create({ name: '升级前项目' }))
    await initial.runtime.close()
    const legacy = new SQLite(path)
    removeAgentV6(legacy)
    legacy.exec("DROP TABLE mind_nodes; DROP TABLE undo_operations; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='3' WHERE key='schema_version'")
    legacy.close()
    await expect(openSqliteRuntime(path)).rejects.toMatchObject({ code: 'schema_upgrade_required' })
    const backup = await migrateSqlite(path)
    const backupDb = new SQLite(backup, { readonly: true })
    expect(backupDb.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('3')
    expect(backupDb.prepare('SELECT count(*) FROM projects').pluck().get()).toBe(1)
    expect(backupDb.prepare('SELECT count(*) FROM core_operation_receipts').pluck().get()).toBe(1)
    backupDb.close()
    const current = await openSqliteRuntime(path)
    try {
      expect(current.schemaVersion).toBe('18')
      expect(current.ownerId).toBe(owner)
      expect(await current.runtime.transaction(dataContext(owner), data => data.projects.list())).toHaveLength(1)
      expect(await current.runtime.receipt(dataContext(owner), operationId)).not.toBeNull()
    } finally { await current.runtime.close() }
  })
  it('版本 4 升级保留撤销记录并创建具有引用约束的 Mind 表', async () => {
    const path = file()
    await initializeSqlite(path)
    const legacy = new SQLite(path)
    removeAgentV6(legacy)
    legacy.exec("DROP TABLE mind_nodes; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='4' WHERE key='schema_version'")
    legacy.prepare("INSERT INTO undo_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      'op-test', 'owner', 'context', 'group', 'projects', 'create', '[]', '{}', '{}', '{}', '{}', 'web', 'active', '2026-01-01', null, null, null,
    )
    legacy.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT count(*) FROM undo_operations').pluck().get()).toBe(1)
    expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('4')
    saved.close()
    const current = await openSqliteRuntime(path)
    await current.runtime.close()
    const db = new SQLite(path)
    expect(db.prepare('SELECT count(*) FROM undo_operations').pluck().get()).toBe(1)
    expect(() => db.prepare("INSERT INTO mind_nodes (user_id,kind,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES ('owner','ref','','','user',1,'2026','2026','2026')").run()).toThrow()
    db.close()
  })
  it('版本 4 创建 Mind 表失败时保留旧库和可恢复备份', async () => {
    const path = file()
    await initializeSqlite(path)
    const legacy = new SQLite(path)
    removeAgentV6(legacy)
    legacy.exec("DROP TABLE mind_nodes; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='4' WHERE key='schema_version'")
    legacy.close()
    const originalExec = SQLite.prototype.exec
    vi.spyOn(SQLite.prototype, 'exec').mockImplementation(function (this: SQLite.Database, source: string) {
      if (source.startsWith('CREATE TABLE mind_nodes')) throw new Error('合成 Mind DDL 故障')
      return originalExec.call(this, source)
    })
    await expect(migrateSqlite(path)).rejects.toThrow('合成 Mind DDL 故障')
    vi.restoreAllMocks()
    const old = new SQLite(path, { readonly: true })
    expect(old.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('4')
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name='mind_nodes'").get()).toBeUndefined()
    expect(old.pragma('integrity_check', { simple: true })).toBe('ok')
    old.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
    await migrateSqlite(path)
    const opened = await openSqliteRuntime(path)
    await opened.runtime.close()
  })
  it('版本 6 升级保留对话并建立画布项目外键', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path); old.pragma('foreign_keys=ON')
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (?,'保留',0,'','web',1,'2026','2026')").run(owner)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; DROP TABLE calendar_events; DROP TABLE rag_index_jobs; DROP TABLE mind_maps; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='6' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT title FROM conversation_sessions').pluck().get()).toBe('保留')
    expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('6')
    saved.close()
    const current = new SQLite(path); current.pragma('foreign_keys=ON')
    expect(current.prepare('SELECT title FROM conversation_sessions').pluck().get()).toBe('保留')
    expect(() => current.prepare("INSERT INTO mind_maps(user_id,title,project_id,data_json,created_at,updated_at) VALUES (?,'画布',999,'{}','2026','2026')").run(owner)).toThrow()
    current.close()
    const opened = await openSqliteRuntime(path); await opened.runtime.close()
  })
  it('版本 6 画布表冲突时回滚升级并保留旧值与备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; DROP TABLE calendar_events; DROP TABLE rag_index_jobs; DROP TABLE mind_maps; CREATE TABLE mind_maps(old_value TEXT); INSERT INTO mind_maps VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='6' WHERE key='schema_version'")
    old.close()
    await expect(migrateSqlite(path)).rejects.toThrow()
    const current = new SQLite(path, { readonly: true })
    expect(current.prepare('SELECT old_value FROM mind_maps').pluck().get()).toBe('保留')
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('6')
    current.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
  })
  it('版本 7 升级保留画布和对话并建立日历与任务表', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path); old.pragma('foreign_keys=ON')
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO mind_maps(user_id,title,data_json,created_at,updated_at) VALUES (?,'保留画布','{}','2026','2026')").run(owner)
    old.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (?,'保留对话',0,'','web',1,'2026','2026')").run(owner)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; DROP TABLE calendar_events; DROP TABLE rag_index_jobs; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='7' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT title FROM mind_maps').pluck().get()).toBe('保留画布')
    expect(saved.prepare('SELECT title FROM conversation_sessions').pluck().get()).toBe('保留对话')
    saved.close()
    const opened = await openSqliteRuntime(path); await opened.runtime.close()
    const current = new SQLite(path); current.pragma('foreign_keys=ON')
    expect(current.prepare('SELECT title FROM mind_maps').pluck().get()).toBe('保留画布')
    expect(current.prepare('SELECT title FROM conversation_sessions').pluck().get()).toBe('保留对话')
    expect(() => current.prepare("INSERT INTO calendar_events(user_id,title,date,type,project_id,version,created_at) VALUES (?,'活动','2026-01-01','event',999,1,'2026')").run(owner)).toThrow()
    current.close()
  })
  it('版本 7 任务表冲突时回滚日历表创建并保留备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; DROP TABLE calendar_events; DROP TABLE rag_index_jobs; CREATE TABLE rag_index_jobs(old_value TEXT); INSERT INTO rag_index_jobs VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='7' WHERE key='schema_version'")
    old.close()
    await expect(migrateSqlite(path)).rejects.toThrow()
    const current = new SQLite(path, { readonly: true })
    expect(current.prepare('SELECT old_value FROM rag_index_jobs').pluck().get()).toBe('保留')
    expect(current.prepare("SELECT name FROM sqlite_master WHERE name='calendar_events'").get()).toBeUndefined()
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('7')
    current.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
  })
  it('版本 8 升级保留日历和画布并建立节点关联约束', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path); old.pragma('foreign_keys=ON')
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO mind_maps(user_id,title,data_json,created_at,updated_at) VALUES (?,'保留画布','{}','2026','2026')").run(owner)
    old.prepare("INSERT INTO calendar_events(user_id,title,date,type,version,created_at) VALUES (?,'保留活动','2026-01-01','event',1,'2026')").run(owner)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='8' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT title FROM calendar_events').pluck().get()).toBe('保留活动')
    saved.close()
    const opened = await openSqliteRuntime(path); await opened.runtime.close()
    const current = new SQLite(path); current.pragma('foreign_keys=ON')
    expect(current.prepare('SELECT title FROM mind_maps').pluck().get()).toBe('保留画布')
    expect(current.prepare('SELECT title FROM calendar_events').pluck().get()).toBe('保留活动')
    expect(() => current.prepare("INSERT INTO mind_canvas_items(user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at) VALUES (?,1,999,0,0,0,0,'{}','2026','2026')").run(owner)).toThrow()
    current.close()
  })
  it('版本 8 关系表冲突时回滚升级并保留旧数据', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE mind_relations; DROP TABLE mind_canvas_items; CREATE TABLE mind_relations(old_value TEXT); INSERT INTO mind_relations VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='8' WHERE key='schema_version'")
    old.close()
    await expect(migrateSqlite(path)).rejects.toThrow()
    const current = new SQLite(path, { readonly: true })
    expect(current.prepare('SELECT old_value FROM mind_relations').pluck().get()).toBe('保留')
    expect(current.prepare("SELECT name FROM sqlite_master WHERE name='mind_canvas_items'").get()).toBeUndefined()
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('8')
    current.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
  })
  it('画布全局关系唯一索引损坏时拒绝打开', async () => {
    const path = file(); await initializeSqlite(path)
    const db = new SQLite(path)
    db.exec('DROP INDEX uq_mind_relation_legacy; CREATE UNIQUE INDEX uq_mind_relation_legacy ON mind_relations(user_id,src_node_id,dst_node_id,rel_type,edge_key) WHERE canvas_id IS NOT NULL')
    db.close()
    await expect(openSqliteRuntime(path)).rejects.toMatchObject({ code: 'storage_error' })
  })
  it('版本 9 升级保留画布并建立提醒唯一约束和触发收据', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO mind_maps(user_id,title,data_json,created_at,updated_at) VALUES (?,'保留画布','{}','2026','2026')").run(owner)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='9' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT title FROM mind_maps').pluck().get()).toBe('保留画布'); saved.close()
    const opened = await openSqliteRuntime(path); await opened.runtime.close()
    const current = new SQLite(path)
    expect(current.prepare('SELECT title FROM mind_maps').pluck().get()).toBe('保留画布')
    const add = current.prepare("INSERT INTO scheduled_tasks(user_id,event_id,name,payload,cron,channels,enabled,created_at,updated_at) VALUES (?,?,'提醒','','cron','chat',1,'2026','2026')")
    add.run(owner, 1); expect(() => add.run(owner, 1)).toThrow()
    add.run(owner, null); add.run(owner, null)
    expect(() => current.prepare("UPDATE scheduled_tasks SET workspace_id=1").run()).toThrow()
    const fire = current.prepare("INSERT INTO scheduled_task_fires(task_id,fire_at,lease_owner,status) VALUES (1,'2026','owner','started')")
    fire.run(); expect(() => fire.run()).toThrow()
    current.close()
  })
  it('版本 9 触发收据表冲突时回滚任务表并保留备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE scheduled_task_fires; DROP TABLE scheduled_tasks; CREATE TABLE scheduled_task_fires(old_value TEXT); INSERT INTO scheduled_task_fires VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='9' WHERE key='schema_version'")
    old.close(); await expect(migrateSqlite(path)).rejects.toThrow()
    const current = new SQLite(path, { readonly: true })
    expect(current.prepare('SELECT old_value FROM scheduled_task_fires').pluck().get()).toBe('保留')
    expect(current.prepare("SELECT name FROM sqlite_master WHERE name='scheduled_tasks'").get()).toBeUndefined()
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('9')
    current.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
  })
  it('版本 10 升级保留任务和会话并建立通知及交互归属约束', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path); old.pragma('foreign_keys=ON')
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (?,'保留会话',0,'','web',1,'2026','2026')").run(owner)
    old.prepare("INSERT INTO scheduled_tasks(user_id,name,payload,cron,channels,enabled,created_at,updated_at) VALUES (?,'保留任务','','cron','chat',1,'2026','2026')").run(owner)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='10' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT name FROM scheduled_tasks').pluck().get()).toBe('保留任务'); saved.close()
    const opened = await openSqliteRuntime(path); await opened.runtime.close()
    const current = new SQLite(path); current.pragma('foreign_keys=ON')
    expect(current.prepare('SELECT title FROM conversation_sessions').pluck().get()).toBe('保留会话')
    expect(current.prepare('SELECT name FROM scheduled_tasks').pluck().get()).toBe('保留任务')
    const prompt = current.prepare("INSERT INTO interaction_prompts(user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES (?,1,'confirm','','','null','pending','2026','2026')")
    prompt.run(owner); expect(() => prompt.run('f'.repeat(32))).toThrow()
    current.prepare("INSERT INTO site_notifications(title,content,color,target,bubble,persist,created_by,created_at) VALUES ('通知','','','all',1,1,'admin','2026')").run()
    current.prepare("INSERT INTO notification_reads(user_id,notification_id,read_at) VALUES (?,1,'2026')").run(owner)
    current.exec('DELETE FROM site_notifications WHERE id=1; DELETE FROM conversation_sessions WHERE id=1')
    expect(current.prepare('SELECT count(*) FROM notification_reads').pluck().get()).toBe(0)
    expect(current.prepare('SELECT count(*) FROM interaction_prompts').pluck().get()).toBe(0)
    current.close()
  })
  it('版本 10 交互表冲突时回滚通知表并保留备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE interaction_prompts; DROP TABLE notification_dismissals; DROP TABLE notification_reads; DROP TABLE site_notifications; CREATE TABLE interaction_prompts(old_value TEXT); INSERT INTO interaction_prompts VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='10' WHERE key='schema_version'")
    old.close(); await expect(migrateSqlite(path)).rejects.toThrow()
    const current = new SQLite(path, { readonly: true })
    expect(current.prepare('SELECT old_value FROM interaction_prompts').pluck().get()).toBe('保留')
    expect(current.prepare("SELECT name FROM sqlite_master WHERE name='site_notifications'").get()).toBeUndefined()
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('10')
    current.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
  })
  it('版本 3 的 Undo 表创建失败时回滚升级并保留可恢复备份', async () => {
    const path = file()
    await initializeSqlite(path)
    const legacy = new SQLite(path)
    removeAgentV6(legacy)
    legacy.exec("DROP TABLE mind_nodes; DROP TABLE undo_operations; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='3' WHERE key='schema_version'")
    legacy.close()
    const originalExec = SQLite.prototype.exec
    vi.spyOn(SQLite.prototype, 'exec').mockImplementation(function (this: SQLite.Database, source: string) {
      if (source.startsWith('CREATE TABLE undo_operations')) throw new Error('合成 Undo DDL 故障')
      return originalExec.call(this, source)
    })
    await expect(migrateSqlite(path)).rejects.toThrow('合成 Undo DDL 故障')
    vi.restoreAllMocks()
    const db = new SQLite(path, { readonly: true })
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('3')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='undo_operations'").get()).toBeUndefined()
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    db.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
    await migrateSqlite(path)
    const opened = await openSqliteRuntime(path)
    await opened.runtime.close()
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
  it.each([1, 2, 3, 4, 5])('版本 %i 升级并保留 owner、项目和独立备份', async version => {
    const path = file()
    await initializeSqlite(path)
    const old = new SQLite(path)
    removeAgentV6(old)
    old.exec('DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state')
    if (version < 5) old.exec('DROP TABLE mind_nodes')
    if (version < 4) old.exec('DROP TABLE undo_operations')
    if (version < 3) old.exec('DROP TABLE core_operation_receipts')
    if (version < 2) old.exec('DROP TABLE clients')
    old.prepare("UPDATE core_runtime_meta SET value=? WHERE key='schema_version'").run(String(version))
    const rawOwner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).toUpperCase()
    old.prepare("UPDATE core_runtime_meta SET value=? WHERE key='owner_id'").run(rawOwner)
    old.prepare("INSERT INTO projects(user_id,name,status,color,progress,stages_json,version,archived,created_at,updated_at) VALUES (?,'保留','active','',0,'[]',1,0,'2026','2026')").run(rawOwner.replaceAll('-', '').toLowerCase())
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe(String(version))
    expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).toBe(rawOwner)
    expect(saved.prepare('SELECT name FROM projects').pluck().get()).toBe('保留')
    saved.close()
    const opened = await openSqliteRuntime(path)
    expect(opened.ownerId).toBe(rawOwner.toLowerCase())
    await opened.runtime.close()
    const current = new SQLite(path); current.pragma('foreign_keys=ON')
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).toBe(rawOwner)
    const ownerHex = rawOwner.replaceAll('-', '').toLowerCase()
    const insert = current.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,session_context,workspace_id,created_at,updated_at) VALUES (?,'对话',0,'',NULL,1,?,NULL,?,?)")
    insert.run(ownerHex, 'null', '2026-01-01 00:00:00.123456', '2026-01-01 00:00:00.123456')
    expect(() => insert.run('f'.repeat(32), null, '2026', '2026')).toThrow()
    expect(() => current.prepare("UPDATE conversation_sessions SET workspace_id=1").run()).toThrow()
    expect(current.prepare('SELECT source,session_context,created_at FROM conversation_sessions').get()).toEqual({ source: null, session_context: 'null', created_at: '2026-01-01 00:00:00.123456' })
    expect(() => current.prepare("UPDATE core_runtime_meta SET value='other' WHERE key='owner_id'").run()).toThrow()
    current.close()
  })
  it('v5 表名冲突升级回滚且保留备份和旧内容', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path); removeAgentV6(old)
    old.exec("DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='5' WHERE key='schema_version'; CREATE TABLE conversation_messages(old_value TEXT); INSERT INTO conversation_messages VALUES ('旧值')")
    old.close()
    await expect(migrateSqlite(path)).rejects.toThrow()
    const db = new SQLite(path, { readonly: true })
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('5')
    expect(db.prepare('SELECT old_value FROM conversation_messages').pluck().get()).toBe('旧值')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_sessions'").get()).toBeUndefined()
    db.close()
    const backups = readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))
    expect(backups).toHaveLength(1)
    const copy = new SQLite(join(path, '..', backups[0]!), { readonly: true })
    expect(copy.prepare('SELECT old_value FROM conversation_messages').pluck().get()).toBe('旧值')
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok'); copy.close()
  })

  it('v6 外键、身份与结构校验拒绝损坏并保护空值', async () => {
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

  it.each(['core_operation_receipts', 'undo_operations', 'mind_nodes'])('v5 缺失 %s 时拒绝迁移且不修改旧库', async table => {
    const path = file(); await initializeSqlite(path)
    const db = new SQLite(path); removeAgentV6(db)
    db.exec(`DROP TABLE ${table}`)
    db.exec("DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='5' WHERE key='schema_version'")
    db.close()
    await expect(migrateSqlite(path)).rejects.toMatchObject({ code: 'storage_error' })
    const old = new SQLite(path, { readonly: true })
    expect(old.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('5')
    old.close()
  })

  it('版本 11 升级保留提示和通知，动作关联及备份真实可恢复', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path); old.pragma('foreign_keys=ON')
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO conversation_sessions(user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (?,'保留',0,'','web',1,'2026','2026')").run(owner)
    old.prepare("INSERT INTO interaction_prompts(user_id,session_id,kind,title,body,schema_json,status,expires_at,created_at) VALUES (?,1,'confirm','','','null','active','2026','2026')").run(owner)
    old.exec("INSERT INTO site_notifications(title,content,color,target,bubble,persist,created_by,created_at) VALUES ('保留通知','','','all',1,1,'admin','2026'); DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='11' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('11')
    expect(saved.prepare('SELECT schema_json FROM interaction_prompts').pluck().get()).toBe('null')
    expect(saved.prepare('SELECT title FROM site_notifications').pluck().get()).toBe('保留通知'); saved.close()
    const opened = await openSqliteRuntime(path); expect(opened.schemaVersion).toBe('18'); await opened.runtime.close()
    const db = new SQLite(path); db.pragma('foreign_keys=ON')
    expect(db.prepare('SELECT schema_json FROM interaction_prompts').pluck().get()).toBe('null')
    expect(db.prepare('SELECT title FROM site_notifications').pluck().get()).toBe('保留通知')
    const action = db.prepare("INSERT INTO interaction_actions(prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,created_at) VALUES (?,'digest','choice','yes','{}','pending','2026-01-01 00:00:00.123456','2026-01-01 00:00:00.123456')")
    expect(() => action.run(999)).toThrow(); action.run(1)
    expect(db.prepare('SELECT expires_at FROM interaction_actions').pluck().get()).toBe('2026-01-01 00:00:00.123456')
    db.exec('DELETE FROM conversation_sessions WHERE id=1')
    expect(db.prepare('SELECT count(*) FROM interaction_actions').pluck().get()).toBe(0)
    db.exec('DROP INDEX ix_interaction_actions_expires_at'); db.close()
    await expect(openSqliteRuntime(path)).rejects.toMatchObject({ code: 'storage_error' })
  })
  it('版本 11 交互动作表冲突不覆盖数据且保留可恢复备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; CREATE TABLE interaction_actions(old_value TEXT); INSERT INTO interaction_actions VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='11' WHERE key='schema_version'")
    old.close(); await expect(migrateSqlite(path)).rejects.toThrow()
    const db = new SQLite(path, { readonly: true })
    expect(db.prepare('SELECT old_value FROM interaction_actions').pluck().get()).toBe('保留')
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('11'); db.close()
    const backups = readdirSync(join(path, '..')).filter(name => name.includes('.backup-')); expect(backups).toHaveLength(1)
    const backup = new SQLite(join(path, '..', backups[0]!), { readonly: true })
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(backup.prepare('SELECT old_value FROM interaction_actions').pluck().get()).toBe('保留'); backup.close()
  })
  it.each(['site_notifications','interaction_prompts'])('版本 11 缺失 %s 时不允许升级', async table => {
    const path = file(); await initializeSqlite(path)
    const db = new SQLite(path)
    db.exec(`DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE ${table}; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='11' WHERE key='schema_version'`); db.close()
    await expect(migrateSqlite(path)).rejects.toMatchObject({ code: 'storage_error' })
  })

  it('版本 11 动作表建成后发生故障会回滚且保留备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; DROP TABLE interaction_actions; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='11' WHERE key='schema_version'"); old.close()
    const original = SQLite.prototype.exec
    vi.spyOn(SQLite.prototype, 'exec').mockImplementation(function (this: SQLite.Database, source: string) {
      if (source.includes('CREATE TABLE interaction_actions')) { original.call(this, source); throw new Error('合成建表后故障') }
      return original.call(this, source)
    })
    try { await expect(migrateSqlite(path)).rejects.toThrow('合成建表后故障') } finally { vi.restoreAllMocks() }
    const db = new SQLite(path, { readonly: true })
    expect(db.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('11')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='interaction_actions'").get()).toBeUndefined(); db.close()
    const backups = readdirSync(join(path, '..')).filter(name => name.includes('.backup-')); expect(backups).toHaveLength(1)
    const saved = new SQLite(join(path, '..', backups[0]!), { readonly: true })
    expect(saved.pragma('integrity_check', { simple: true })).toBe('ok'); saved.close()
  })

  it('版本 12 升级保留通知与任务并限制 SMTP 记录归属', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    const owner = String(old.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").pluck().get()).replaceAll('-', '')
    old.prepare("INSERT INTO scheduled_tasks(user_id,name,payload,cron,channels,enabled,created_at,updated_at) VALUES (?,'保留任务','','cron','chat',1,'2026','2026')").run(owner)
    old.exec("INSERT INTO site_notifications(title,content,color,target,bubble,persist,created_by,created_at) VALUES ('保留通知','','','all',1,1,'admin','2026'); DROP TABLE user_smtp_configs; DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='12' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare('SELECT name FROM scheduled_tasks').pluck().get()).toBe('保留任务')
    expect(saved.prepare('SELECT title FROM site_notifications').pluck().get()).toBe('保留通知'); saved.close()
    const opened = await openSqliteRuntime(path); expect(opened.schemaVersion).toBe('18'); await opened.runtime.close()
    const current = new SQLite(path)
    expect(current.prepare('SELECT name FROM scheduled_tasks').pluck().get()).toBe('保留任务')
    const insert = current.prepare('INSERT INTO user_smtp_configs(user_id,host,port,"user",password,from_addr,use_ssl,enabled,updated_at) VALUES (?,\'example.invalid\',587,\'\',\'\',\'\',0,1,\'2026\')')
    insert.run(owner); expect(() => insert.run('f'.repeat(32))).toThrow()
    current.close()
  })
  it('版本 12 SMTP 表冲突时回滚并保留可恢复备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TABLE user_smtp_configs; CREATE TABLE user_smtp_configs(old_value TEXT); INSERT INTO user_smtp_configs VALUES ('保留'); DROP TABLE user_preferences; DROP TABLE feedbacks; DROP TABLE onboarding_state; UPDATE core_runtime_meta SET value='12' WHERE key='schema_version'")
    old.close(); await expect(migrateSqlite(path)).rejects.toThrow()
    const current = new SQLite(path, { readonly: true })
    expect(current.prepare('SELECT old_value FROM user_smtp_configs').pluck().get()).toBe('保留')
    expect(current.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('12'); current.close()
    expect(readdirSync(join(path, '..')).filter(name => name.includes('.backup-'))).toHaveLength(1)
  })

  it('版本 17 升级新增 MCP 配置表、owner 触发器并保留可恢复备份', async () => {
    const path = file(); await initializeSqlite(path)
    const old = new SQLite(path)
    old.exec("DROP TRIGGER validate_user_mcp_servers_owner_insert; DROP TRIGGER validate_user_mcp_servers_owner_update; DROP TRIGGER validate_user_mcp_tool_schema_snapshots_owner_insert; DROP TRIGGER validate_user_mcp_tool_schema_snapshots_owner_update; DROP INDEX ix_user_mcp_servers_user_id; DROP TABLE user_mcp_tool_schema_snapshots; DROP TABLE user_mcp_servers; UPDATE core_runtime_meta SET value='17' WHERE key='schema_version'")
    old.close()
    const backup = await migrateSqlite(path)
    const saved = new SQLite(backup, { readonly: true })
    expect(saved.prepare("SELECT value FROM core_runtime_meta WHERE key='schema_version'").pluck().get()).toBe('17')
    expect(saved.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_mcp_servers'").get()).toBeUndefined()
    expect(saved.pragma('integrity_check', { simple: true })).toBe('ok'); saved.close()
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
