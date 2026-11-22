import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoreError } from '../../../src/contracts/index.js'
import { createProjectCreator } from '../../../src/projects/project-create.js'
import type { ProjectCreateRuntime } from '../../../src/projects/project-create.js'
import { createKyselyProjectCreateRuntime } from '../../../src/projects/create-store.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { agentProjectDispatchKey, createProjectCreationPort, createAgentProjectCreator } from '../../../src/agent/tools/projects/creation-port.js'
import { createProjectTool } from '../../../src/agent/tools/projects.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { createOwnerToolRegistry } from '../../../src/agent/tools/owner.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'
import { DEFAULT_PROJECT_COLOR, PROJECT_COLOR_PRESETS } from '../../../src/projects/colors.js'
import { collect, fixture } from '../run/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const args = { project_name: '新项目', start_date: '2026-11-14', deadline: '2026-11-30' }
async function setup(wrap?: (runtime: ProjectCreateRuntime) => ProjectCreateRuntime) {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-agent-project-'))
  cleanups.push(() => rm(folder, { recursive: true, force: true }))
  const filename = join(folder, 'core.db')
  await initializeSqlite(filename)
  const { runtime: core, ownerId } = await openSqliteRuntime(filename)
  cleanups.push(() => core.close())
  const publish = vi.fn(async () => {})
  const runtime = createKyselyProjectCreateRuntime({ db: core.db, backend: 'sqlite', publishProjectCreated: publish })
  const registry = createOwnerToolRegistry({ core, projects: wrap ? wrap(runtime) : runtime, authorize: async () => true })
  const scope: ToolScope = { identity: { ownerId, sessionId: '1', runId: 'run-a' }, roundId: 'round-a', signal: new AbortController().signal, resolution: null, execute: vi.fn() }
  const call = { id: 'call-a', name: 'create_project', input: args }
  return { core, ownerId, runtime, registry, scope, call, publish,
    rows: () => core.db.selectFrom('projects').selectAll().orderBy('id').execute(),
  }
}

it('owner 注册表拒绝已退役的文件工具调用', async () => {
  const { registry, scope } = await setup()
  expect(registry.catalog().map(tool => tool.name)).not.toContain('read_file')
  await expect(registry.tools.dispatch({ id: 'read', name: 'read_file', input: { file_id: 1 } }, scope))
    .resolves.toMatchObject({ successful: false, executed: false })
})

