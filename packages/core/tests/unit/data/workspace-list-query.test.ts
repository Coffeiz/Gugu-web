import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { createKyselyWorkspaceListReader } from '../../../src/workspaces/workspace-list-store.js'
import type { WorkspaceListTables } from '../../../src/workspaces/workspace-list-store.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createWorkspaceLister } from '../../../src/workspaces/workspace-list.js'
import type { WorkspaceListReadPort, WorkspaceListRuntimeSettings } from '../../../src/workspaces/workspace-list.js'

// 真实Kysely读适配器与临时SQLite合成表；不代表正式Core SQLite schema迁移或Host接线。
let directory: string, db: SQLite.Database, sqlDb: Kysely<WorkspaceListTables>
let owner: string, other: string, sqlCalls: number
let settings: WorkspaceListRuntimeSettings
let store: WorkspaceListReadPort, readSettings: Mock<() => WorkspaceListRuntimeSettings>
function preference(value: string, user = owner) {
  db.prepare('INSERT OR REPLACE INTO user_preferences(user_id,data_json) VALUES (?,?)').run(user.replaceAll('-', ''), value)
}
function workspace(id: number, user = owner, enabled = true, updated = '2026-01-01') {
  db.prepare('INSERT INTO workspaces(id,user_id,name,kind,enabled,is_default,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, user.replaceAll('-', ''), '工作区' + id, 'directory', Number(enabled), 0, updated)
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gugu-workspace-query-'))
  db = new SQLite(join(directory, 'query.db'))
  db.exec('CREATE TABLE user_preferences(user_id TEXT PRIMARY KEY,data_json TEXT);'
    + 'CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,project_id INTEGER,directory_id INTEGER,enabled INTEGER,is_default INTEGER,updated_at TEXT);'
    + 'CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY,user_id TEXT,workspace_id INTEGER);')
  owner = randomUUID(); other = randomUUID(); sqlCalls = 0
  settings = { shellEnabled: true, shellSystemEnabled: true, shellDangerousEnabled: true,
    automaticModeEnabled: false, sandboxReady: true, fullUserSandboxAuthorizationEnabled: true, terminalMode: 'auto' }
  readSettings = vi.fn(() => ({ ...settings }))
  sqlDb = new Kysely<WorkspaceListTables>({
    dialect: new SqliteDialect({ database: db }),
    log(event) { if (event.level === 'query' || event.level === 'error') sqlCalls++ },
  })
  store = createKyselyWorkspaceListReader(sqlDb, 'sqlite')
})
afterEach(async () => { await sqlDb?.destroy(); if (db?.open) db.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

describe('工作区公共列表用例与真实Kysely/临时SQLite读适配器', () => {
  it('owner列表和计数隔离，其他owner错误关联会话不能污染计数', async () => {
    workspace(1); workspace(2, other)
    preference('{"shell_enabled":false}', other)
    db.prepare('INSERT INTO conversation_sessions(id,user_id,workspace_id) VALUES (?,?,?)').run(1, owner.replaceAll('-', ''), 1)
    db.prepare('INSERT INTO conversation_sessions(id,user_id,workspace_id) VALUES (?,?,?)').run(2, other.replaceAll('-', ''), 1)
    db.prepare('INSERT INTO conversation_sessions(id,user_id,workspace_id) VALUES (?,?,?)').run(3, other.replaceAll('-', ''), 2)
    const list = createWorkspaceLister(store, { readRuntimeSettings: readSettings })
    expect(await list(owner)).toMatchObject({ userEnabled: true, items: [{ id: 1, boundSessionCount: 1 }] })
    expect(await list(other)).toMatchObject({ userEnabled: false, items: [{ id: 2, boundSessionCount: 1 }] })
  })
  it('包含停用项并按更新时间降序，空关联保持null而不是伪造ID', async () => {
    workspace(1, owner, true, '2026-01-01')
    workspace(2, owner, false, '2026-01-03')
    const result = await createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner)
    expect(result.items).toEqual([
      { id: 2, name: '工作区2', kind: 'directory', projectId: null, directoryId: null, enabled: false, isDefault: false, boundSessionCount: 0 },
      { id: 1, name: '工作区1', kind: 'directory', projectId: null, directoryId: null, enabled: true, isDefault: false, boundSessionCount: 0 },
    ])
  })
  it.each(['{损坏JSON', '[]'])('损坏或非对象偏好%s使用历史默认', async payload => {
    preference(payload)
    expect(await createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner)).toMatchObject({
      userEnabled: true, userSystemEnabled: false, userDangerousEnabled: true, userAutomaticModeEnabled: false,
    })
  })
  it('Python空数组/对象以及空串和零为false', async () => {
    preference(JSON.stringify({ shell_enabled: [], shell_system_enabled: {}, shell_dangerous_enabled: '', automatic_mode_enabled: 0 }))
    expect(await createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner)).toMatchObject({
      userEnabled: false, userSystemEnabled: false, userDangerousEnabled: false, userAutomaticModeEnabled: false,
      terminalEntryEnabled: false, ptyEnabled: false,
    })
  })
  it('Python非空容器和非空字符串false为true，不按JS空容器真假或字符串语义猜测', async () => {
    preference(JSON.stringify({ shell_enabled: [''], shell_system_enabled: { enabled: false }, shell_dangerous_enabled: 'false', automatic_mode_enabled: -1 }))
    expect(await createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner)).toMatchObject({
      userEnabled: true, userSystemEnabled: true, userDangerousEnabled: true, userAutomaticModeEnabled: true,
    })
  })
  it.each([
    ['auto', true, true], ['pty_disabled', true, false], ['entry_disabled', false, false],
  ])('可信终端模式%s决定入口和PTY显示能力', async (mode, entry, pty) => {
    settings.terminalMode = mode as string
    expect(await createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner)).toMatchObject({
      terminalMode: mode, terminalEntryEnabled: entry, ptyEnabled: pty,
    })
  })
  it('Host未验收隔离时不伪造Shell ready；全局关闭也不能靠用户偏好开启', async () => {
    settings.sandboxReady = false
    preference('{"shell_enabled":true,"shell_system_enabled":true}')
    const list = createWorkspaceLister(store, { readRuntimeSettings: readSettings })
    expect(await list(owner)).toMatchObject({ globalEnabled: true, sandboxEnabled: false, terminalEntryEnabled: false, ptyEnabled: false })
    settings.sandboxReady = true; settings.shellEnabled = false
    expect(await list(owner)).toMatchObject({ globalEnabled: false, terminalEntryEnabled: false, ptyEnabled: false })
  })
  it('非法owner在任何SQL和runtime读取前拒绝', async () => {
    await expect(createWorkspaceLister(store, { readRuntimeSettings: readSettings })('invalid-owner')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(sqlCalls).toBe(0)
    expect(readSettings).not.toHaveBeenCalled()
  })
  it('真实数据库读取错误传播，不返回空列表或假成功', async () => {
    db.exec('DROP TABLE workspaces')
    await expect(createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner)).rejects.toThrow('no such table: workspaces')
    expect(sqlCalls).toBe(2)
  })
})


