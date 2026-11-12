import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import SQLite from 'better-sqlite3'
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
    db.exec(
      "DROP TABLE core_operation_receipts; UPDATE core_runtime_meta SET value='2' WHERE key='schema_version'",
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
})
