import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

let folder: string, owner: string, other: string, runtime: SqlDataRuntime
// 直接仓储播种历史名称，名称查询不应受新建项目的文件名校验限制。
async function add(name: string, user = owner, archived = false) {
  return runtime.transaction(dataContext(user), data => data.projects.repository.create({ name, archived }))
}
async function names(name: string, user = owner) {
  return (await runtime.transaction(dataContext(user), data => data.projects.findByName(name))).map(row => row.name).sort()
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-project-query-'))
  const path = join(folder, 'core.db')
  await initializeSqlite(path)
  const opened = await openSqliteRuntime(path)
  runtime = opened.runtime; owner = opened.ownerId; other = randomUUID()
})
afterEach(async () => { await runtime?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

describe('真实临时SQLite项目名称查询', () => {
  it('owner内精确优先且含归档，不让其他owner精确结果阻断自己的模糊查询', async () => {
    const active = await add('小北'), archived = await add('小北', owner, true)
    await add('小北同学'); await add('小北同学', other)
    const rows = await runtime.transaction(dataContext(owner), data => data.projects.findByName('小北'))
    expect(new Set(rows.map(row => row.id))).toEqual(new Set([active.id, archived.id]))
    expect(rows.some(row => row.archived)).toBe(true)
    expect(await names('北', other)).toEqual(['小北同学'])
    expect(await names('小北', other)).toEqual(['小北同学'])
    expect(await names('无此项', other)).toEqual([])
  })
  it('已删除精确项不能阻断存活模糊项，也不暴露其他owner记录', async () => {
    const deleted = await add('消失项目')
    await add('消失项目扩展'); await add('消失项目', other)
    await runtime.db.updateTable('projects').set({ deleted_at: '2026-01-01 00:00:00.000000' }).where('id', '=', deleted.id).execute()
    expect(await names('消失项目')).toEqual(['消失项目扩展'])
    expect(await names('消失项目', other)).toEqual(['消失项目'])
  })
  it('保留百分号/下划线通配与名称原始空白，不改业务输入', async () => {
    await add('alpha'); await add('alXha'); await add('  padded  ')
    expect(await names('al_ha')).toEqual(['alXha', 'alpha'])
    expect(await names('a%a')).toEqual(['alXha', 'alpha'])
    expect(await names('  padded  ')).toEqual(['  padded  '])
    expect(await names('  alpha  ')).toEqual([])
  })
  it('反斜线按SQLite LIKE字面字符处理，不使用PG转义或JS正则', async () => {
    await add('a_b'); await add('a\\xb')
    expect(await names('a\\_b')).toEqual(['a\\xb'])
  })
  it('SQLite原生lower保持Unicode大小写差异，精确匹配仍优先', async () => {
    await add('Änne'); await add('ASCII')
    expect(await names('änne')).toEqual([])
    expect(await names('ascii')).toEqual(['ASCII'])
    await add('Ä'); await add('ä')
    expect(await names('Ä')).toEqual(['Ä'])
    expect(await names('ä')).toEqual(['ä'])
  })
  it('引号与SQL片段参数化，不扩大结果也不破坏项目表', async () => {
    await add("O'Reilly"); await add('普通项目')
    expect(await names("O'Rei")).toEqual(["O'Reilly"])
    expect(await names("' OR 1=1 --")).toEqual([])
    expect(await names("%'; DROP TABLE projects; --")).toEqual([])
    expect(await runtime.transaction(dataContext(owner), data => data.projects.list())).toHaveLength(2)
  })
  it('名称查询不改变既有list排序，且自身保留数据库原始结果顺序', async () => {
    const first = await add('首项'), second = await add('后项')
    const direct = await runtime.db.selectFrom('projects').select('id').where('user_id', '=', owner.replaceAll('-', '')).where('deleted_at', 'is', null).execute()
    const rows = await runtime.transaction(dataContext(owner), data => data.projects.findByName('%'))
    expect(rows.map(row => row.id)).toEqual(direct.map(row => Number(row.id)))
    expect((await runtime.transaction(dataContext(owner), data => data.projects.list())).map(row => row.id)).toEqual([second.id, first.id])
  })
})
