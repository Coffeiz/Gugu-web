import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { createProjectMutationTools } from '../../../src/agent/tools/projects.js'
import type { ProjectMutationPort, ProjectMutationOutcome } from '../../../src/agent/tools/projects.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'
import { PROJECT_COLOR_PRESETS } from '../../../src/projects/colors.js'
import { CoreError } from '../../../src/contracts/index.js'
import type { Fields, ProjectRecord } from '../../../src/contracts/index.js'
import type { ProjectUpdateRuntime, ProjectUpdateTransaction } from '../../../src/projects/project-update.js'
import { createProjectMutationPort } from '../../../src/agent/tools/projects/mutation-port.js'
import { expectedBusinessError } from './error-fixtures.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
const project = { id: 3, name: '小北项目', priority: 'low', color: PROJECT_COLOR_PRESETS[2], archived: true }
function fixture() {
  const apply = vi.fn<ProjectMutationPort['apply']>().mockResolvedValue({ status: 'committed', mutated: true, project })
  let allowed = true
  const registry = createToolRegistry({ tools: createProjectMutationTools({ apply }), authorize: async () => allowed })
  const controller = new AbortController()
  const scope: ToolScope = { identity, roundId: 'round', signal: controller.signal, resolution: null,
    execute: async () => { throw new Error('项目修改不得执行进程') } }
  return { apply, registry, controller, scope, revoke: () => { allowed = false },
    dispatch: (name: string, input: unknown, overrides: Partial<ToolScope> = {}) => registry.tools.dispatch(
      { id: 'call', name, input }, { ...scope, ...overrides }),
  }
}

