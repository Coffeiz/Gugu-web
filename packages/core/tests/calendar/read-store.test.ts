import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql, type KyselyPlugin } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataContext } from '../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../src/data/runtime.js'
import { createCalendarEventReader } from '../../src/calendar/application/event-read.js'
import { createKyselyCalendarReadPort } from '../../src/calendar/read-store.js'

let directory: string, runtime: SqlDataRuntime, owner: string, other: string
let queries: number, projectId: number
let reader: ReturnType<typeof createCalendarEventReader>
const key = (value: string) => value.replaceAll('-', '')
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function seed(id: number, user: string, date: string, deleted = false) {
  await sql`INSERT INTO calendar_events(id,user_id,title,date,time,end_time,type,contact_name,project_id,description,version,created_at,deleted_at)
    VALUES(${id},${key(user)},${'事件' + id},${date},${id === 2 ? '10:00' : null},${id === 2 ? '11:00' : null},'event',${id === 2 ? '小北' : null},NULL,${id === 2 ? '讨论事项' : null},${id === 2 ? 7 : 1},'2026-01-01 00:00:00',${deleted ? '2026-01-02 00:00:00' : null})`.execute(runtime.db)
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gugu-calendar-read-'))
  const filename = join(directory, 'core.db')
  await initializeSqlite(filename)
  const opened = await openSqliteRuntime(filename)
  runtime = opened.runtime; owner = opened.ownerId; other = randomUUID(); queries = 0
  await seed(1, owner, '2026-12-01')
  await seed(2, owner, '2026-11-14')
  await seed(3, other, '2026-11-01')
  await seed(4, owner, '2026-11-15', true)
  const project = await runtime.transaction(dataContext(owner), data => data.projects.create({ name: '关联项目' }))
  projectId = project.id
  await sql`UPDATE calendar_events SET project_id=${projectId} WHERE id=2`.execute(runtime.db)
  const db = runtime.db.withPlugin({ transformQuery(args) { queries++; return args.node }, async transformResult(args) { return args.result } })
  reader = createCalendarEventReader(createKyselyCalendarReadPort(db, 'sqlite'))
})
afterEach(async () => { await runtime?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

describe('日历公共读取用例与正式临时SQLite schema', () => {
  it('owner/软删过滤、日期升序和完整null/version/联系人投影', async () => {
    expect(await reader.list(owner.toUpperCase())).toEqual([
      { id: 2, title: '事件2', date: '2026-11-14', time: '10:00', endTime: '11:00', type: 'event', client: '小北', projectId, description: '讨论事项', version: 7 },
      { id: 1, title: '事件1', date: '2026-12-01', time: null, endTime: null, type: 'event', client: null, projectId: null, description: null, version: 1 },
    ])
    expect(await reader.list(other)).toMatchObject([{ id: 3 }])
    expect(await reader.get(owner, 2)).toMatchObject({ id: 2, version: 7, client: '小北' })
    expect(await reader.get(other, 2)).toBeNull()
    expect(await reader.get(owner, 4)).toBeNull()
    expect(await reader.get(owner, 999)).toBeNull()
    await sql`UPDATE calendar_events SET version=0 WHERE id=2`.execute(runtime.db)
    expect(await reader.get(owner, 2)).toMatchObject({ version: 1 })
  })
  it('year/month仅两者非零才过滤，保持零/缺省/负数原文本前缀语义', async () => {
    expect((await reader.list(owner, 2026, 11)).map(row => row.id)).toEqual([2])
    expect((await reader.list(owner, 2026, 12)).map(row => row.id)).toEqual([1])
    for (const [year, month] of [[2026, undefined], [undefined, 11], [0, 11], [2026, 0], [undefined, undefined]] as const)
      expect((await reader.list(owner, year, month)).map(row => row.id)).toEqual([2, 1])
    expect(await reader.list(owner, -1, 11)).toEqual([])
    expect(await reader.list(owner, 2026, -1)).toEqual([])
  })
  it('非法owner/非safe整数及预取消在SQL前拒绝', async () => {
    await expect(reader.list('invalid-owner')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(reader.get('invalid-owner', 2)).rejects.toMatchObject({ code: 'invalid_request' })
    for (const id of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(reader.get(owner, id)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(reader.get(owner, undefined as unknown as number)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(reader.list(owner, 2026, 11.5)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(reader.list(owner, 2026.5, 11)).rejects.toMatchObject({ code: 'invalid_request' })
    const controller = new AbortController(), reason = new Error('合成预取消')
    controller.abort(reason)
    await expect(reader.list(owner, undefined, undefined, { signal: controller.signal })).rejects.toBe(reason)
    await expect(reader.get(owner, 2, { signal: controller.signal })).rejects.toBe(reason)
    expect(queries).toBe(0)
  })
  it('真实SQL错误传播，不能伪造空列表或不存在', async () => {
    await sql`DROP TABLE calendar_events`.execute(runtime.db)
    await expect(reader.list(owner)).rejects.toThrow()
    await expect(reader.get(owner, 2)).rejects.toThrow()
  })
  it.each(['list', 'get'] as const)('执行中%s取消必须等真实SQL结果处理结束后再settle', async method => {
    const entered = deferred(), release = deferred(), controller = new AbortController(), reason = new Error('合成查询取消')
    let resultHandled = false
    const plugin: KyselyPlugin = {
      transformQuery(args) { return args.node },
      async transformResult(args) { entered.resolve(); await release.promise; resultHandled = true; return args.result },
    }
    const db = runtime.db.withPlugin(plugin)
    const api = createCalendarEventReader(createKyselyCalendarReadPort(db, 'sqlite'))
    let settled = false
    const pending = method === 'list' ? api.list(owner, undefined, undefined, { signal: controller.signal }) : api.get(owner, 2, { signal: controller.signal })
    const observed = pending.then(() => { settled = true; return null }, error => { settled = true; return error })
    await entered.promise
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(resultHandled).toBe(false)
    release.resolve()
    expect(await observed).toBe(reason)
    expect(resultHandled).toBe(true)
    expect(await reader.get(owner, 2)).toMatchObject({ id: 2 })
  })
})


describe('日历读取数据端口的取消错误优先级', () => {
  it.each(['list', 'get'] as const)('%s驱动结果处理拒绝仍等待结束，并优先原取消原因', async method => {
    const entered = deferred(), release = deferred(), controller = new AbortController(), reason = new Error('合成原取消原因')
    let cleanedUp = false, settled = false
    const db = runtime.db.withPlugin({
      transformQuery(args) { return args.node },
      async transformResult() {
        entered.resolve()
        await release.promise
        cleanedUp = true
        throw new Error('合成驱动结果处理错误')
      },
    })
    // 直接经过生产数据端口，避免应用层finally掩盖数据端口遗漏的取消边界。
    const port = createKyselyCalendarReadPort(db, 'sqlite')
    const pending = method === 'list' ? port.list(owner, undefined, controller.signal) : port.get(owner, 2, controller.signal)
    const observed = pending.then(() => { settled = true; return null }, error => { settled = true; return error })
    await entered.promise
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(cleanedUp).toBe(false)
    release.resolve()
    expect(await observed).toBe(reason)
    expect(cleanedUp).toBe(true)
  })
})
