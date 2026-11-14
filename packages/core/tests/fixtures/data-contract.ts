import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { dataContext } from '../../src/contracts/index.js'
import type { SqlDataRuntime } from '../../src/data/runtime.js'
import { databaseTime } from '../../src/data/codec.js'

export interface ContractFixture {
  runtime: SqlDataRuntime
  owner: string
  other: string
  close(): Promise<void>
}

// 同一行为在真实 SQLite/PG 上执行；断言业务结果，不依赖 SQL 写法。
export function dataContract(label: string, create: () => Promise<ContractFixture>) {
  describe(label, () => {
    let fixture: ContractFixture
    beforeEach(async () => {
      fixture = await create()
    })
    afterEach(async () => {
      await fixture?.close()
    })
    it('同内容收据忽略字段顺序，方法或内容变化冲突且不产生额外数据', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner),
        operation = randomUUID(),
        params = { name: '仅一次联系人', notes: '原始资料' }
      const created = await runtime.operation(
        context,
        operation,
        'clients.create',
        params,
        (data) => data.clients.create(params),
      )
      const reordered = { notes: '原始资料', name: '仅一次联系人' }
      expect(
        await runtime.operation(context, operation, 'clients.create', reordered, (data) =>
          data.clients.create(reordered),
        ),
      ).toEqual(created)
      for (const changed of [
        { method: 'clients.update', params },
        { method: 'clients.create', params: { ...params, notes: '不同资料' } },
      ])
        await expect(
          runtime.operation(context, operation, changed.method, changed.params, (data) =>
            data.clients.create({ name: '不应创建' }),
          ),
        ).rejects.toMatchObject({ code: 'conflict' })
      expect(await runtime.receipt(context, operation)).toEqual({
        method: 'clients.create',
        result: created,
      })
      expect(await runtime.transaction(context, (data) => data.clients.list())).toEqual([
        created,
      ])
    })
    it('不同所有者可以使用相同操作 UUID，各自收据和持久数据互不泄漏', async () => {
      const { runtime, owner, other } = fixture,
        context = dataContext(owner),
        stranger = dataContext(other),
        operation = randomUUID()
      const first = await runtime.operation(
        context,
        operation,
        'clients.create',
        { name: '甲的联系人' },
        (data) => data.clients.create({ name: '甲的联系人' }),
      )
      expect(await runtime.receipt(stranger, operation)).toBeNull()
      const second = await runtime.operation(
        stranger,
        operation,
        'clients.create',
        { name: '乙的联系人' },
        (data) => data.clients.create({ name: '乙的联系人' }),
      )
      expect(second.id).not.toBe(first.id)
      for (const [scope, record] of [
        [context, first],
        [stranger, second],
      ] as const) {
        expect(await runtime.receipt(scope, operation)).toEqual({
          method: 'clients.create',
          result: record,
        })
        expect(await runtime.transaction(scope, (data) => data.clients.list())).toEqual([
          record,
        ])
      }
    })
    it('CAS 失败不消耗操作 UUID，重读后可提交，成功重放不再次递增版本', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner),
        operation = randomUUID()
      const initial = await runtime.transaction(context, (data) =>
        data.projects.create({ name: '初始计划' }),
      )
      const latest = await runtime.transaction(context, (data) =>
        data.projects.update(initial.id, 1, { name: '其他修改' }),
      )
      await expect(
        runtime.operation(
          context,
          operation,
          'projects.rename',
          { id: initial.id, version: 1, name: '过期修改' },
          (data) => data.projects.update(initial.id, 1, { name: '过期修改' }),
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await runtime.receipt(context, operation)).toBeNull()
      expect(await runtime.transaction(context, (data) => data.projects.list())).toEqual([
        latest,
      ])
      const params = { id: latest.id, version: latest.version, name: '最终计划' }
      const retry = () =>
        runtime.operation(context, operation, 'projects.rename', params, (data) =>
          data.projects.update(params.id, params.version, { name: params.name }),
        )
      const committed = await retry()
      expect(committed).toMatchObject({ name: '最终计划', version: 3 })
      expect(await retry()).toEqual(committed)
      expect(await runtime.receipt(context, operation)).toEqual({
        method: 'projects.rename',
        result: committed,
      })
      expect(await runtime.transaction(context, (data) => data.projects.list())).toEqual([
        committed,
      ])
    })
    it('联系人更新只改变提交的字段，显式 null 清空且重读结果持久化', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner)
      const contact = await runtime.transaction(context, (data) =>
        data.clients.create({
          name: '小北',
          email: 'test@example.invalid',
          phone: '10000',
          notes: '初次联系',
        }),
      )
      const updated = await runtime.transaction(context, (data) =>
        data.clients.update(contact.id, { phone: null, notes: '' }),
      )
      expect(updated).toMatchObject({
        id: contact.id,
        name: '小北',
        email: 'test@example.invalid',
        phone: null,
        notes: '',
      })
      await runtime.transaction(context, async (data) => {
        expect(await data.clients.list()).toEqual([updated])
      })
    })
    it('空更新或非法联系人字段不改变已有资料，删除后所有入口返回不存在', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner)
      const contact = await runtime.transaction(context, (data) =>
        data.clients.create({ name: '待维护联系人', notes: '保留' }),
      )
      for (const fields of [{}, { name: ' ' }, { notes: null }, { unknown: '禁止字段' }])
        await expect(
          runtime.transaction(context, (data) => data.clients.update(contact.id, fields)),
        ).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await runtime.transaction(context, (data) => data.clients.list())).toEqual([
        contact,
      ])
      await runtime.transaction(context, (data) => data.clients.delete(contact.id))
      expect(await runtime.transaction(context, (data) => data.clients.list())).toEqual([])
      await expect(
        runtime.transaction(context, (data) =>
          data.clients.update(contact.id, { notes: '失效' }),
        ),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        runtime.transaction(context, (data) => data.clients.delete(contact.id)),
      ).rejects.toMatchObject({ code: 'not_found' })
    })
    it('跨所有者不能读取、更新或删除联系人，也不能枚举项目', async () => {
      const { runtime, owner, other } = fixture,
        context = dataContext(owner),
        stranger = dataContext(other)
      const contact = await runtime.transaction(context, async (data) => {
        await data.projects.create({ name: '私有项目' })
        return data.clients.create({ name: '私有联系人' })
      })
      await runtime.transaction(stranger, async (data) => {
        expect(await data.projects.list()).toEqual([])
        expect(await data.clients.list()).toEqual([])
        await expect(
          data.clients.update(contact.id, { notes: '越权' }),
        ).rejects.toMatchObject({ code: 'not_found' })
        await expect(data.clients.delete(contact.id)).rejects.toMatchObject({
          code: 'not_found',
        })
      })
      expect(await runtime.transaction(context, (data) => data.clients.list())).toEqual([
        contact,
      ])
    })
    it('后续联系人校验失败时回滚前面的联系人修改和项目创建', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner)
      const contact = await runtime.transaction(context, (data) =>
        data.clients.create({ name: '原有联系人', notes: '原始内容' }),
      )
      await expect(
        runtime.transaction(context, async (data) => {
          await data.clients.update(contact.id, { notes: '不得提交' })
          await data.projects.create({ name: '不得留下' })
          await data.clients.create({ name: '' })
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' })
      await runtime.transaction(context, async (data) => {
        expect(await data.clients.list()).toEqual([contact])
        expect(await data.projects.list()).toEqual([])
      })
    })
    it('相同微秒的联系人按 ID 倒序稳定排列，保留 Unicode 与默认字段', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner)
      const contacts = await runtime.transaction(context, async (data) => [
        await data.clients.create({ name: '甲😀' }),
        await data.clients.create({ name: '乙😀' }),
      ])
      const rows = await runtime.transaction(context, (data) => data.clients.list())
      expect(rows.map((row) => row.name)).toEqual(['乙😀', '甲😀'])
      expect(rows[0]).toMatchObject({
        contact: null,
        email: null,
        phone: null,
        notes: '',
        created_at: '2026-11-10 10:00:00.123456+00:00',
      })
      expect(contacts[0]!.id).toBeLessThan(contacts[1]!.id)
    })
    it('项目更新对照现有日期，错误不提交；归档后只出现在归档列表', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner)
      const project = await runtime.transaction(context, (data) =>
        data.projects.create({
          name: '有期限项目',
          start_date: '2026-01-10',
          deadline: '2026-01-20',
        }),
      )
      await expect(
        runtime.transaction(context, (data) =>
          data.projects.update(project.id, 1, { deadline: '2026-01-09' }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(
        runtime.transaction(context, (data) => data.projects.update(project.id, 1, {})),
      ).rejects.toMatchObject({ code: 'invalid_request' })
      const archived = await runtime.transaction(context, (data) =>
        data.projects.update(project.id, 1, { archived: true, summary: '  ' }),
      )
      expect(archived).toMatchObject({
        version: 2,
        archived: true,
        summary: null,
      })
      expect(await runtime.transaction(context, (data) => data.projects.list())).toEqual([])
      expect(
        await runtime.transaction(context, (data) => data.projects.list(true)),
      ).toEqual([archived])
    })
    it('取消回滚所有领域且不留收据；关闭后查询和修改均拒绝', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner),
        controller = new AbortController(),
        operation = randomUUID()
      await expect(
        runtime.operation(
          context,
          operation,
          'contract.cancel',
          {},
          async (data) => {
            await data.projects.create({ name: '取消项目' })
            await data.clients.create({ name: '取消联系人' })
            controller.abort()
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({ code: 'cancelled' })
      expect(await runtime.receipt(context, operation)).toBeNull()
      await runtime.transaction(context, async (data) => {
        expect(await data.projects.list()).toEqual([])
        expect(await data.clients.list()).toEqual([])
      })
      await runtime.close()
      await expect(
        runtime.transaction(context, (data) => data.clients.list()),
      ).rejects.toMatchObject({ code: 'closed' })
      await expect(runtime.receipt(context, operation)).rejects.toMatchObject({
        code: 'closed',
      })
    })
    it('项目墓碑在普通和归档列表中均隐藏，后续修改不枚举已删除记录', async () => {
      const { runtime, owner } = fixture,
        context = dataContext(owner)
      const project = await runtime.transaction(context, (data) =>
        data.projects.create({ name: '已删除计划' }),
      )
      await runtime.db
        .updateTable('projects')
        .set({
          deleted_at: databaseTime('2026-11-10T10:00:00.123456Z', runtime.backend),
        })
        .where('id', '=', project.id)
        .where(
          'user_id',
          '=',
          runtime.backend === 'sqlite' ? owner.replaceAll('-', '') : owner,
        )
        .execute()
      await runtime.transaction(context, async (data) => {
        expect(await data.projects.list()).toEqual([])
        expect(await data.projects.list(true)).toEqual([])
        await expect(
          data.projects.update(project.id, 1, { name: '不应恢复' }),
        ).rejects.toMatchObject({ code: 'not_found' })
      })
    })
  })
}