function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

describe('真实工作区列表读取的取消与结果排空', () => {
  it('预取消在任何runtime或SQL读取前传播原reason', async () => {
    const controller = new AbortController(), reason = new Error('合成预取消')
    controller.abort(reason)
    await expect(createWorkspaceLister(store, { readRuntimeSettings: readSettings })(owner, { signal: controller.signal })).rejects.toBe(reason)
    expect(readSettings).not.toHaveBeenCalled()
    expect(sqlCalls).toBe(0)
  })

  it('runtime设置等待期间取消不提前settle，释放后拒绝且不再查询SQL', async () => {
    const entered = barrier(), release = barrier(), controller = new AbortController()
    const reason = new Error('合成runtime取消')
    const runtime = { async readRuntimeSettings(signal?: AbortSignal) {
      expect(signal).toBe(controller.signal)
      entered.resolve()
      await release.promise
      return { ...settings }
    } }
    let settled = false
    const pending = createWorkspaceLister(store, runtime)(owner, { signal: controller.signal })
    const observed = pending.then(value => { settled = true; return { value, error: undefined } }, error => { settled = true; return { value: undefined, error } })
    await entered.promise
    try {
      controller.abort(reason)
      await nextTurn()
      expect(settled).toBe(false)
      expect(sqlCalls).toBe(0)
    } finally { release.resolve(); await observed }
    expect(await observed).toEqual({ value: undefined, error: reason })
    expect(sqlCalls).toBe(0)
  })

  it.each([['偏好', 1], ['工作区', 2], ['绑定计数', 3]])('%s真实SQL执行后取消等待结果处理排空，禁止读取后续阶段或交付最终结果', async (_stage, stage) => {
    workspace(1)
    const entered = barrier(), release = barrier(), controller = new AbortController()
    const reason = new Error('合成查询阶段取消')
    let resultCount = 0
    // 此Kysely版本先释放数据库连接，再执行transformResult；此屏障仅证明真实SQL已执行、
    // 查询API的结果处理仍在等待，不能把它描述为数据库锁或连接仍被占用。
    const delayed = sqlDb.withPlugin({
      transformQuery(args) { return args.node },
      async transformResult(args) {
        resultCount++
        if (resultCount === stage) { entered.resolve(); await release.promise }
        return args.result
      },
    })
    const reader = createKyselyWorkspaceListReader(delayed, 'sqlite')
    let settled = false
    const pending = createWorkspaceLister(reader, { readRuntimeSettings: readSettings })(owner, { signal: controller.signal })
    const observed = pending.then(value => { settled = true; return { value, error: undefined } }, error => { settled = true; return { value: undefined, error } })
    await entered.promise
    try {
      expect(sqlCalls).toBe(stage)
      controller.abort(reason)
      await nextTurn()
      expect(settled).toBe(false)
      expect(sqlCalls).toBe(stage)
    } finally { release.resolve(); await observed }
    expect(await observed).toEqual({ value: undefined, error: reason })
    expect(sqlCalls).toBe(stage)
    expect(resultCount).toBe(stage)
    // clone共享原driver，不能单独destroy；取消排空后原reader仍可正常借用连接。
    expect(await store.workspaces(owner)).toMatchObject([{ id: 1, name: '工作区1' }])
    expect(sqlCalls).toBe((stage as number) + 1)
  })
})
