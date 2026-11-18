import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createClientTools, createClientDeletePort, createClientDeleteTool, type ClientDeleteConfirmationPort } from '../../../src/agent/tools/clients.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolResult } from '../../../src/agent/models.js'
import { expectedBusinessError } from './error-fixtures.js'

let folder: string, runtime: SqlDataRuntime, ownerId: string
let registry: ReturnType<typeof createToolRegistry>
async function call(name: string, input: unknown, owner = ownerId) {
  return registry.tools.dispatch({ name, input, id: randomUUID() }, { identity: { ownerId: owner, sessionId: '1', runId: randomUUID() }, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null })
}
function value(result: ToolResult): any {
  if (result.kind !== 'completed') throw new Error('工具未完成')
  return typeof result.value === 'string' ? JSON.parse(result.value) : result.value
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-tools-clients-'))
  const path = join(folder, 'core.db')
  await initializeSqlite(path)
  const opened = await openSqliteRuntime(path)
  runtime = opened.runtime; ownerId = opened.ownerId
  registry = createToolRegistry({ tools: createClientTools(runtime), authorize: async () => true })
})
afterEach(async () => { await runtime?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

describe('联系人真实注册器与临时 SQLite 行为', () => {
  it('创建、更新空字段并重新读取实际持久化结果', async () => {
    const created = value(await call('create_client', { client_name: '小北', notes: '初始备注', phone: '123' }))
    expect(created).toMatchObject({ success: true, name: '小北' })
    expect(value(await call('update_client', { client_id: created.client_id, notes: '', phone: '' }))).toMatchObject({ success: true })
    expect(value(await call('list_clients', {}))).toEqual([{ id: created.client_id, name: '小北', contact: null, email: null, phone: '', notes: '' }])
  })
  it('跨 owner 的 ID 与名称均不可查询更新，也不会泄露候选', async () => {
    const row = value(await call('create_client', { client_name: '小北' }))
    const other = randomUUID()
    expect(value(await call('list_clients', {}, other))).toEqual([])
    expect(value(await call('update_client', { client_id: row.client_id, notes: '攻击' }, other))).toEqual(expectedBusinessError('update_client', '联系人不存在'))
    expect(value(await call('update_client', { client: '小北', notes: '攻击' }, other))).toEqual(expectedBusinessError('update_client', '未找到联系人「小北」'))
    expect(value(await call('list_clients', {}))[0].notes).toBe('')
  })
  it('精确匹配优先，模糊歧义返回候选且不改动', async () => {
    const a = value(await call('create_client', { client_name: '小北' }))
    await call('create_client', { client_name: '小北同学' })
    expect(value(await call('update_client', { client: '小北', notes: '精确' }))).toMatchObject({ client_id: a.client_id })
    const ambiguous = value(await call('update_client', { client: '北', notes: '错误写入' }))
    expect(ambiguous.error).toBe('有多个匹配「北」的联系人，请指明')
    expect(ambiguous.candidates).toHaveLength(2)
    expect(value(await call('list_clients', {})).map((row: any) => row.notes).sort()).toEqual(['', '精确'])
  })
  it('名称查询剥离Python C0空白但保留BOM，创建名称保持原字面存储', async () => {
    const plain = value(await call('create_client', { client_name: '小北' }))
    const bom = value(await call('create_client', { client_name: '\ufeff小北' }))
    const spacedName = '\u001c创建原名\u001f'
    const spaced = value(await call('create_client', { client_name: spacedName }))
    expect(spaced.name).toBe(spacedName)
    expect(value(await call('update_client', { client: '\u001c小北\u001f', notes: 'C0匹配' })))
      .toMatchObject({ success: true, client_id: plain.client_id })
    expect(value(await call('update_client', { client: '\ufeff小北', notes: 'BOM匹配' })))
      .toMatchObject({ success: true, client_id: bom.client_id })
    const rows = value(await call('list_clients', {}))
    expect(rows.find((row: any) => row.id === plain.client_id)).toMatchObject({ name: '小北', notes: 'C0匹配' })
    expect(rows.find((row: any) => row.id === bom.client_id)).toMatchObject({ name: '\ufeff小北', notes: 'BOM匹配' })
    expect(rows.find((row: any) => row.id === spaced.client_id).name).toBe(spacedName)
  })
  it('反斜线和下划线匹配遵循SQLite原生LIKE，更新只影响真实匹配目标', async () => {
    const underscore = value(await call('create_client', { client_name: 'a_b' }))
    const backslash = value(await call('create_client', { client_name: 'a\\xb' }))
    const result = value(await call('update_client', { client: 'a\\_b', notes: '原生LIKE命中' }))
    expect(result).toMatchObject({ success: true, client_id: backslash.client_id, name: 'a\\xb' })
    const rows = value(await call('list_clients', {}))
    expect(rows.find((row: any) => row.id === backslash.client_id).notes).toBe('原生LIKE命中')
    expect(rows.find((row: any) => row.id === underscore.client_id).notes).toBe('')
    const other = randomUUID()
    expect(value(await call('update_client', { client: 'a\\_b', notes: '越权不能更新' }, other)))
      .toEqual(expectedBusinessError('update_client', '未找到联系人「a\\_b」'))
    expect(value(await call('list_clients', {})).find((row: any) => row.id === backslash.client_id).notes).toBe('原生LIKE命中')
  })
  it('Unicode名称查询保持SQLite精确优先与ASCII lower，不使用JS Unicode casefold', async () => {
    const exact = value(await call('create_client', { client_name: 'Ä' }))
    const upper = value(await call('create_client', { client_name: 'Ä北' }))
    const lower = value(await call('create_client', { client_name: 'ä北' }))
    expect(value(await call('update_client', { client: 'Ä', notes: '精确优先' })))
      .toMatchObject({ success: true, client_id: exact.client_id })
    expect(value(await call('update_client', { client: 'ä', notes: '小写仅匹配自身' })))
      .toMatchObject({ success: true, client_id: lower.client_id })
    const rows = value(await call('list_clients', {}))
    expect(rows.find((row: any) => row.id === exact.client_id).notes).toBe('精确优先')
    expect(rows.find((row: any) => row.id === upper.client_id).notes).toBe('')
    expect(rows.find((row: any) => row.id === lower.client_id).notes).toBe('小写仅匹配自身')
  })
  it('通配歧义候选限制十项且不写入', async () => {
    for (let n = 0; n < 12; n++) await call('create_client', { client_name: `同学${n}` })
    const result = value(await call('update_client', { client: '%', notes: '不应写入' }))
    expect(result.candidates).toHaveLength(10)
    expect(value(await call('list_clients', {})).every((row: any) => row.notes === '')).toBe(true)
  })
  it('无修改字段、空名称和非法类型均明确失败，不声称成功', async () => {
    const row = value(await call('create_client', { client_name: '小北' }))
    const definition = (await registry.capabilities({ ownerId, sessionId: '1', runId: 'schema' })).find(item => item.name === 'update_client')
    expect((definition?.schema.function as any).parameters.properties.client_ids.uniqueItems).toBe(true)
    expect(value(await call('update_client', { client_id: row.client_id }))).toEqual(expectedBusinessError('update_client', '没提供要修改的字段（client_name/contact/email/phone/notes），未改动。'))
    expect(value(await call('create_client', { client_name: '' }))).toEqual(expectedBusinessError('create_client', '联系人名称必填'))
    expect(await call('update_client', { client_id: row.client_id, client_ids: [row.client_id, row.client_id], notes: '不得写入' })).toMatchObject({ successful: false, executed: false })
    expect(await call('create_client', { client_name: true })).toMatchObject({ successful: false, executed: false })
    expect(await call('update_client', { client_id: row.client_id, client_name: ' ' })).toMatchObject({ successful: false, mutated: false })
    expect(value(await call('list_clients', {}))).toHaveLength(1)
  })
})

it('Harness 经真实注册器完成联系人创建和后续列表读取再提交终态', async () => {
  const { fixture, collect } = await import('../run/fixtures.js')
  const f = fixture([
    [{ type: 'complete', text: '', calls: [{ id: 'create', name: 'create_client', input: { client_name: '小北' } }] }],
    [{ type: 'complete', text: '', calls: [{ id: 'list', name: 'list_clients', input: {} }] }],
    [{ type: 'complete', text: '已创建联系人', calls: [] }],
  ])
  f.ports.tools = registry.tools
  const results: ToolResult[] = []
  f.ports.context.afterTool = async (context, _call, result) => { results.push(result); return context }
  const run = await collect(f.harness.start({ ownerId, sessionId: '1', runId: randomUUID() }))
  expect(run.state.status).toBe('completed')
  expect(results.map(value)).toMatchObject([{ success: true, name: '小北' }, [{ name: '小北' }]])
  expect(value(await call('list_clients', {}))).toHaveLength(1)
})

import { CoreError, dataContext } from '../../../src/contracts/index.js'
import { ClientService } from '../../../src/clients/service.js'
import { ClientValidationError } from '../../../src/clients/service.js'

function uncertainAttempt(name: string, input: unknown) {
  const toolCall = { id: randomUUID(), name, input }
  const identity = { ownerId, sessionId: '1', runId: randomUUID() }
  const scope = { identity, roundId: 'round-uncertain', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
  return { toolCall, scope, run: () => registry.tools.dispatch(toolCall, scope) }
}

describe('联系人事务结果不确定时不伪装为字段失败', () => {
  it('提交后即使抛字段同名类型也必须保持unknown且不可重放', async () => {
    const original = runtime.transaction.bind(runtime)
    const attempt = uncertainAttempt('create_client', { client_name: '合成联系人' })
    const spy = vi.spyOn(runtime, 'transaction').mockImplementationOnce(async (context, work, options) => {
      await original(context, work, options)
      throw new ClientValidationError('合成提交错误')
    })
    try {
      expect(await attempt.run()).toEqual({ kind: 'unknown' })
      expect(await registry.tools.reconcile(attempt.toolCall, { ...attempt.scope.identity, roundId: attempt.scope.roundId })).toEqual({ kind: 'unknown' })
      expect(await original(dataContext(ownerId), data => data.clients.list())).toHaveLength(1)
    } finally { spy.mockRestore() }
  })
  it.each(['create_client', 'update_client'])('%s提交成功后runtime抛invalid_request仍unknown，reconcile不重放', async name => {
    const original = runtime.transaction.bind(runtime)
    const before = name === 'update_client' ? value(await call('create_client', { client_name: '小北', notes: '原备注' })) : null
    const input = name === 'create_client' ? { client_name: '提交成功联系人', notes: '已提交备注' } : { client_id: before.client_id, notes: '已提交备注' }
    const attempt = uncertainAttempt(name, input)
    let committed = 0
    const mutation = vi.spyOn(ClientService.prototype, name === 'create_client' ? 'create' : 'update')
    const spy = vi.spyOn(runtime, 'transaction').mockImplementationOnce(async (context, work, options) => {
      await original(context, work, options)
      committed++
      throw new CoreError('invalid_request', '合成提交响应丢失')
    })
    try {
      expect(await attempt.run()).toEqual({ kind: 'unknown' })
      expect(committed).toBe(1)
      const rows = await original(dataContext(ownerId), data => data.clients.list())
      expect(rows).toHaveLength(1)
      expect(rows[0]!.notes).toBe('已提交备注')
      expect(rows[0]!.name).toBe(name === 'create_client' ? '提交成功联系人' : '小北')
      expect(await registry.tools.reconcile(attempt.toolCall, { ...attempt.scope.identity, roundId: attempt.scope.roundId })).toEqual({ kind: 'unknown' })
      expect(mutation).toHaveBeenCalledTimes(1)
      expect(committed).toBe(1)
      expect(await original(dataContext(ownerId), data => data.clients.list())).toEqual(rows)
    } finally { spy.mockRestore(); mutation.mockRestore() }
  })
  it.each(['create_client', 'update_client'])('%s事务开始前runtime抛invalid_request也unknown且不写入', async name => {
    const original = runtime.transaction.bind(runtime)
    const before = value(await call('create_client', { client_name: '小北', notes: '未改变备注' }))
    const input = name === 'create_client' ? { client_name: '不得创建', notes: '不得保存' } : { client_id: before.client_id, notes: '不得保存' }
    const saved = await original(dataContext(ownerId), data => data.clients.list())
    const attempt = uncertainAttempt(name, input)
    const mutation = vi.spyOn(ClientService.prototype, name === 'create_client' ? 'create' : 'update')
    const spy = vi.spyOn(runtime, 'transaction').mockRejectedValueOnce(new CoreError('invalid_request', '合成事务入口故障'))
    try {
      expect(await attempt.run()).toEqual({ kind: 'unknown' })
      expect(await original(dataContext(ownerId), data => data.clients.list())).toEqual(saved)
      expect(await registry.tools.reconcile(attempt.toolCall, { ...attempt.scope.identity, roundId: attempt.scope.roundId })).toEqual({ kind: 'unknown' })
      expect(mutation).not.toHaveBeenCalled()
      expect(await original(dataContext(ownerId), data => data.clients.list())).toEqual(saved)
    } finally { spy.mockRestore(); mutation.mockRestore() }
  })
  it('事务callback内真实字段校验失败仍明确失败，不创建或覆盖持久数据', async () => {
    const created = value(await call('create_client', { client_name: '小北', notes: '需保留' }))
    const saved = await runtime.transaction(dataContext(ownerId), data => data.clients.list())
    expect(await call('create_client', { client_name: ' ' })).toMatchObject({ kind: 'completed', successful: false, mutated: false,
      modelValue: { error: '工具 create_client 执行出错：ValueError: 联系人名称不能为空', tool: 'create_client', usage_hint: expect.any(String), next_action: expect.any(String) } })
    expect(await call('update_client', { client_id: created.client_id, client_name: ' ', notes: '不得覆盖' })).toMatchObject({ kind: 'completed', successful: false, mutated: false,
      modelValue: { error: '工具 update_client 执行出错：ValueError: 联系人名称不能为空', tool: 'update_client', usage_hint: expect.any(String), next_action: expect.any(String) } })
    for (const input of [{ client_name: 'x'.repeat(201) }, { client_name: '合成', email: 'x'.repeat(301) }, { client_name: '合成', phone: 'x'.repeat(51) }]) {
      expect(await call('create_client', input)).toMatchObject({ successful: false, mutated: false,
        modelValue: { error: '工具 create_client 执行出错：ValueError: 联系人字段超过长度限制' } })
    }
    expect(await runtime.transaction(dataContext(ownerId), data => data.clients.list())).toEqual(saved)
  })
})

describe('delete_client 经真实 Core 注册器与临时 SQLite 执行', () => {
  function deleteRegistry(options: { claim?: boolean; duringClaim?: (tx: Parameters<ClientDeleteConfirmationPort['claim']>[0]) => Promise<void> } = {}) {
    let preparedDigest: string | null = null, preparedTargets: unknown = null, claims = 0
    const gate = {
      async prepare(toolCall: any, _scope: unknown, inputDigest: string, targets: unknown) {
        preparedDigest = inputDigest; preparedTargets = structuredClone(targets)
        return { ok: true as const, value: { id: 'confirm-delete-client', kind: 'confirmation' as const, toolCall } }
      },
      async verify(_toolCall: any, _scope: unknown, inputDigest: string, targets: unknown) {
        return preparedDigest === inputDigest && JSON.stringify(preparedTargets) === JSON.stringify(targets)
          ? { ok: true as const, value: { intentId: 'intent', operationId: 'operation' } }
          : { ok: false as const, code: 'confirmation_rejected' as const }
      },
    } as unknown as ClientDeleteConfirmationPort['gate']
    const confirmation: ClientDeleteConfirmationPort = {
      gate,
      async claim(tx) { claims++; await options.duringClaim?.(tx); return options.claim ?? true },
    }
    return { registry: createToolRegistry({ tools: [...createClientTools(runtime), createClientDeleteTool(createClientDeletePort(runtime, confirmation))], authorize: async () => true }), claims: () => claims }
  }
  const deleteScope = (owner = ownerId, confirmed = false) => ({
    identity: { ownerId: owner, sessionId: '1', runId: 'delete-client-run' }, roundId: 'delete-round',
    signal: new AbortController().signal, execute: vi.fn(), resolution: confirmed
      ? { interactionId: 'confirm-delete-client', receiptId: 'trusted-receipt', status: 'confirmed' as const, value: { confirm: true, targets: [999] } }
      : null,
  })

  it('联系人名候选经可信确认冻结；确认后只删除精确owner目标并产生正确单项/批量结果', async () => {
    const first = value(await call('create_client', { client_name: '小北' }))
    const second = value(await call('create_client', { client_name: '小南' }))
    const f = deleteRegistry()
    const toolCall = { id: 'delete-one', name: 'delete_client', input: { client: '小北', confirm: true, targets: [999] } }
    const waiting = await f.registry.tools.dispatch(toolCall, deleteScope())
    expect(waiting).toMatchObject({ kind: 'waiting' })
    expect(value(await call('list_clients', {}))).toHaveLength(2)
    const deleted = await f.registry.tools.dispatch(toolCall, deleteScope(ownerId, true))
    expect(deleted).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { success: true, deleted_client_id: first.client_id, name: '小北' } })
    expect(value(await call('list_clients', {}))).toEqual([expect.objectContaining({ id: second.client_id, name: '小南' })])
    expect(f.claims()).toBe(1)
  })

  it('批量候选先按ID排序，空集合、缺失目标与跨owner目标均无副作用', async () => {
    const first = value(await call('create_client', { client_name: '甲' }))
    const second = value(await call('create_client', { client_name: '乙' }))
    const f = deleteRegistry()
    const callBatch = { id: 'delete-batch', name: 'delete_client', input: { client_ids: [second.client_id, first.client_id] } }
    expect(await f.registry.tools.dispatch({ ...callBatch, input: { client_ids: [] } }, deleteScope()))
      .toMatchObject({ kind: 'completed', successful: false, mutated: false, value: { error: 'client_ids 必须是 1-50 个联系人 id' } })
    expect(await f.registry.tools.dispatch({ ...callBatch, input: { client_ids: [first.client_id, 999] } }, deleteScope()))
      .toMatchObject({ kind: 'completed', successful: false, mutated: false, value: { error: '联系人 999 不存在' } })
    expect(await f.registry.tools.dispatch({ ...callBatch, input: { client_id: first.client_id } }, deleteScope(randomUUID())))
      .toMatchObject({ kind: 'completed', successful: false, mutated: false, value: { error: '联系人不存在' } })
    expect(await f.registry.tools.dispatch(callBatch, deleteScope())).toMatchObject({ kind: 'waiting' })
    expect(await f.registry.tools.dispatch(callBatch, deleteScope(ownerId, true))).toMatchObject({
      kind: 'completed', successful: true, mutated: true, value: { success: true, deleted_count: 2, results: [
        { deleted_client_id: first.client_id, name: '甲' }, { deleted_client_id: second.client_id, name: '乙' },
      ] },
    })
    expect(value(await call('list_clients', {}))).toEqual([])
  })

  it('client_id=0 依旧按旧版 truthy 规则回退到联系人名', async () => {
    await call('create_client', { client_name: '回退联系人' })
    const f = deleteRegistry()
    const input = { id: 'delete-zero-id', name: 'delete_client', input: { client_id: 0, client: '回退联系人' } }
    expect(await f.registry.tools.dispatch(input, deleteScope())).toMatchObject({ kind: 'waiting' })
    expect(await f.registry.tools.dispatch(input, deleteScope(ownerId, true))).toMatchObject({ kind: 'completed', successful: true,
      value: { success: true, name: '回退联系人' } })
    expect(value(await call('list_clients', {}))).toEqual([])
  })

  it('确认等待期间目标改变或事务claim拒绝时回滚，不删除其他版本', async () => {
    const client = value(await call('create_client', { client_name: '原联系人' }))
    const changed = deleteRegistry({ duringClaim: async tx => {
      await sql`UPDATE clients SET name='并发改名' WHERE id=${client.client_id}`.execute(tx)
    } })
    const input = { id: 'delete-change', name: 'delete_client', input: { client_id: client.client_id } }
    expect(await changed.registry.tools.dispatch(input, deleteScope())).toMatchObject({ kind: 'waiting' })
    expect(await changed.registry.tools.dispatch(input, deleteScope(ownerId, true))).toMatchObject({ kind: 'completed', successful: false, mutated: false,
      value: { error: '联系人删除确认已使用或目标已变化' } })
    expect(value(await call('list_clients', {}))).toMatchObject([{ id: client.client_id, name: '原联系人' }])
    const denied = deleteRegistry({ claim: false })
    const next = { id: 'delete-claim-denied', name: 'delete_client', input: { client_id: client.client_id } }
    expect(await denied.registry.tools.dispatch(next, deleteScope())).toMatchObject({ kind: 'waiting' })
    expect(await denied.registry.tools.dispatch(next, deleteScope(ownerId, true))).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    expect(value(await call('list_clients', {}))).toMatchObject([{ id: client.client_id, name: '原联系人' }])
  })
})

describe('联系人写入的可信身份快照与真实SQLite隔离', () => {
  it('等待授权时修改调用方原身份不能改变执行owner或越权更新另一owner联系人', async () => {
    const otherOwner = randomUUID()
    const clientA = value(await call('create_client', { client_name: '小北', notes: 'A初始' }))
    const clientB = value(await call('create_client', { client_name: '小南', notes: 'B初始' }, otherOwner))
    async function attempt(clientId: number, notes: string) {
      let entered!: () => void
      let release!: () => void
      const authorizing = new Promise<void>(resolve => { entered = resolve })
      const proceed = new Promise<void>(resolve => { release = resolve })
      // 授权服务是受控替身；联系人查询/更新与owner隔离走真实Core SQLite适配器。
      const localRegistry = createToolRegistry({ tools: createClientTools(runtime), authorize: async trustedIdentity => {
        const authorizedOwner = trustedIdentity.ownerId
        entered()
        await proceed
        return authorizedOwner === ownerId
      } })
      const originalIdentity = { ownerId, sessionId: '可信会话', runId: '可信运行' }
      const originalScope = { identity: originalIdentity, roundId: '可信轮次', signal: new AbortController().signal,
        execute: vi.fn(), resolution: null }
      const pending = localRegistry.tools.dispatch({ id: randomUUID(), name: 'update_client', input: { client_id: clientId, notes } }, originalScope)
      await authorizing
      originalIdentity.ownerId = otherOwner
      originalIdentity.sessionId = '后改会话'
      originalIdentity.runId = '后改运行'
      originalScope.roundId = '后改轮次'
      release()
      return pending
    }
    expect(value(await attempt(clientA.client_id, 'A合法更新'))).toMatchObject({ success: true, client_id: clientA.client_id })
    expect(value(await call('list_clients', {}))).toEqual([expect.objectContaining({ id: clientA.client_id, notes: 'A合法更新' })])
    expect(value(await call('list_clients', {}, otherOwner))).toEqual([expect.objectContaining({ id: clientB.client_id, notes: 'B初始' })])
    // 重新建立A的原始身份，再尝试指向B记录；授权后原对象被改成B仍应按A拒绝。
    expect(value(await attempt(clientB.client_id, '越权写入'))).toEqual(expectedBusinessError('update_client', '联系人不存在'))
    expect(value(await call('list_clients', {}, otherOwner))).toEqual([expect.objectContaining({ id: clientB.client_id, notes: 'B初始' })])
    expect(value(await call('list_clients', {}))).toEqual([expect.objectContaining({ id: clientA.client_id, notes: 'A合法更新' })])
  })
})