describe('项目写工具通过 registry 映射到共享领域端口（端口为替身）', () => {
  it('更新增量映射保持省略/清空语义，不能从模型参数建立身份或版本', async () => {
    const f = fixture()
    expect(await f.dispatch('update_project', { project_id: 3, project_name: '新名', priority: 'none', summary: null,
      status: 'done', ownerId: '模型身份', version: 999, stages: [], current_stage: '模型阶段' }))
      .toEqual({ kind: 'completed', successful: true, mutated: true,
        value: { success: true, project_id: 3, name: '小北项目', priority: 'low',
          ignored_fields:['current_stage','ownerId','stages','version'],
          hint:'以下字段不在 update_project 的当前 schema 中，已被忽略：current_stage, ownerId, stages, version。参数形状与预期不符时，需要时用 search_tools 的 names 读取最新参数定义再重试。' } })
    expect(f.apply).toHaveBeenCalledExactlyOnceWith({ identity, roundId: 'round', toolCallId: 'call', signal: f.controller.signal,
      intent: { action: 'update', selector: { project_id: 3 }, changes: { name: '新名', status: 'done', priority: null, summary: null } } })
    // 完成状态的阶段/todo/CAS/Undo/目录副作用均属于共享领域端口；此测试只证明意图映射。
    await f.dispatch('update_project', { project: '按名', deadline: '2026-02-01', client: '' })
    expect(f.apply.mock.calls[1]![0].intent).toEqual({ action: 'update', selector: { project: '按名' }, changes: { deadline: '2026-02-01', client: '' } })
  })

  it('归档默认true及取消归档、语义颜色保持Python结果形状', async () => {
    const f = fixture()
    expect(await f.dispatch('archive_project', { project_id: 3 })).toMatchObject({ value: { success: true, project_id: 3, archived: true } })
    expect(f.apply.mock.calls[0]![0].intent).toEqual({ action: 'archive', selector: { project_id: 3 }, archived: true })
    await f.dispatch('archive_project', { project_id: 3, archived: false })
    expect(f.apply.mock.calls[1]![0].intent).toEqual({ action: 'archive', selector: { project_id: 3 }, archived: false })
    expect(await f.dispatch('set_color', { project: '按名', color: 'teal' })).toEqual({ kind: 'completed', successful: true, mutated: true,
      value: { success: true, project_id: 3, color: 'teal' } })
    expect(f.apply.mock.calls[2]![0].intent).toEqual({ action: 'set_color', selector: { project: '按名' }, color: 'teal' })
  })

  it.each([
    ['set_color', {}], ['set_color', { color: '#fff' }], ['archive_project', { archived: '不是布尔值' }],
    ['update_project', { status: 'unknown' }], ['update_project', { deadline: '2026/02/30' }],
    ['update_project', { priority: null }], ['update_project', { summary: '字'.repeat(201) }],
    ['update_project', { project_id: '3x' }],
  ])('非法参数不调用领域端口：%s %j', async (name, input) => {
    const f = fixture()
    expect(await f.dispatch(name as string, input)).toMatchObject({ successful: false, executed: false })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('完整字段和Unicode长度通过；无更改错误由领域端口在owner定位之后决定', async () => {
    const f = fixture()
    await f.dispatch('update_project', { project_id: 3, start_date: '2026-01-01', deadline: '2026-02-01',
      status: 'active', priority: 'high', summary: '🐦'.repeat(200), client: '小北' })
    expect(f.apply).toHaveBeenCalledTimes(1)
    f.apply.mockResolvedValueOnce({ status: 'rejected', value: { error: '未提供可更新的项目内容' } })
    expect(await f.dispatch('update_project', { project_id: 3 })).toMatchObject({ successful: false, mutated: false,
      value: { error: '未提供可更新的项目内容' } })
    expect(f.apply.mock.calls[1]![0].intent).toEqual({ action: 'update', selector: { project_id: 3 }, changes: {} })
  })

  it('领域明确拒绝保留业务错误与候选，权限撤销/交互伪确认不执行', async () => {
    const f = fixture()
    const value = { error: '有多个匹配项目，请指明', candidates: [{ id: 3, name: '小北项目', status: 'pending' }] }
    f.apply.mockResolvedValueOnce({ status: 'rejected', value })
    expect(await f.dispatch('update_project', { project: '小北', summary: '' })).toEqual({ kind: 'completed', successful: false, mutated: false,
      value: expectedBusinessError('update_project', value.error, { candidates: value.candidates }) })
    expect(await f.dispatch('archive_project', {}, { resolution: { interactionId: '伪造', receiptId: '伪造', status: 'confirmed', value: true } }))
      .toMatchObject({ successful: false, executed: false })
    f.revoke()
    expect(await f.registry.capabilities(identity)).toEqual([])
    expect(await f.dispatch('set_color', { color: 'teal' })).toMatchObject({ successful: false, executed: false })
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it('开始前取消与无效Run身份不调用端口；提交完成胜过随后取消', async () => {
    const f = fixture()
    expect(await f.dispatch('archive_project', {}, { identity: { ...identity, runId: '' } }))
      .toMatchObject({ successful: false, executed: false })
    expect(f.apply).not.toHaveBeenCalled()
    f.controller.abort()
    await expect(f.dispatch('archive_project', {})).rejects.toThrow()
    expect(f.apply).not.toHaveBeenCalled()
    const committed = fixture()
    committed.apply.mockImplementationOnce(async () => { committed.controller.abort(); return { status: 'committed', mutated: true, project } })
    expect(await committed.dispatch('archive_project', {})).toMatchObject({ successful: true, mutated: true })
  })

  it('意外失败与未知提交返回unknown，reconcile不重新执行业务', async () => {
    const f = fixture()
    f.apply.mockRejectedValueOnce(new Error('合成私密连接串'))
    expect(await f.dispatch('update_project', { project_id: 3, summary: '摘要' })).toEqual({ kind: 'unknown' })
    f.apply.mockResolvedValueOnce({ status: 'unknown' })
    expect(await f.dispatch('archive_project', { project_id: 3 })).toEqual({ kind: 'unknown' })
    expect(await f.registry.tools.reconcile({ id: 'call', name: 'archive_project', input: {} }, { ...identity, roundId: 'round' })).toEqual({ kind: 'unknown' })
    expect(f.apply).toHaveBeenCalledTimes(2)
    const replay: ProjectMutationOutcome = { status: 'committed', mutated: false, project }
    f.apply.mockResolvedValueOnce(replay)
    expect(await f.dispatch('archive_project', { project_id: 3 })).toMatchObject({ successful: true, mutated: false })
  })
})


/** 事务/目录/事件均为受控内存替身；实际执行共享updater，不代表SQL或Host验收。 */
function updaterFixture(overrides: Partial<ProjectRecord> = {}, hooks: { beforeWork?: () => Promise<void>; afterUpdate?: () => void; commitError?: Error } = {}) {
  let current: ProjectRecord = {
    id: 3, user_id: identity.ownerId, name: '小北项目', summary: null, client: null,
    status: 'pending', start_date: '2026-01-01', deadline: '2026-02-01', color: PROJECT_COLOR_PRESETS[2],
    progress: 0, stages_json: JSON.stringify([{ key: 's0', label: '设计', todos: [] }]), current_stage: 's0',
    priority: 'low', version: 7, archived: false, done_at: null, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', deleted_at: null, ...overrides,
  }
  let allowed = true
  let commitFailure = false
  let casFailure = false
  const updates: Array<{ ownerId: string; id: number; version: number; fields: Fields }> = []
  const undo = vi.fn(async () => {})
  const publish = vi.fn(async () => {})
  const rename = vi.fn(async () => {})
  const fileCount = vi.fn(async () => 0)
  const transaction = vi.fn()
  const runTransaction: ProjectUpdateRuntime['transaction'] = async work => {
    transaction()
    await hooks.beforeWork?.()
    let draft = structuredClone(current)
    const tx: ProjectUpdateTransaction = {
      async getOwned(ownerId, id) { return ownerId === draft.user_id && id === draft.id ? structuredClone(draft) : null },
      async updateIfVersion(ownerId, id, version, fields) {
        updates.push({ ownerId, id, version, fields: structuredClone(fields) })
        if (casFailure || ownerId !== draft.user_id || id !== draft.id || version !== draft.version) return null
        draft = { ...draft, ...fields, version: version + 1 } as ProjectRecord
        hooks.afterUpdate?.()
        return structuredClone(draft)
      },
      updateFileStoragePrefixes: async () => {}, recordUndo: undo,
    }
    const result = await work(tx)
    current = draft
    if (hooks.commitError) throw hooks.commitError
    if (commitFailure) throw new Error('合成提交响应丢失')
    return result
  }
  const runtime: ProjectUpdateRuntime = { transaction: runTransaction, renameProjectDirectory: rename, getFileCount: fileCount, publishProjectUpdated: publish }
  const resolve = vi.fn(async (_identity: typeof identity, _selector: unknown, _signal: AbortSignal) => structuredClone(current))
  const port = createProjectMutationPort({ runtime, resolve, metadata: () => ({ undoContextId: 'tab', clientId: 'synthetic-client' }) })
  const registry = createToolRegistry({ tools: createProjectMutationTools(port), authorize: async () => allowed })
  const controller = new AbortController()
  const scope: ToolScope = { identity, roundId: 'round', signal: controller.signal, resolution: null, execute: vi.fn() }
  return { resolve, transaction, updates, undo, publish, rename, fileCount, controller, registry,
    current: () => structuredClone(current),
    bumpVersion: () => { current = { ...current, version: current.version + 1, summary: '其他端更新' } },
    failCas: () => { casFailure = true }, failCommit: () => { commitFailure = true }, revoke: () => { allowed = false },
    dispatch: (name: string, input: unknown) => registry.tools.dispatch({ id: 'call', name, input }, scope),
  }
}

describe('registry→项目mutation桥接→共享updater（事务为内存替身）', () => {
  it('summary/priority增量真正更新状态，并传递快照version和Undo/事件身份', async () => {
    const f = updaterFixture()
    expect(await f.dispatch('update_project', { project_id: 3, summary: '新摘要', priority: 'high' })).toMatchObject({ successful: true, mutated: true, value: { priority: 'high' } })
    expect(f.current()).toMatchObject({ summary: '新摘要', priority: 'high', version: 8 })
    expect(f.updates).toHaveLength(1)
    expect(f.updates[0]).toMatchObject({ ownerId: identity.ownerId, id: 3, version: 7, fields: { summary: '新摘要', priority: 'high' } })
    expect(f.undo).toHaveBeenCalledWith(expect.objectContaining({ userId: identity.ownerId, contextId: 'tab', baseVersions: { 'project:3': { version: 7 } } }))
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({ userId: identity.ownerId, origin: 'synthetic-client', entityId: 3 }))
    expect(f.rename).not.toHaveBeenCalled()
    expect(await f.dispatch('update_project', { project_id: 3, summary: null, priority: 'none' })).toMatchObject({ successful: true })
    expect(f.current()).toMatchObject({ summary: null, priority: null })
  })
  it('定位之后版本改变不采用新版本覆盖，事务CAS拒绝也不提交', async () => {
    const f = updaterFixture()
    f.resolve.mockImplementationOnce(async () => { const snapshot = f.current(); f.bumpVersion(); return snapshot })
    expect(await f.dispatch('update_project', { project_id: 3, summary: '旧快照写入' })).toMatchObject({ successful: false, mutated: false, value: { error: '项目刚被其他端修改，请重试' } })
    expect(f.current()).toMatchObject({ summary: '其他端更新', version: 8 })
    expect(f.updates).toHaveLength(0)
    const cas = updaterFixture(); cas.failCas()
    expect(await cas.dispatch('update_project', { project_id: 3, priority: 'high' })).toMatchObject({ successful: false, mutated: false })
    expect(cas.updates[0]?.version).toBe(7)
    expect(cas.current()).toMatchObject({ version: 7, priority: 'low' })
    expect(cas.publish).not.toHaveBeenCalled()
    expect(cas.undo).not.toHaveBeenCalled()
  })
  it('set_color/archive经共享updater更新实际状态与版本', async () => {
    const f = updaterFixture()
    expect(await f.dispatch('set_color', { project_id: 3, color: 'rose' })).toMatchObject({ successful: true, value: { color: 'rose' } })
    expect(f.current()).toMatchObject({ color: PROJECT_COLOR_PRESETS[6], version: 8 })
    expect(await f.dispatch('archive_project', { project_id: 3 })).toMatchObject({ successful: true, value: { archived: true } })
    expect(f.current()).toMatchObject({ archived: true, version: 9 })
    expect(await f.dispatch('archive_project', { project_id: 3, archived: false })).toMatchObject({ successful: true, value: { archived: false } })
    expect(f.current()).toMatchObject({ archived: false, version: 10 })
    expect(f.updates.map(update => update.version)).toEqual([7, 8, 9])
  })
  it('拒权/预取消不定位，resolve中取消不开始事务或写入', async () => {
    const denied = updaterFixture(); denied.revoke()
    expect(await denied.dispatch('archive_project', { project_id: 3 })).toMatchObject({ successful: false, executed: false })
    expect(denied.resolve).not.toHaveBeenCalled()
    const cancelled = updaterFixture(); cancelled.controller.abort()
    await expect(cancelled.dispatch('archive_project', { project_id: 3 })).rejects.toThrow()
    expect(cancelled.resolve).not.toHaveBeenCalled()
    const pending = updaterFixture()
    pending.resolve.mockImplementationOnce(async () => { pending.controller.abort(); return pending.current() })
    await pending.dispatch('archive_project', { project_id: 3 })
    expect(pending.transaction).not.toHaveBeenCalled()
    expect(pending.current().version).toBe(7)
  })
  it('提交结果未知及提交后CoreError都返回unknown，reconcile不重放', async () => {
    for (const failure of ['commit', 'fileCount']) {
      const f = updaterFixture()
      if (failure === 'commit') f.failCommit()
      else f.fileCount.mockRejectedValueOnce(new CoreError('not_found', '合成提交后错误'))
      expect(await f.dispatch('update_project', { project_id: 3, summary: '已经提交' })).toEqual({ kind: 'unknown' })
      expect(f.current()).toMatchObject({ summary: '已经提交', version: 8 })
      expect(await f.registry.tools.reconcile({ id: 'call', name: 'update_project', input: {} }, { ...identity, roundId: 'round' })).toEqual({ kind: 'unknown' })
      expect(f.updates).toHaveLength(1)
    }
  })
  it('status done通过共享updater收尾待办并保留原先已完成项', async () => {
    const f = updaterFixture({ stages_json: JSON.stringify([
      { key: 's0', label: '设计', todos: [{ id: 't1', text: '已完成', done: true }, { id: 't2', text: '待完成', done: false }] },
      { key: 's1', label: '交付', todos: [] },
    ]) })
    expect(await f.dispatch('update_project', { project_id: 3, status: 'done' })).toMatchObject({ successful: true, mutated: true })
    expect(f.current()).toMatchObject({ status: 'done', progress: 100, current_stage: 's1' })
    const stages = JSON.parse(f.current().stages_json)
    expect(stages[0].todos[0]).toEqual({ id: 't1', text: '已完成', done: true })
    expect(stages[0].todos[1]).toMatchObject({ id: 't2', text: '待完成', done: true, _savedDone: false, autoCompleted: true })
  })
  it('空changes在owner定位后拒绝，不开事务或产生副作用', async () => {
    const f = updaterFixture()
    expect(await f.dispatch('update_project', { project_id: 3 })).toMatchObject({ successful: false, mutated: false, value: { error: '未提供可更新的项目内容' } })
    expect(f.resolve).toHaveBeenCalledOnce()
    expect(f.transaction).not.toHaveBeenCalled()
    expect(f.current().version).toBe(7)
  })
})


describe('项目mutation事务等待与提交边界（受控内存事务）', () => {
  it('等待事务资源期间取消，callback进入前拒绝且无写入', async () => {
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const resumed = new Promise<void>(resolve => { release = resolve })
    const f = updaterFixture({}, { beforeWork: async () => { entered(); await resumed } })
    const pending = f.dispatch('update_project', { project_id: 3, summary: '取消写入' })
    await waiting
    f.controller.abort()
    release()
    expect(await pending).toEqual({ kind: 'unknown' })
    expect(f.updates).toHaveLength(0)
    expect(f.current()).toMatchObject({ version: 7, summary: null })
    expect(f.undo).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  })
  it('callback写入后提交前取消，事务回滚正文和version且不发布事件', async () => {
    const controller = new AbortController()
    const f = updaterFixture({}, { afterUpdate: () => { controller.abort() } })
    // 独立signal由可信dispatch scope提供，不放进模型参数。
    const scope: ToolScope = { identity, roundId: 'round', signal: controller.signal, resolution: null, execute: vi.fn() }
    expect(await f.registry.tools.dispatch({ id: 'call', name: 'update_project', input: { project_id: 3, summary: '未提交' } }, scope)).toEqual({ kind: 'unknown' })
    expect(f.updates).toHaveLength(1)
    expect(f.current()).toMatchObject({ version: 7, summary: null })
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.fileCount).not.toHaveBeenCalled()
  })
  it('transaction提交后抛CoreError conflict仍是unknown，不能伪装CAS拒绝或重放', async () => {
    const f = updaterFixture({}, { commitError: new CoreError('conflict', '合成COMMIT响应错误') })
    expect(await f.dispatch('update_project', { project_id: 3, summary: '真实已提交' })).toEqual({ kind: 'unknown' })
    expect(f.current()).toMatchObject({ version: 8, summary: '真实已提交' })
    expect(await f.registry.tools.reconcile({ id: 'call', name: 'update_project', input: {} }, { ...identity, roundId: 'round' })).toEqual({ kind: 'unknown' })
    expect(f.updates).toHaveLength(1)
  })
  it('定位快照缺少version或id/version非法，不回落采用较新版本', async () => {
    for (const patch of [{ version: undefined }, { version: 0 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { id: 0 }, { id: 1.5 }]) {
      const f = updaterFixture()
      const snapshot = { ...f.current(), ...patch } as unknown as ProjectRecord
      f.resolve.mockResolvedValueOnce(snapshot)
      expect(await f.dispatch('update_project', { project_id: 3, summary: '非法快照' })).toEqual({ kind: 'unknown' })
      expect(f.transaction).not.toHaveBeenCalled()
      expect(f.current()).toMatchObject({ version: 7, summary: null })
    }
  })
})
