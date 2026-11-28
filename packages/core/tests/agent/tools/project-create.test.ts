import { describe, expect, it, vi } from 'vitest'
import { createProjectTool } from '../../../src/agent/tools/projects/index.js'
import type { ProjectCreatePort } from '../../../src/agent/tools/projects/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'
import { PROJECT_COLOR_PRESETS } from '../../../src/projects/colors.js'
const args = { project_name: '新项目', start_date: '2026-11-14', deadline: '2026-11-30' }
function setup() {
  // 显式领域端口替身；本套件不声称验证真实项目数据库或 Host 装配。
  const create = vi.fn<ProjectCreatePort['create']>().mockResolvedValue({ success: true, project_id: 1, name: args.project_name })
  const tools = createToolRegistry({ tools: [createProjectTool({ create })], authorize: async () => true })
  const scope: ToolScope = { identity: { ownerId: 'owner-a', sessionId: 'desktop-session', runId: 'run-a' }, roundId: 'round-a', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
  const call = { id: 'call-a', name: 'create_project', input: args }
  return { create, tools, scope, call }
}
describe('创建项目工具的领域注入边界', () => {
  it('完整日期不依赖缺省年份服务，只有需要补年时读取可信年份', async () => {
    const f = setup()
    const normalizationYear = vi.fn(() => { throw new Error('缺省年份不可用') })
    const registry = createToolRegistry({ tools: [createProjectTool({ create: f.create })], authorize: async () => true, normalizationYear })
    expect(await registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true })
    expect(normalizationYear).not.toHaveBeenCalled()
    expect(await registry.tools.dispatch({ ...f.call, input: { ...args, start_date: '9月25日' } }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(normalizationYear).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('旧日期、颜色和精确包装经归一后调用，错名包装不更换工具或放宽权限', async () => {
    const f = setup()
    const registry = createToolRegistry({ tools: [createProjectTool({ create: f.create })], authorize: async () => true, normalizationYear: () => 2026 })
    const input = { tool_name: 'create_project', arguments: { name: '旧项目', start_date: '9月25日', deadline: '10/2', color: PROJECT_COLOR_PRESETS[2] } }
    expect(await registry.tools.dispatch({ ...f.call, input }, f.scope)).toMatchObject({ successful: true })
    expect(f.create).toHaveBeenCalledWith({ identity: f.scope.identity, roundId: f.scope.roundId, signal: f.scope.signal, toolCallId: f.call.id,
      args: { project_name: '旧项目', start_date: '2026-09-25', deadline: '2026-10-02', color: 'teal' } })
    expect(await registry.tools.dispatch({ ...f.call, input: { ...input, tool_name: 'delete_project' } }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(await f.tools.tools.dispatch({ ...f.call, input }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('摘要按Python Unicode字符计数，200个emoji合法且201个拒绝', async () => {
    const f = setup()
    expect(await f.tools.tools.dispatch({ ...f.call, input: { ...args, summary: '🌙'.repeat(200) } }, f.scope)).toMatchObject({ successful: true })
    expect(await f.tools.tools.dispatch({ ...f.call, input: { ...args, summary: '🌙'.repeat(201) } }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('传递可信身份、平台session、call id和取消信号，不接受模型授权字段', async () => {
    const f = setup()
    const input = { ...args, stages: ['设计', { label: '交付', todos: ['验收'] }], summary: null, color: 'teal', priority: 'high' }
    expect(await f.tools.tools.dispatch({ ...f.call, input }, f.scope)).toMatchObject({ successful: true, mutated: true })
    expect(f.create).toHaveBeenCalledWith({ identity: f.scope.identity, roundId: f.scope.roundId, args: input, toolCallId: f.call.id, signal: f.scope.signal })
    expect(await f.tools.tools.dispatch({ ...f.call, input: { ...args, ownerId: 'other' } }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it.each([{ stages: [] }, { stages: [{ todos: ['缺少名称'] }] }, { stages: [{ label: '阶段', todos: [''] }] }, { color: '#ffffff' }, { start_date: '明天' }, { summary: '字'.repeat(201) }, { priority: 'none' }])('非法参数不触达领域端口 %j', async invalid => {
    const f = setup()
    expect(await f.tools.tools.dispatch({ ...f.call, input: { ...args, ...invalid } }, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.create).not.toHaveBeenCalled()
  })
  it('保留真实幂等重放结果，失败不标记副作用', async () => {
    const f = setup()
    f.create.mockResolvedValueOnce({ success: true, project_id: 1, idempotent_replay: true })
    expect(await f.tools.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true, mutated: false, value: { idempotent_replay: true } })
    f.create.mockResolvedValueOnce({ success: false, error: '项目字段无效', error_code: 'invalid_request' })
    expect(await f.tools.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: false, mutated: false, value: { error: '项目字段无效' } })
  })
  it('提交异常保留unknown，缺call id和取消请求不执行', async () => {
    const f = setup()
    f.create.mockRejectedValue(new Error('synthetic-secret'))
    expect(await f.tools.tools.dispatch(f.call, f.scope)).toEqual({ kind: 'unknown' })
    expect(await f.tools.tools.dispatch({ ...f.call, id: '' }, f.scope)).toMatchObject({ successful: false, executed: false })
    const controller = new AbortController(); controller.abort()
    await expect(f.tools.tools.dispatch(f.call, { ...f.scope, signal: controller.signal })).rejects.toThrow()
    expect(f.create).toHaveBeenCalledTimes(1)
  })
})
