import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { createProjectListing, createProjectGetter, createProjectFileCountListing } from '../../../src/projects/project-read.js'
import { createKyselyProjectFileCountReader } from '../../../src/projects/read-store.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

let folder: string, core: SqlDataRuntime, owner: string, other: string, countQueries: number
const now = Date.parse('2026-11-15T12:00:00Z')
function port() {
  return createKyselyProjectFileCountReader(core.db.withPlugin({ transformQuery(args) { countQueries++; return args.node }, async transformResult(args) { return args.result } }), 'sqlite')
}
async function projection() {
  // 正式SQLite schema目前没有此计数表；显式合成投影仅验证适配器原型，不能声称正式迁移完成。
  await sql`CREATE TABLE project_file_counts(project_id INTEGER PRIMARY KEY,file_count INTEGER NOT NULL)`.execute(core.db)
}
async function create(name: string, fields: Record<string, unknown> = {}, user = owner) {
  return core.transaction(dataContext(user), data => data.projects.create({ name, ...fields }))
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-project-read-'))
  const filename = join(folder, 'core.db')
  await initializeSqlite(filename)
  const opened = await openSqliteRuntime(filename, { clock: () => new Date(now).toISOString() })
  core = opened.runtime; owner = opened.ownerId; other = randomUUID(); countQueries = 0
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

describe('项目公共读取与真实正式SQLite项目仓储/显式计数投影原型', () => {
  it('正式schema缺计数投影时明确失败，不能假造0；空项目列表不访问投影', async () => {
    const counts = port(), list = createProjectListing(core, counts)
    expect(await list(owner)).toEqual([])
    expect(countQueries).toBe(0)
    const project = await create('原项目')
    await expect(list(owner)).rejects.toThrow()
    await expect(createProjectGetter(core, counts)(owner, project.id)).rejects.toThrow()
    await expect(createProjectFileCountListing(counts)(owner)).rejects.toThrow()
  })
  it('完整DTO含计数、未知阶段字段保留，owner和缺失/软删查询均隔离', async () => {
    await projection()
    const project = await create('完整项目', { summary: '摘要', priority: 'high', client: '小北', status: 'active',
      start_date: '2026-11-01', deadline: '2026-11-30', stages: [{ key: 's0', label: '设计', extra: '历史字段', todos: [] }], current_stage: 's0' })
    const foreign = await create('其他用户', {}, other)
    await sql`INSERT INTO project_file_counts VALUES(${project.id},5),(${foreign.id},9)`.execute(core.db)
    const get = createProjectGetter(core, port())
    expect(await get(owner.toUpperCase(), project.id)).toEqual({ id: project.id, name: '完整项目', client: '小北', status: 'active',
      startDate: '2026-11-01', deadline: '2026-11-30', color: project.color, progress: 0,
      stages: [{ key: 's0', label: '设计', extra: '历史字段', todos: [] }], currentStage: 's0', archived: false, priority: 'high',
      version: project.version, doneAt: null, updatedAt: '2026-11-15T12:00:00+00:00', deletedAt: null, createdAt: '2026-11-15', fileCount: 5 })
    expect(await get(other, project.id)).toBeNull()
    expect(await get(owner, foreign.id)).toBeNull()
    expect(await get(owner, 999)).toBeNull()
    await sql`UPDATE projects SET deleted_at='2026-11-14 00:00:00' WHERE id=${project.id}`.execute(core.db)
    expect(await get(owner, project.id)).toBeNull()
  })
  it('列表区分active/archive与30日回收站，计数全列表仍含归档/软删并按id排序', async () => {
    await projection()
    const active = await create('存活'), archived = await create('归档', { archived: true })
    const recent = await create('29天删除'), expired = await create('31天删除')
    const foreign = await create('他人项目', {}, other)
    await sql`UPDATE projects SET deleted_at=${new Date(now - 29 * 86400000).toISOString()} WHERE id=${recent.id}`.execute(core.db)
    await sql`UPDATE projects SET deleted_at=${new Date(now - 31 * 86400000).toISOString()} WHERE id=${expired.id}`.execute(core.db)
    await sql`INSERT INTO project_file_counts VALUES(${active.id},4),(${foreign.id},11)`.execute(core.db)
    const counts = port(), list = createProjectListing(core, counts, () => now)
    expect((await list(owner)).map(row => row.id)).toEqual([active.id])
    expect((await list(owner, true)).map(row => row.id)).toEqual([archived.id])
    expect((await list(owner, false, true)).map(row => row.id)).toEqual([recent.id])
    expect(await counts.forProjects(owner, [active.id, archived.id, foreign.id])).toEqual(new Map([[active.id, 4]]))
    expect(await createProjectFileCountListing(counts)(owner)).toEqual([
      { projectId: active.id, fileCount: 4 }, { projectId: archived.id, fileCount: 0 },
      { projectId: recent.id, fileCount: 0 }, { projectId: expired.id, fileCount: 0 },
    ])
    expect(await counts.list(other)).toEqual([{ projectId: foreign.id, fileCount: 11 }])
  })
  it('坏阶段JSON回空数组，合法非列表或非字典元素明确失败', async () => {
    await projection()
    const project = await create('历史阶段')
    const get = createProjectGetter(core, port())
    await sql`UPDATE projects SET stages_json='{' WHERE id=${project.id}`.execute(core.db)
    expect(await get(owner, project.id)).toMatchObject({ stages: [], fileCount: 0 })
    for (const stages of ['{}', 'null', '[1]', '[[]]']) {
      await sql`UPDATE projects SET stages_json=${stages} WHERE id=${project.id}`.execute(core.db)
      await expect(get(owner, project.id)).rejects.toMatchObject({ code: 'storage_error' })
    }
  })
  it('空ID数组/非法参数/预取消不发计数SQL，读取错误不吞成0', async () => {
    const counts = port(), get = createProjectGetter(core, counts), list = createProjectListing(core, counts)
    expect(await counts.forProjects(owner, [])).toEqual(new Map())
    await expect(counts.forProjects('invalid-owner', [1])).rejects.toThrow()
    for (const ids of [[1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1]]) await expect(counts.forProjects(owner, ids)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(get(owner, undefined as unknown as number)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(get('invalid-owner', 1)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(list(owner, true, true)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(list(owner, 'true' as unknown as boolean)).rejects.toMatchObject({ code: 'invalid_request' })
    const controller = new AbortController(), error = new Error('合成预取消')
    controller.abort(error)
    await expect(counts.list(owner, controller.signal)).rejects.toBe(error)
    await expect(counts.forProjects(owner, [1], controller.signal)).rejects.toBe(error)
    expect(countQueries).toBe(0)
    await projection()
    const project = await create('有记录')
    await sql`DROP TABLE project_file_counts`.execute(core.db)
    await expect(counts.forProjects(owner, [project.id])).rejects.toThrow()
  })
  it.each(['list', 'forProjects'] as const)('%s真实查询结果处理期间取消须等待cleanup再settle', async method => {
    await projection()
    const project = await create('取消项目')
    const entered = deferred(), release = deferred(), controller = new AbortController(), reason = new Error('合成读取取消')
    let cleaned = false, settled = false
    const db = core.db.withPlugin({ transformQuery(args) { return args.node }, async transformResult() {
      entered.resolve(); await release.promise; cleaned = true; throw new Error('合成驱动结果错误')
    } })
    const counts = createKyselyProjectFileCountReader(db, 'sqlite')
    const ids = [project.id]
    const pending = method === 'list' ? counts.list(owner, controller.signal) : counts.forProjects(owner, ids, controller.signal)
    const observed = pending.then(() => { settled = true; return null }, error => { settled = true; return error })
    await entered.promise
    ids[0] = 999
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false); expect(cleaned).toBe(false)
    release.resolve()
    expect(await observed).toBe(reason); expect(cleaned).toBe(true)
    expect(await createProjectGetter(core, port())(owner, project.id)).toMatchObject({ id: project.id })
  })
})
