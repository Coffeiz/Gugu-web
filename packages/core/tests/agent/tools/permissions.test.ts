import { describe, expect, it, vi } from 'vitest'
import { canUseTool, filterToolNames, type ToolPermissionContext } from '../../../src/agent/tools/permissions.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolDefinition, ToolScope } from '../../../src/agent/tools/contracts.js'

const web: ToolPermissionContext = { allowedToolNames: null, imRole: null, platform: null, chatType: null, currentIm: null }
const member: ToolPermissionContext = { allowedToolNames: [], imRole: 'member', platform: 'qq', chatType: 'group', currentIm: { chatType: 'group', groupAutoReply: false } }

describe('Python 工具发现与派发权限规则', () => {
  it('发现按白名单顺序过滤，空白名单只追加系统中存在的安全时间工具', () => {
    const system = ['files', 'get_current_time', 'web_search']
    expect(filterToolNames(system, null)).toEqual(system)
    expect(filterToolNames(system, ['web_search', 'missing', 'web_search'])).toEqual(['web_search', 'web_search', 'get_current_time'])
    expect(filterToolNames(system, [])).toEqual(['get_current_time'])
    expect(filterToolNames(['files'], [])).toEqual([])
  })
  it('空白名单、固定工具和技能管理角色遵循派发规则', () => {
    expect(canUseTool('files', web)).toBe(true)
    expect(canUseTool('files', member)).toBe(false)
    for (const name of ['get_current_time', 'call_tool', 'search_tools', 'use_skill', 'ask_user']) expect(canUseTool(name, member)).toBe(true)
    for (const name of ['list_skills', 'create_skill', 'update_skill', 'delete_skill']) {
      expect(canUseTool(name, web)).toBe(true)
      expect(canUseTool(name, { ...member, imRole: 'owner' })).toBe(true)
      expect(canUseTool(name, member)).toBe(false)
      expect(canUseTool(name, { ...member, imRole: 'unknown', allowedToolNames: [name] })).toBe(false)
    }
  })
  it('present_file 仅开放 Web 与桌面端，不开放 IM 平台', () => {
    expect(canUseTool('present_file', { ...web, allowedToolNames: ['present_file'] })).toBe(true)
    expect(canUseTool('present_file', { ...web, allowedToolNames: ['present_file'], platform: 'desktop' })).toBe(true)
    expect(canUseTool('present_file', { ...member, allowedToolNames: ['present_file'] })).toBe(false)
  })
  it('平台和群自动回复特例优先于普通白名单', () => {
    expect(canUseTool('present_file', { ...member, allowedToolNames: ['present_file'] })).toBe(false)
    expect(canUseTool('present_file', web)).toBe(true)
    for (const platform of ['qq', 'telegram', 'feishu', 'wechat']) expect(canUseTool('send_link_buttons', { ...member, platform })).toBe(true)
    expect(canUseTool('send_link_buttons', { ...member, platform: 'other' })).toBe(false)
    expect(canUseTool('send_link_buttons', { ...member, chatType: 'private' })).toBe(false)
    expect(canUseTool('choose_no_reply', web)).toBe(false)
    expect(canUseTool('choose_no_reply', { ...member, allowedToolNames: null })).toBe(false)
    expect(canUseTool('choose_no_reply', { ...member, currentIm: { chatType: 'group', groupAutoReply: true } })).toBe(true)
    expect(canUseTool('choose_no_reply', { ...member, currentIm: { chatType: 'private', groupAutoReply: true } })).toBe(false)
  })
  it('缺少可信上下文字段时拒绝，而不是隐式当作 Web 放行', () => {
    expect(() => canUseTool('files', {} as ToolPermissionContext)).toThrow()
    expect(() => filterToolNames(['files'], undefined as never)).toThrow()
  })
  it('注册器发现后白名单撤销会阻止真实派发及副作用', async () => {
    const execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue({ kind: 'completed', successful: true, mutated: false, value: '完成' })
    const tool: ToolDefinition = { definition: { name: 'files', schema: { type: 'function', function: { name: 'files', parameters: { type: 'object', properties: {} } } } }, effect: 'read', validate: input => ({ success: true, data: input }), execute }
    let policy: ToolPermissionContext = { ...member, allowedToolNames: ['files'] }
    const registry = createToolRegistry({ tools: [tool], authorize: async () => canUseTool('files', policy) })
    const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
    const scope: ToolScope = { identity, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    expect(await registry.capabilities(identity)).toHaveLength(1)
    policy = { ...policy, allowedToolNames: [] }
    expect(await registry.tools.dispatch({ id: 'call', name: 'files', input: {} }, scope)).toMatchObject({ successful: false, executed: false })
    expect(execute).not.toHaveBeenCalled()
  })
})