describe('真实SQLite项目创建经ToolRegistry与Core应用/数据适配器', () => {
  it.each([null, 42])('旧直接入口非字符串颜色%j仍使用既有默认色', async color => {
    const f = await setup()
    const direct = createAgentProjectCreator(f.runtime)
    expect(await direct(f.ownerId, { ...args, color }, { idempotencyKey: null })).toMatchObject({ success: true })
    expect((await f.rows())[0]?.color).toBe(DEFAULT_PROJECT_COLOR)
    expect(await f.registry.tools.dispatch({ ...f.call, input: { ...args, color } }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(await f.rows()).toHaveLength(1)
  })
  it('事务读取颜色时收到取消，在插入前回滚且不创建项目', async () => {
    const controller = new AbortController()
    const f = await setup(runtime => ({ ...runtime,
      transaction: work => runtime.transaction(tx => work({ ...tx,
        async listActiveColors(owner) {
          const colors = await tx.listActiveColors!(owner)
          controller.abort()
          return colors
        },
      })),
    }))
    expect(await f.registry.tools.dispatch(f.call, { ...f.scope, signal: controller.signal })).toMatchObject({ successful: false, mutated: false })
    expect(await f.rows()).toHaveLength(0)
  })
  it('旧直接入口共用业务映射与大小写优先级，不能放宽正式工具身份', async () => {
    const f = await setup()
    const direct = createAgentProjectCreator(f.runtime)
    expect(await direct(f.ownerId, { ...args, priority: ' HIGH ' }, { idempotencyKey: null })).toMatchObject({ success: true })
    expect(await direct(f.ownerId, { ...args, priority: '无效历史优先级' }, { idempotencyKey: null })).toMatchObject({ success: true })
    const rows = await f.rows()
    expect(rows.map(row => row.priority)).toEqual(['high', null])
    expect(await direct(f.ownerId, { ...args, status: null }, { idempotencyKey: null })).toMatchObject({ success: false })
    expect(await f.registry.tools.dispatch(f.call, { ...f.scope, roundId: '' })).toMatchObject({ successful: false, mutated: false })
    expect(await f.rows()).toHaveLength(2)
  })
  it('真实Harness工具轮经共享创建用例持久化并完成回复', async () => {
    const f = await setup()
    const h = fixture([[{ type: 'complete', text: '', calls: [f.call] }], [{ type: 'complete', text: '项目已创建。', calls: [] }]])
    h.ports.tools = f.registry.tools
    const result = await collect(h.harness.start(f.scope.identity))
    expect(result.state.status).toBe('completed')
    expect(result.events.find(event => event.type === 'tool_done')).toMatchObject({ payload: { status: 'success' } })
    expect(await f.rows()).toHaveLength(1)
    expect((await f.rows())[0]?.name).toBe(args.project_name)
  })
  it('缺省颜色仅选owner未用池，显式颜色保持不变', async () => {
    const f = await setup()
    const seed = createProjectCreator(f.runtime)
    for (const [index, color] of PROJECT_COLOR_PRESETS.slice(0, 7).entries()) await seed(f.ownerId, { name: `已有项目${index}`, color })
    // 别的owner使用最后一色，不应影响当前owner未用颜色池。
    await seed(randomUUID(), { name: '其他用户项目', color: PROJECT_COLOR_PRESETS[7] })
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true, mutated: true })
    expect((await f.rows()).at(-1)?.color).toBe(PROJECT_COLOR_PRESETS[7])
    expect(await f.registry.tools.dispatch({ ...f.call, id: 'explicit', input: { ...args, color: 'teal' } }, f.scope)).toMatchObject({ successful: true })
    expect((await f.rows()).at(-1)?.color).toBe(PROJECT_COLOR_PRESETS[2])
  })
  it('默认阶段及摘要优先级持久化，自定义阶段todos保留', async () => {
    const f = await setup()
    expect(await f.registry.tools.dispatch({ ...f.call, input: { ...args, summary: '摘要', priority: 'high' } }, f.scope)).toMatchObject({
      successful: true, value: { stages: ['计划', '执行', '交付'], current_stage: 's0' },
    })
    const first = (await f.rows())[0]!
    expect(first).toMatchObject({ summary: '摘要', priority: 'high', current_stage: 's0', status: 'pending' })
    expect(JSON.parse(first.stages_json)).toMatchObject([{ key: 's0', label: '计划', todos: [] }, { key: 's1', label: '执行' }, { key: 's2', label: '交付' }])
    expect(await f.registry.tools.dispatch({ ...f.call, id: 'custom', input: { ...args, stages: [{ label: '设计', todos: ['草图', '复核'] }, '交付'] } }, f.scope)).toMatchObject({ successful: true, value: { stage_details: [{ key: 's0', label: '设计', todo_count: 2 }, { key: 's1', label: '交付', todo_count: 0 }] } })
    const custom = (await f.rows())[1]!
    expect(JSON.parse(custom.stages_json)[0].todos).toMatchObject([{ text: '草图', done: false }, { text: '复核', done: false }])
    expect(await f.core.db.selectFrom('undo_operations').selectAll().execute()).toHaveLength(0)
    expect(f.publish).not.toHaveBeenCalled()
  })
  it('同scope重放一次，不同run/round同call独立创建且owner隔离', async () => {
    const f = await setup()
    const first = await f.registry.tools.dispatch(f.call, f.scope)
    expect(first).toMatchObject({ successful: true, mutated: true })
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true, mutated: false, value: { idempotent_replay: true } })
    expect(await f.rows()).toHaveLength(1)
    expect(await f.registry.tools.dispatch({ ...f.call, input: { ...args, project_name: '变更内容' } }, f.scope)).toMatchObject({ successful: false, mutated: false, value: { error_code: 'conflict' },
      modelValue: { error: '该 Idempotency-Key 已用于不同的创建内容', tool: 'create_project', usage_hint: expect.any(String), next_action: expect.any(String) } })
    for (const changed of [{ ...args, deadline: '2026-02-31' }, { ...args, stages: [' '] }]) {
      expect(await f.registry.tools.dispatch({ ...f.call, input: changed }, f.scope)).toMatchObject({ successful: false, mutated: false,
        value: { error_code: 'conflict' }, modelValue: { error: '该 Idempotency-Key 已用于不同的创建内容' } })
    }
    expect(await f.rows()).toHaveLength(1)
    await f.registry.tools.dispatch(f.call, { ...f.scope, identity: { ...f.scope.identity, runId: 'run-b' } })
    await f.registry.tools.dispatch(f.call, { ...f.scope, roundId: 'round-b' })
    // 与第一个owner使用相同编码键，必须依赖真实数据适配器的owner限定。
    const other = randomUUID()
    expect(await f.registry.tools.dispatch(f.call, { ...f.scope, identity: { ...f.scope.identity, ownerId: other } })).toMatchObject({ successful: true, mutated: true })
    const rows = await f.rows()
    expect(rows).toHaveLength(4)
    expect(rows.filter(row => row.user_id === f.ownerId.replaceAll('-', ''))).toHaveLength(3)
    expect(rows.filter(row => row.user_id === other.replaceAll('-', ''))).toHaveLength(1)
  })
  it('共享注册器重用已有调用键，并拒绝非规范会话标识', async () => {
    const f = await setup()
    const direct = createAgentProjectCreator(f.runtime)
    const key = agentProjectDispatchKey({ sessionId: 1, runId: f.scope.identity.runId, roundId: f.scope.roundId, toolCallId: f.call.id })
    const previous = await direct(f.ownerId, args, { idempotencyKey: key })
    expect(previous).toMatchObject({ success: true })
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({
      successful: true, mutated: false, value: { idempotent_replay: true },
    })
    for (const sessionId of ['01', '1e0', '9007199254740992']) {
      expect(await f.registry.tools.dispatch(f.call, { ...f.scope, identity: { ...f.scope.identity, sessionId } }))
        .toMatchObject({ successful: false, mutated: false, value: { error_code: 'invalid_request' } })
    }
    expect(await f.rows()).toHaveLength(1)
  })
  it('字段领域错误保留内部错误码，并向模型输出单层增强对象且不写入', async () => {
    const f = await setup()
    const result = await f.registry.tools.dispatch({ ...f.call, input: { ...args, deadline: '2026-02-31' } }, f.scope)
    expect(result).toMatchObject({ kind: 'completed', successful: false, mutated: false,
      value: { success: false, error_code: 'invalid_request' }, modelValue: { tool: 'create_project' } })
    if (result.kind !== 'completed') throw new Error('预期已完成的字段错误')
    expect(result.value).not.toHaveProperty('modelFailure')
    expect(result.modelValue).toEqual({ error: expect.any(String), tool: 'create_project', usage_hint: expect.any(String), next_action: expect.any(String) })
    expect(await f.rows()).toHaveLength(0)
  })
  it('可信模型错误投影先脱敏，不改变内部原结果', async () => {
    const tool = createProjectTool({ create: async () => ({ success: false, error: 'token=synthetic_secret_123456789', error_code: 'invalid_request', modelFailure: 'validation' }) })
    const registry = createToolRegistry({ tools: [tool], authorize: async () => true })
    const f = await setup()
    const result = await registry.tools.dispatch(f.call, f.scope)
    expect(result).toMatchObject({ kind: 'completed', value: { error_code: 'invalid_request' }, modelValue: { error: '‹密钥已隐藏›' } })
    if (result.kind === 'completed') expect(JSON.stringify(result.modelValue)).not.toContain('synthetic_secret_123456789')
  })
  it('真实提交后抛异常返回unknown，reconcile不再次写入', async () => {
    const f = await setup(runtime => ({ ...runtime, transaction: async work => { await runtime.transaction(work); throw new Error('synthetic-private-commit-error') } }))
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toEqual({ kind: 'unknown' })
    expect(await f.rows()).toHaveLength(1)
    expect(await f.registry.tools.reconcile(f.call, { ...f.scope.identity, roundId: f.scope.roundId })).toEqual({ kind: 'unknown' })
    expect(await f.rows()).toHaveLength(1)
  })
  it('预取消不创建，提交后取消不抹去真实成功', async () => {
    const controller = new AbortController()
    const f = await setup(runtime => ({ ...runtime, transaction: async work => { const result = await runtime.transaction(work); controller.abort(); return result } }))
    const cancelled = new AbortController(); cancelled.abort()
    await expect(f.registry.tools.dispatch(f.call, { ...f.scope, signal: cancelled.signal })).rejects.toThrow()
    expect(await f.rows()).toHaveLength(0)
    expect(await f.registry.tools.dispatch(f.call, { ...f.scope, signal: controller.signal })).toMatchObject({ successful: true, mutated: true })
    expect(await f.rows()).toHaveLength(1)
  })
})


