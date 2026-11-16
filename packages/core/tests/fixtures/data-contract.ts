import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { dataContext } from '../../src/contracts/index.js'
import type { SqlDataRuntime } from '../../src/data/runtime.js'
import { databaseTime, type Clock } from '../../src/data/codec.js'
import { createProjectUpdater, type ProjectUpdatedEvent } from '../../src/projects/project-update.js'
import { createKyselyProjectUpdateTransaction } from '../../src/projects/update-store.js'
import { PROJECT_COLOR_PRESETS } from '../../src/projects/colors.js'

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
    it('联系人各字段按 Unicode 码点限制长度，保留空白和未提供字段，非法更新不落库', async () => {
      const { runtime, owner } = fixture, context = dataContext(owner)
      const fields = {
        name: '😀'.repeat(200), contact: '😀'.repeat(200),
        email: '甲'.repeat(300), phone: '1'.repeat(50), notes: '  原始备注\n',
      }
      const contact = await runtime.transaction(context, data => data.clients.create(fields))
      expect(contact).toMatchObject(fields)
      for (const [field, maximum] of Object.entries({ name: 200, contact: 200, email: 300, phone: 50 })) {
        const invalid = { [field]: '😀'.repeat(maximum + 1) }
        await expect(runtime.transaction(context, data => data.clients.create({ ...fields, ...invalid })))
          .rejects.toMatchObject({ code: 'invalid_request' })
        await expect(runtime.transaction(context, data => data.clients.update(contact.id, invalid)))
          .rejects.toMatchObject({ code: 'invalid_request' })
      }
      const updated = await runtime.transaction(context, data => data.clients.update(contact.id, {
        name: '  小北  ', contact: null, email: null, phone: null,
      }))
      expect(updated).toEqual({ ...contact, name: '  小北  ', contact: null, email: null, phone: null })
      expect(await runtime.transaction(context, data => data.clients.update(contact.id, { name: updated.name })))
        .toEqual(updated)
      expect(await runtime.transaction(context, data => data.clients.list())).toEqual([updated])
    })
    it('联系人删除随外层事务或收据写入失败回滚，成功删除收据重放不再次执行', async () => {
      const { runtime, owner } = fixture, context = dataContext(owner)
      const contact = await runtime.transaction(context, data => data.clients.create({ name: '保留联系人' }))
      const operationId = randomUUID()
      await expect(runtime.operation(context, operationId, 'clients.delete', { id: contact.id }, async data => {
        await data.clients.delete(contact.id)
        // 序列化收据时抛错，验证已经执行的 DELETE 仍由同一事务回滚。
        return { invalidReceipt: 1n }
      })).rejects.toThrow()
      expect(await runtime.receipt(context, operationId)).toBeNull()
      expect(await runtime.transaction(context, data => data.clients.list())).toEqual([contact])
      const remove = () => runtime.operation(context, operationId, 'clients.delete', { id: contact.id }, async data => {
        await data.clients.delete(contact.id)
        return null
      })
      expect(await remove()).toBeNull()
      expect(await remove()).toBeNull()
      expect(await runtime.transaction(context, data => data.clients.list())).toEqual([])
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
    // Web 完整更新用例与桌面数据服务分开验证；此切片不装配旧文件库或物理目录。
    function projectUpdater(events: ProjectUpdatedEvent[], owner = fixture.owner, clock: Clock = () => '2026-11-10T10:00:00.123456Z') {
      const { runtime } = fixture
      return createProjectUpdater({
        transaction: work => runtime.db.transaction().execute(tx =>
          work(createKyselyProjectUpdateTransaction(tx, runtime.backend, owner, clock))),
        async renameProjectDirectory() { throw new Error('本合同不提供旧项目文件目录能力') },
        async getFileCount() { return 0 },
        async publishProjectUpdated(event) {
          // 在另一事务重读，防止把未提交的版本作为成功事件发布。
          const saved = await runtime.transaction(dataContext(event.userId), data => data.projects.get(event.entityId))
          expect(saved?.version).toBe(event.payload.version)
          events.push(event)
        },
      })
    }
    it('项目更新用例双库持久化公开字段、阶段、归档和完成时间，仅修改提交字段', async () => {
      const { runtime, owner } = fixture, context = dataContext(owner), events: ProjectUpdatedEvent[] = []
      const project = await runtime.transaction(context, data => data.projects.create({
        name: '原项目', summary: '保留摘要', client: '旧联系人',
        start_date: '2026-01-01', deadline: '2026-12-31',
      }))
      let updateTime = '2026-11-10T10:00:00.123456Z'
      const update = projectUpdater(events, owner, () => updateTime)
      const stages = [{ key: 's0', label: '计划', todos: [{ id: 't1', text: '验收', done: true }] }]
      const result = await update(owner, project.id, {
        version: 1, client: '小北', status: 'done', startDate: '2026-02-01', deadline: '2026-12-01',
        color: PROJECT_COLOR_PRESETS[1], progress: 100, stages, currentStage: 's0', archived: true, priority: 'high',
      }, { clientId: ' desktop-test ' })
      expect(result).toMatchObject({
        id: project.id, name: '原项目', client: '小北', status: 'done', startDate: '2026-02-01', deadline: '2026-12-01',
        color: PROJECT_COLOR_PRESETS[1], progress: 100, stages, currentStage: 's0', archived: true, priority: 'high',
        version: 2, doneAt: '2026-11-10T10:00:00.123456+00:00', updatedAt: '2026-11-10T10:00:00.123456+00:00', fileCount: 0,
      })
      const saved = await runtime.transaction(context, data => data.projects.get(project.id))
      expect(saved).toMatchObject({ summary: '保留摘要', client: '小北', archived: true, version: 2 })
      expect(JSON.parse(saved!.stages_json)).toEqual(stages)
      expect(await runtime.transaction(context, data => data.projects.list())).toEqual([])
      expect(await runtime.transaction(context, data => data.projects.list(true))).toEqual([saved])
      expect(events).toEqual([expect.objectContaining({ origin: 'desktop-test', payload: result })])
      updateTime = '2026-11-11T11:00:00.654321Z'
      const sameDone = await update(owner, project.id, { version: 2, status: 'done' })
      expect(sameDone.doneAt).toBe(result.doneAt)
      expect(sameDone.updatedAt).toBe('2026-11-11T11:00:00.654321+00:00')
      const cleared = await update(owner, project.id, {
        version: 3, status: 'active', client: null, startDate: null, deadline: null, currentStage: null, priority: null, archived: false,
      })
      expect(cleared).toMatchObject({ version: 4, doneAt: null, client: null, startDate: null, deadline: null, currentStage: null, priority: null, archived: false })
    })
    it('项目更新用例拒绝跨 owner、墓碑、缺版本和非法字段；版本空补丁保持 Python 无写入语义', async () => {
      const { runtime, owner, other } = fixture, context = dataContext(owner), events: ProjectUpdatedEvent[] = []
      const project = await runtime.transaction(context, data => data.projects.create({
        name: '有期限项目', start_date: '2026-01-10', deadline: '2026-01-20',
        stages: [{ key: 's0', label: '计划', todos: [] }], current_stage: 's0',
      }))
      const update = projectUpdater(events)
      const foreignUpdate = projectUpdater(events, other)
      await expect(foreignUpdate(other, project.id, { version: 1, progress: 30 })).rejects.toMatchObject({ code: 'not_found' })
      for (const input of [
        { progress: 30 }, { version: 1, progress: 101 }, { version: 1, deadline: '2026-01-09' },
        { version: 1, startDate: '2026-01-21' }, { version: 1, currentStage: 'missing' },
        { version: 1, stages: [], currentStage: 's0' }, { version: 1, color: 'invalid' },
      ]) await expect(update(owner, project.id, input)).rejects.toMatchObject({ code: 'invalid_request' })
      // Python handler 对只有 version（即使陈旧）的 PATCH 不执行 CAS 或写入。
      expect(await update(owner, project.id, { version: 9 })).toMatchObject({ version: 1 })
      expect(await runtime.transaction(context, data => data.projects.get(project.id))).toEqual(project)
      expect(events).toEqual([])
      await runtime.db.updateTable('projects').set({ deleted_at: databaseTime('2026-11-10T00:00:00Z', runtime.backend) })
        .where('id', '=', project.id).execute()
      await expect(update(owner, project.id, { version: 1, progress: 30 })).rejects.toMatchObject({ code: 'not_found' })
    })
    it('项目更新用例同版本竞争仅一方提交，失败的更新不污染事务和提交后事件', async () => {
      const { runtime, owner } = fixture, context = dataContext(owner), events: ProjectUpdatedEvent[] = []
      const project = await runtime.transaction(context, data => data.projects.create({ name: '竞争项目' }))
      const update = projectUpdater(events)
      const results = await Promise.allSettled([20, 80].map(progress => update(owner, project.id, { version: 1, progress })))
      const winners = results.filter(result => result.status === 'fulfilled')
      const losers = results.filter(result => result.status === 'rejected')
      expect(winners).toHaveLength(1)
      expect(losers).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'conflict' }) })])
      const saved = await runtime.transaction(context, data => data.projects.get(project.id))
      expect(saved).toMatchObject({ version: 2, progress: events[0]!.payload.progress })
      expect(events).toHaveLength(1)
      // 在真实 UPDATE 后注入外层事务故障，确保回滚版本与字段且不发布成功事件。
      const failing = createProjectUpdater({
        transaction: work => runtime.db.transaction().execute(async tx => {
          await work(createKyselyProjectUpdateTransaction(tx, runtime.backend, owner))
          throw new Error('合成提交前故障')
        }),
        async renameProjectDirectory() {}, async getFileCount() { return 0 },
        async publishProjectUpdated(event) { events.push(event) },
      })
      await expect(failing(owner, project.id, { version: 2, progress: 50 })).rejects.toThrow('合成提交前故障')
      expect(await runtime.transaction(context, data => data.projects.get(project.id))).toEqual(saved)
      expect(events).toHaveLength(1)
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
