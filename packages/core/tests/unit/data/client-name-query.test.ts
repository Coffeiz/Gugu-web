import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDesktopChatReferences } from '../../../src/agent/sessions/desktop-references.js'
import { readDesktopClientRelated } from '../../../src/clients/related.js'
import { createSqlMindRefNodeCreateRuntime } from '../../../src/mind/ref-node-create-sql.js'
import { CoreError, dataContext } from '../../../src/contracts/index.js'
import { ClientService, ClientValidationError } from '../../../src/clients/service.js'
import type { ClientRepository } from '../../../src/clients/service.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'

let folder: string, owner: string, other: string, runtime: SqlDataRuntime
async function add(name: string, user = owner) { return runtime.transaction(dataContext(user), data => data.clients.create({ name })) }
async function names(name: string, user = owner) { return (await runtime.transaction(dataContext(user), data => data.clients.findByName(name))).map(row => row.name).sort() }
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-client-query-'))
  const path = join(folder, 'core.db')
  await initializeSqlite(path)
  const opened = await openSqliteRuntime(path)
  runtime = opened.runtime; owner = opened.ownerId; other = randomUUID()
})
afterEach(async () => { await runtime?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

describe('真实临时SQLite联系人名称查询', () => {
  it('保存地址并按联系人 ID 关联笔记和画布，只返回当前所有者的有效内容', async () => {
    const contact = await add('小北')
    await runtime.transaction(dataContext(owner), data => data.clients.update(contact.id, { address: '示例路 10 号' }))
    expect((await runtime.transaction(dataContext(owner), data => data.clients.list()))[0]?.address).toBe('示例路 10 号')
    await runtime.transaction(dataContext(owner), data => data.projects.create({ name: '合作项目', client: '小北' }))
    await runtime.transaction(dataContext(other), data => data.projects.create({ name: '他人项目', client: '小北' }))
    const refsToSend = [{ type: 'client', id: contact.id, label: '小北' }]
    expect(await resolveDesktopChatReferences(runtime.db, owner, refsToSend, '检查联系人')).toContain('示例路 10 号')
    expect(await resolveDesktopChatReferences(runtime.db, other, refsToSend, '检查联系人')).toBe('检查联系人')
    const owned = owner.replaceAll('-', '')
    const foreign = other.replaceAll('-', '')
    const stamp = '2026-01-01 00:00:00.000000'
    const common = { kind: 'note', content_plain: '', origin: 'user', version: 1, captured_at: stamp, created_at: stamp, updated_at: stamp }
    const mention = `[[client:${contact.id}|小北]]`
    await runtime.db.insertInto('mind_nodes').values([
      { ...common, user_id: owned, title: '项目笔记', content_md: mention },
      { ...common, user_id: owned, title: '示例代码', content_md: '`' + mention + '`' },
      { ...common, user_id: foreign, title: '其他笔记', content_md: mention },
    ]).execute()
    const refs = createSqlMindRefNodeCreateRuntime(runtime.db, 'sqlite', async () => {})
    const card = await refs.transaction(owner, tx => tx.create(owner, 'client', contact.id))
    await expect(refs.transaction(other, tx => tx.create(other, 'client', contact.id))).rejects.toMatchObject({ statusCode: 404 })
    const canvas = await runtime.db.insertInto('mind_maps').values({
      user_id: owned, title: '合作画布', data_json: '{}', created_at: stamp, updated_at: stamp,
    }).returning('id').executeTakeFirstOrThrow()
    await runtime.db.insertInto('mind_canvas_items').values({
      user_id: owned, canvas_id: canvas.id, node_id: Number(card.node.id), x: 0, y: 0, z: 1,
      collapsed: 0, data_json: '{}', created_at: stamp, updated_at: stamp,
    }).execute()
    expect(await readDesktopClientRelated(runtime.db, owner, contact.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'project', title: '合作项目' }),
      expect.objectContaining({ type: 'note', title: '项目笔记' }),
      expect.objectContaining({ type: 'canvas', title: '合作画布' }),
    ]))
    expect(await readDesktopClientRelated(runtime.db, owner, contact.id)).toHaveLength(3)
    expect(await readDesktopClientRelated(runtime.db, other, contact.id)).toEqual([])
  })

  it('字段错误保留来源类型，ID 与仓储同码错误不冒充字段验证', async () => {
    for (const fields of [{ name: ' ' }, { name: '甲'.repeat(201) }, { name: '甲', email: 'a'.repeat(301) }, { name: '甲', phone: '1'.repeat(51) }])
      await expect(runtime.transaction(dataContext(owner), data => data.clients.create(fields))).rejects.toBeInstanceOf(ClientValidationError)
    expect(await runtime.transaction(dataContext(owner), data => data.clients.list())).toEqual([])
    await expect(runtime.transaction(dataContext(owner), data => data.clients.update(1, {}))).rejects.toBeInstanceOf(ClientValidationError)
    await expect(runtime.transaction(dataContext(owner), data => data.clients.update(0, { name: '甲' }))).rejects.not.toBeInstanceOf(ClientValidationError)
    const failure = new CoreError('invalid_request', '合成仓储失败')
    const repository = { async create() { throw failure } } as unknown as ClientRepository
    await expect(new ClientService(repository).create({ name: '甲' })).rejects.toBe(failure)
  })
  it('owner内精确优先，不把其他owner的精确结果当自己的模糊结果', async () => {
    await add('小北'); await add('小北同学'); await add('小北', other)
    expect(await names('小北')).toEqual(['小北'])
    expect(await names('同学', other)).toEqual([])
    expect(await names('北')).toEqual(['小北', '小北同学'])
    expect(await names('北', other)).toEqual(['小北'])
  })
  it('保留SQL百分号和下划线通配，不trim业务输入', async () => {
    await add('alpha'); await add('alXha'); await add('  padded  ')
    expect(await names('al_ha')).toEqual(['alXha', 'alpha'])
    expect(await names('a%a')).toEqual(['alXha', 'alpha'])
    expect(await names('  padded  ')).toEqual(['  padded  '])
    expect(await names(' padded ')).toEqual(['  padded  '])
    expect(await names('  alpha  ')).toEqual([])
  })
  it('SQLite反斜线不是默认LIKE转义，不套用PostgreSQL规则', async () => {
    await add('a_b'); await add('a\\xb')
    expect(await names('a\\_b')).toEqual(['a\\xb'])
  })
  it('使用SQLite原生lower，不以JS Unicode折叠扩大查询结果', async () => {
    await add('Änne'); await add('ASCII')
    expect(await names('änne')).toEqual([])
    expect(await names('ascii')).toEqual(['ASCII'])
  })
  it('引号和SQL片段是用户参数，不扩大查询范围', async () => {
    await add("O'Reilly"); await add('普通联系人')
    expect(await names("O'Rei")).toEqual(["O'Reilly"])
    expect(await names("' OR 1=1 --")).toEqual([])
    expect(await names("%'; DROP TABLE clients; --")).toEqual([])
    expect(await runtime.transaction(dataContext(owner), data => data.clients.list())).toHaveLength(2)
  })
  it('名称查询不改变现有list的创建时间和id降序契约', async () => {
    const first = await add('首项'), second = await add('后项')
    await names('%')
    expect((await runtime.transaction(dataContext(owner), data => data.clients.list())).map(row => row.id)).toEqual([second.id, first.id])
  })
})