describe('真实SQLite创建事务错误归属边界', () => {
  it.each(['invalid_request', 'conflict'] as const)('真实COMMIT后runtime抛CoreError %s必须unknown，显式幂等重读不重复', async code => {
    let failOnce = true
    const f = await setup(runtime => ({ ...runtime, transaction: async work => {
      const result = await runtime.transaction(work)
      if (failOnce) { failOnce = false; throw new CoreError(code, '合成事务响应丢失') }
      return result
    } }))
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toEqual({ kind: 'unknown' })
    const persisted = await f.rows()
    expect(persisted).toHaveLength(1)
    const id = persisted[0]!.id
    expect(await f.registry.tools.reconcile(f.call, { ...f.scope.identity, roundId: f.scope.roundId })).toEqual({ kind: 'unknown' })
    expect(await f.rows()).toHaveLength(1)
    // 用户/恢复路径显式选择使用同一幂等键重读；reconcile自身不能重新dispatch。
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true, mutated: false,
      value: { project_id: id, idempotent_replay: true } })
    expect(await f.rows()).toHaveLength(1)
  })
  it.each(['invalid_request', 'conflict'] as const)('runtime在callback前抛CoreError %s也不能冒充业务拒绝', async code => {
    const f = await setup(runtime => ({ ...runtime, transaction: async () => { throw new CoreError(code, '合成事务启动错误') } }))
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toEqual({ kind: 'unknown' })
    expect(await f.rows()).toHaveLength(0)
  })
  it('真实事务callback业务CoreError明确拒绝，插入之前回滚', async () => {
    const f = await setup(runtime => ({ ...runtime, transaction: work => runtime.transaction(tx => work({ ...tx,
      insertProject: async () => { throw new CoreError('invalid_request', '合成项目字段拒绝') },
    })) }))
    const result = await f.registry.tools.dispatch(f.call, f.scope)
    expect(result).toMatchObject({ successful: false, mutated: false,
      value: { error: '合成项目字段拒绝', error_code: 'invalid_request' } })
    expect(result).not.toHaveProperty('modelValue')
    expect(await f.rows()).toHaveLength(0)
  })
  it('keyForCall进入共享创建前抛业务CoreError保持明确拒绝且不写', async () => {
    const f = await setup()
    const registry = createToolRegistry({ authorize: async () => true, tools: [createProjectTool(createProjectCreationPort({ runtime: f.runtime,
      keyForCall() { throw new CoreError('invalid_request', '合成平台调用标识无效') },
    }))] })
    expect(await registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: false, mutated: false,
      value: { error: '合成平台调用标识无效', error_code: 'invalid_request' } })
    expect(await f.rows()).toHaveLength(0)
  })
})
