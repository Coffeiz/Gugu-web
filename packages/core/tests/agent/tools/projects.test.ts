import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { PROJECT_COLOR_PRESETS } from '../../../src/projects/colors.js'
import { createGetProjectTool, createListProjectsTool } from '../../../src/agent/tools/projects/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture as harnessFixture } from '../run/fixtures.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-tool-projects-'))
  const file = join(root, 'projects.db')
  await initializeSqlite(file)
  let current = '2026-01-01T00:00:00Z'
  const { runtime, ownerId } = await openSqliteRuntime(file, { clock: () => current })
  let allowed = true
  const registry = createToolRegistry({ tools: [createListProjectsTool(runtime)], authorize: async () => allowed })
  const scope: ToolScope = { identity: { ownerId, sessionId: '1', runId: 'run' }, roundId: 'round',
    signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不能执行进程') } }
  return { runtime, ownerId, registry, scope,
    setTime: (value: string) => { current = value }, revoke: () => { allowed = false },
    dispatch: (input: unknown, override: Partial<ToolScope> = {}) => registry.tools.dispatch(
      { id: 'list', name: 'list_projects', input }, { ...scope, ...override }),
    close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) },
  }
}

describe('项目列表工具真实注册与 SQLite 查询', () => {
  it('保留 Python 投影、状态/归档筛选并按更新时间排序', async () => {
    const f = await fixture()
    try {
      const first = await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({
        name: '计划项目', client: '小北', start_date: '2026-01-01', deadline: '2026-02-01',
        color: PROJECT_COLOR_PRESETS[0], stages: [{ key: 's0', label: '计划', done: true }, { key: 's1', label: '交付' }],
      }))
      f.setTime('2026-01-02T00:00:00Z')
      await f.runtime.transaction(dataContext(f.ownerId), async data => {
        await data.projects.create({ name: '完成项目', status: 'done' })
        await data.projects.create({ name: '归档项目', archived: true })
        await data.projects.create({ name: '已删除项目' })
      })
      await f.runtime.db.updateTable('projects').set({ deleted_at: '2026-01-02T01:00:00Z' })
        .where('name', '=', '已删除项目').execute()
      f.setTime('2026-01-02T00:00:00.000001Z')
      await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.update(first.id, first.version, { summary: '刚更新' }))
      const all = await f.dispatch({})
      expect(all).toMatchObject({ kind: 'completed', successful: true, mutated: false })
      if (all.kind !== 'completed') throw new Error('应返回列表')
      expect(all.value).toEqual([
        { id: first.id, name: '计划项目', status: 'pending', color: 'amber', deadline: '2026-02-01',
          start_date: '2026-01-01', client: '小北', stages_done: 1, stages_total: 2 },
        expect.objectContaining({ name: '完成项目', status: 'done', color: 'lavender', stages_total: 0 }),
      ])
      expect(await f.dispatch({ status: 'done' })).toMatchObject({ value: [expect.objectContaining({ name: '完成项目' })] })
      expect(await f.dispatch({ archived: true })).toMatchObject({ value: [expect.objectContaining({ name: '归档项目' })] })
      const other = '00000000-0000-4000-8000-000000000002'
      expect(await f.dispatch({}, { identity: { ...f.scope.identity, ownerId: other } })).toMatchObject({ value: [] })
    } finally { await f.close() }
  })

  it('参数错误、撤权及取消均不能查询业务数据', async () => {
    const f = await fixture()
    try {
      for (const input of [null, [], { status: 'unknown' }, { archived: '不是布尔值' }])
        expect(await f.dispatch(input)).toMatchObject({ successful: false, executed: false })
      f.revoke()
      expect(await f.registry.capabilities(f.scope.identity)).toEqual([])
      expect(await f.dispatch({})).toMatchObject({ successful: false, executed: false })
      const controller = new AbortController(); controller.abort()
      await expect(f.dispatch({}, { signal: controller.signal })).rejects.toThrow()
    } finally { await f.close() }
  })
  it('真实 Harness 工具轮调用 SQLite 业务查询并继续回复', async () => {
    const f = await fixture()
    try {
      await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({ name: '工具轮项目' }))
      const h = harnessFixture([
        [{ type: 'complete', text: '', calls: [{ id: 'list', name: 'list_projects', input: {} }] }],
        [{ type: 'complete', text: '已查到项目。', calls: [] }],
      ])
      h.ports.tools = f.registry.tools
      const result = await collect(h.harness.start(f.scope.identity))
      expect(result.state.status).toBe('completed')
      expect(result.events.find(event => event.type === 'tool_done')).toMatchObject({ payload: { status: 'success' } })
      expect(JSON.stringify(result.state)).toContain('工具轮项目')
    } finally { await f.close() }
  })

  it('历史非法阶段 JSON 遵循 Python 空列表行为，合法 null 结构明确失败', async () => {
    const f = await fixture()
    try {
      await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({ name: '历史项目' }))
      await f.runtime.db.updateTable('projects').set({ stages_json: '{' }).execute()
      expect(await f.dispatch({})).toMatchObject({ successful: true, value: [expect.objectContaining({ stages_done: 0, stages_total: 0 })] })
      await f.runtime.db.updateTable('projects').set({ stages_json: 'null' }).execute()
      expect(await f.dispatch({})).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
    } finally { await f.close() }
  })

  it('已关闭存储返回安全失败，不回显数据库路径', async () => {
    const f = await fixture()
    try {
      await f.runtime.close()
      expect(await f.dispatch({})).toEqual({ kind: 'completed', successful: false, mutated: false,
        executed: true, value: { error: '工具执行失败' } })
    } finally { await f.close() }
  })
})


