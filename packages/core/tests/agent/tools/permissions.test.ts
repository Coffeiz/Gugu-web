import { sceneAllowsTool } from '../../../src/agent/scenes/index.js'
import { describe, expect, it, vi } from 'vitest'
import { desktopImGroupToolAllowed, imCanUseTool, imUnavailableTool } from '../../../src/agent/scenes/im/index.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ImActor } from '../../../src/im/access.js'
import type { ToolDefinition, ToolScope } from '../../../src/agent/tools/contracts.js'

type Actor = Parameters<typeof imCanUseTool>[0]
const member: Actor = { allowedToolNames: [], role: 'member', platform: 'qq', chatType: 'group', verifiedOwner: false }

describe('工具发现与派发权限规则', () => {
  it('空白名单保留固定入口，技能管理只向已验证的私聊 owner 开放', () => {
    for (const name of ['get_current_time', 'call_tool', 'search_tools', 'use_skill', 'ask_user'])
      expect(imCanUseTool(member, name)).toBe(true)
    for (const name of ['list_skills', 'create_skill', 'update_skill', 'delete_skill']) {
      const owner = { ...member, role: 'owner' as const, verifiedOwner: true }
      expect(imCanUseTool({ ...owner, chatType: 'c2c' }, name)).toBe(true)
      expect(imCanUseTool(owner, name)).toBe(false)
      expect(imCanUseTool({ ...member, allowedToolNames: [name] }, name)).toBe(false)
      expect(imCanUseTool({ ...owner, chatType: 'c2c', verifiedOwner: false }, name)).toBe(false)
    }
  })
  it('限制 IM 界面工具和原生回复控制，未知平台拒绝工具', () => {
    expect(sceneAllowsTool('default', 'open_item')).toBe(true)
    expect(imCanUseTool({ ...member, allowedToolNames: ['open_item'] }, 'open_item')).toBe(false)
    expect(sceneAllowsTool('im', 'send_item', 'app_card')).toBe(false)
    expect(sceneAllowsTool('im', 'send_item', 'native')).toBe(true)
    for (const platform of ['qq', 'telegram', 'feishu', 'wechat'] as const)
      expect(imCanUseTool({ ...member, platform }, 'send_link_buttons')).toBe(false)
    expect(imCanUseTool({ ...member, platform: 'other' as ImActor['platform'] }, 'get_current_time')).toBe(false)
    expect(imCanUseTool(member, 'choose_no_reply')).toBe(false)
    expect(imCanUseTool(member, 'choose_no_reply', true)).toBe(true)
    expect(imCanUseTool({ ...member, chatType: 'c2c' }, 'choose_no_reply', true)).toBe(false)
  })
  it('桌面群聊区分已验证 owner、群设置和固定入口', () => {
    expect(desktopImGroupToolAllowed('qq', true, [], 'web_search')).toBe(true)
    expect(desktopImGroupToolAllowed('qq', true, [], 'list_projects')).toBe(false)
    expect(desktopImGroupToolAllowed('qq', true, [], 'canvas_focus_node')).toBe(false)
    expect(desktopImGroupToolAllowed('qq', false, [], 'web_search')).toBe(false)
    expect(desktopImGroupToolAllowed('qq', false, ['web_search'], 'web_search')).toBe(true)
    expect(desktopImGroupToolAllowed('qq', false, [], 'call_tool')).toBe(true)
    expect(desktopImGroupToolAllowed('qq', false, [], 'use_skill')).toBe(true)
    expect(desktopImGroupToolAllowed('qq', false, [], 'create_scheduled_task')).toBe(false)
  })
  it('IM 拒绝结果区分场景限制、未授权工具和未知工具', () => {
    expect(imUnavailableTool('open_item').error_code).toBe('tool_unsupported_in_scene')
    expect(imUnavailableTool('list_projects').error_code).toBe('tool_not_allowed')
    expect(imUnavailableTool('synthetic_unknown_tool').error_code).toBe('tool_not_found')
  })
  it('注册器发现后白名单撤销会阻止真实派发及副作用', async () => {
    const execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue({ kind: 'completed', successful: true, mutated: false, value: '完成' })
    const tool: ToolDefinition = { definition: { name: 'group_context_search', schema: { type: 'function', function: { name: 'group_context_search', parameters: { type: 'object', properties: {} } } } }, effect: 'read', validate: input => ({ success: true, data: input }), execute }
    let policy: Actor = { ...member, allowedToolNames: ['group_context_search'] }
    const registry = createToolRegistry({ tools: [tool], authorize: async () => imCanUseTool(policy, 'group_context_search') })
    const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
    const scope: ToolScope = { identity, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    expect(await registry.capabilities(identity)).toHaveLength(1)
    policy = { ...policy, allowedToolNames: [] }
    expect(await registry.tools.dispatch({ id: 'call', name: 'group_context_search', input: {} }, scope)).toMatchObject({ successful: false, executed: false })
    expect(execute).not.toHaveBeenCalled()
  })
})