describe('项目详情工具真实 SQLite 与明确文件概览端口', () => {
  it('项目名称查询采用Python空白语义，BOM按真实名称字符保留', async () => {
    const f = await fixture()
    try {
      const rows = await f.runtime.transaction(dataContext(f.ownerId), async data => [
        await data.projects.create({ name: '小北项目' }),
        await data.projects.create({ name: '\ufeff小北项目' }),
        await data.projects.create({ name: '\u001c创建项目原名\u001f' }),
      ])
      const registry = createToolRegistry({ authorize: async () => true, tools: [createGetProjectTool({ core: f.runtime,
        async fileOverview() { return { total_file_count: 2, root_file_count: 1, total_folder_count: 1 } },
      })] })
      const query = (project: string) => registry.tools.dispatch({ id: 'name', name: 'get_project', input: { project } }, f.scope)
      expect(await query('\u001c小北项目\u001f')).toMatchObject({ successful: true, value: { id: rows[0]!.id, name: '小北项目' } })
      expect(await query('\ufeff小北项目')).toMatchObject({ successful: true, value: { id: rows[1]!.id, name: '\ufeff小北项目' } })
      const saved = await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.get(rows[2]!.id))
      expect(saved!.name).toBe('\u001c创建项目原名\u001f')
    } finally { await f.close() }
  })

  it('完整投影与真实 Harness 调用保留待办业务字段，概览来自可信端口', async () => {
    const f = await fixture()
    try {
      const project = await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({
        name: '详情项目', summary: '整理旁白', priority: 'high', client: '小北',
        stages: [{ key: 's0', label: '计划', done: true, todos: [{ id: 't0', text: '旁白', done: true, autoCompleted: true, _savedDone: false }] }],
        current_stage: 's0', color: PROJECT_COLOR_PRESETS[1],
      }))
      let overviewCalls = 0
      const registry = createToolRegistry({ authorize: async () => true, tools: [createGetProjectTool({ core: f.runtime,
        async fileOverview(identity, projectId, signal) {
          expect(identity).toEqual(f.scope.identity); expect(projectId).toBe(project.id); expect(signal.aborted).toBe(false)
          overviewCalls++
          return { total_file_count: 2, root_file_count: 1, total_folder_count: 2 }
        },
      })] })
      const call = { id: 'detail', name: 'get_project', input: { project_id: project.id, project: '不存在的备用名称' } }
      const result = await registry.tools.dispatch(call, f.scope)
      expect(result).toEqual({ kind: 'completed', successful: true, mutated: false, value: {
        id: project.id, name: '详情项目', status: 'pending', priority: 'high', summary: '整理旁白',
        files: { total_file_count: 2, root_file_count: 1, total_folder_count: 2 }, client: '小北',
        start_date: null, deadline: null, color: 'sage', current_stage: 's0', archived: false,
        stages: [{ key: 's0', label: '计划', done: true, todos: [{ id: 't0', text: '旁白', done: true }] }],
      } })
      expect(overviewCalls).toBe(1)
      const h = harnessFixture([
        [{ type: 'complete', text: '', calls: [call] }],
        [{ type: 'complete', text: '详情已读取。', calls: [] }],
      ])
      h.ports.tools = registry.tools
      expect((await collect(h.harness.start(f.scope.identity))).state.status).toBe('completed')
      expect(overviewCalls).toBe(2)
    } finally { await f.close() }
  })

  it('按精确名称优先并在歧义时列候选，不为越权或缺失项目调用文件概览', async () => {
    const f = await fixture()
    try {
      const projects = await f.runtime.transaction(dataContext(f.ownerId), async data => [
        await data.projects.create({ name: '计划甲' }),
        await data.projects.create({ name: '计划甲扩展' }),
        await data.projects.create({ name: '计划甲', archived: true }),
        await data.projects.create({ name: '字面[方案]' }),
      ])
      let overviewCalls = 0
      const registry = createToolRegistry({ authorize: async () => true, tools: [createGetProjectTool({ core: f.runtime,
        async fileOverview() { overviewCalls++; return { total_file_count: 3, root_file_count: 0, total_folder_count: 1 } },
      })] })
      const dispatch = (input: unknown, ownerId = f.ownerId) => registry.tools.dispatch({ id: 'get', name: 'get_project', input },
        { ...f.scope, identity: { ...f.scope.identity, ownerId } })
      expect(await dispatch({ project: '计划甲' })).toMatchObject({ successful: true, value: { id: projects[0]!.id } })
      expect(await dispatch({ project: '[方案]' })).toMatchObject({ successful: true, value: { id: projects[3]!.id } })
      const count = overviewCalls
      expect(await dispatch({ project: '计划' })).toMatchObject({ successful: false, value: { candidates: expect.arrayContaining([
        { id: projects[0]!.id, name: '计划甲', status: 'pending' }, { id: projects[1]!.id, name: '计划甲扩展', status: 'pending' },
      ]) } })
      expect(await dispatch({ project_id: projects[0]!.id }, '00000000-0000-4000-8000-000000000002'))
        .toMatchObject({ successful: false, value: { error: '项目不存在' } })
      expect(await dispatch({ project: '不存在' })).toMatchObject({ successful: false, value: { available_projects: ['字面[方案]', '计划甲', '计划甲扩展'] } })
      expect(await dispatch({})).toMatchObject({ successful: false, value: { error: '需提供 project_id 或项目名 project' } })
      expect(await dispatch({ project_id: '1x' })).toMatchObject({ successful: false, executed: false })
      expect(overviewCalls).toBe(count)
      expect(await dispatch({ project_id: String(projects[0]!.id) })).toMatchObject({ successful: true, value: { id: projects[0]!.id } })
      expect(overviewCalls).toBe(count + 1)
    } finally { await f.close() }
  })

  it('缺失或失败的概览能力不伪造零计数，参数不得建立身份', async () => {
    const f = await fixture()
    try {
      const project = await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({ name: '概览失败项目' }))
      expect(() => createGetProjectTool({ core: f.runtime } as Parameters<typeof createGetProjectTool>[0]))
        .toThrow('项目文件概览能力未装配')
      const tool = createGetProjectTool({ core: f.runtime, async fileOverview() { throw new Error('合成私有凭据') } })
      const registry = createToolRegistry({ authorize: async () => true, tools: [tool] })
      const result = await registry.tools.dispatch({ id: 'get', name: 'get_project', input: { project_id: project.id, ownerId: '模型身份' } }, f.scope)
      expect(result).toEqual({ kind: 'completed', successful: false, mutated: false, executed: true, value: { error: '工具执行失败' } })
      expect(JSON.stringify(result)).not.toContain('合成私有凭据')
    } finally { await f.close() }
  })
})


describe('共享项目名称查询的真实SQLite匹配语义', () => {
  it('SQLite lower保留非ASCII大小写差异，不由JS Unicode折叠代替', async () => {
    const f = await fixture()
    try {
      const upper = await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({ name: 'Änne' }))
      const registry = createToolRegistry({ authorize: async () => true, tools: [createGetProjectTool({ core: f.runtime,
        async fileOverview() { return { total_file_count: 0, root_file_count: 0, total_folder_count: 0 } },
      })] })
      const query = (project: string) => registry.tools.dispatch({ id: 'unicode', name: 'get_project', input: { project } }, f.scope)
      expect(await query('änne')).toMatchObject({ successful: false, value: { available_projects: ['Änne'] } })
      expect(await query('ÄNNE')).toMatchObject({ successful: true, value: { id: upper.id, name: 'Änne' } })
      const lower = await f.runtime.transaction(dataContext(f.ownerId), data => data.projects.create({ name: 'änne' }))
      expect(await query('änne')).toMatchObject({ successful: true, value: { id: lower.id, name: 'änne' } })
    } finally { await f.close() }
  })

  it('SQLite LIKE将反斜线作为字面字符，后续下划线仍匹配单字符', async () => {
    const f = await fixture()
    try {
      const projects = await f.runtime.transaction(dataContext(f.ownerId), async data => [
        await data.projects.create({ name: 'a_b' }),
        await data.projects.create({ name: '旧格式名称' }),
      ])
      // 模拟旧数据已有反斜线名称；当前创建服务的路径命名校验不属于查询契约。
      await f.runtime.db.updateTable('projects').set({ name: String.raw`a\xb` }).where('id', '=', projects[1]!.id).execute()
      const registry = createToolRegistry({ authorize: async () => true, tools: [createGetProjectTool({ core: f.runtime,
        async fileOverview() { return { total_file_count: 0, root_file_count: 0, total_folder_count: 0 } },
      })] })
      const result = await registry.tools.dispatch({ id: 'like', name: 'get_project', input: { project: String.raw`a\_b` } }, f.scope)
      expect(result).toMatchObject({ successful: true, value: { id: projects[1]!.id, name: String.raw`a\xb` } })
    } finally { await f.close() }
  })

  it('精确名称只存在归档项目时优先于未归档模糊项目，owner仍隔离', async () => {
    const f = await fixture()
    try {
      const projects = await f.runtime.transaction(dataContext(f.ownerId), async data => [
        await data.projects.create({ name: '设计', archived: true }),
        await data.projects.create({ name: '设计扩展', archived: false }),
      ])
      let overviewCalls = 0
      const registry = createToolRegistry({ authorize: async () => true, tools: [createGetProjectTool({ core: f.runtime,
        async fileOverview() { overviewCalls++; return { total_file_count: 0, root_file_count: 0, total_folder_count: 0 } },
      })] })
      const call = { id: 'archived-exact', name: 'get_project', input: { project: '设计' } }
      expect(await registry.tools.dispatch(call, f.scope)).toMatchObject({ successful: true, value: { id: projects[0]!.id, archived: true } })
      expect(await registry.tools.dispatch(call, { ...f.scope, identity: { ...f.scope.identity, ownerId: '00000000-0000-4000-8000-000000000002' } })).toMatchObject({ successful: false, value: { available_projects: [] } })
      expect(overviewCalls).toBe(1)
    } finally { await f.close() }
  })
})
