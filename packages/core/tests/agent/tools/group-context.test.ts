import { describe, expect, it, vi } from 'vitest'
import { createGroupContextSearchTool, resolveGroupSpeaker } from '../../../src/agent/tools/im/group-context.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'

const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
const scope: ToolScope = { identity, roundId: 'round-a', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
describe('当前群工具与发言人解析', () => {
  it('真实pid优先且不读文件，保留窗口外沉默成员pid可精确命中', async () => {
    const load = vi.fn(async () => ({ silent: { aliases: ['小北'] } }))
    expect(await resolveGroupSpeaker('live', [{ platformUserId: 'live', name: '名字', lastSeenAt: 1 }], load)).toEqual({ platform_user_id: 'live' })
    expect(load).not.toHaveBeenCalled()
    expect(await resolveGroupSpeaker('silent', [], load)).toEqual({ platform_user_id: 'silent' })
  })
  it('精确alias胜过唯一模糊实时名字，精确重名跨来源合并为ambiguous', async () => {
    const rows = [{ platformUserId: 'b', name: '小北哥', lastSeenAt: 3 }]
    expect(await resolveGroupSpeaker('小北', rows, async () => ({ a: { aliases: ['小北'] } }))).toEqual({ platform_user_id: 'a' })
    const result = await resolveGroupSpeaker('小北', [{ ...rows[0]!, name: '小北' }], async () => ({ a: { aliases: ['小北'], last_seen_at: 8 } }))
    expect(result).toMatchObject({ ambiguous: true, candidates: [{ platform_user_id: 'a', matched_by: 'aliases' }, { platform_user_id: 'b', matched_by: 'name' }] })
  })
  it('模糊包含跨名字/曾用名/群友称呼合并、同人去重，候选按members时间最多5人', async () => {
    const members = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`pid-${index}`, { aliases: ['moon_小北'], nicknames: ['小北'], last_seen_at: index + 1 }]))
    const result = await resolveGroupSpeaker('小', [{ platformUserId: 'pid-0', name: '小北', lastSeenAt: 100 }], async () => members)
    expect(result).toMatchObject({ ambiguous: true, candidates: ['pid-6', 'pid-5', 'pid-4', 'pid-3', 'pid-2'].map(platform_user_id => ({ platform_user_id })) })
    members['pid-0']!.last_seen_at = 0
    expect(await resolveGroupSpeaker('小', [{ platformUserId: 'pid-0', name: '小北', lastSeenAt: 100 }], async () => members)).toMatchObject({
      candidates: ['pid-0', 'pid-6', 'pid-5', 'pid-4', 'pid-3'].map(platform_user_id => ({ platform_user_id })),
    })
    expect(await resolveGroupSpeaker('moon_小北', [], async () => ({ one: { aliases: ['moon_小北'], nicknames: ['moon_小北'] } }))).toEqual({ platform_user_id: 'one' })
    expect(await resolveGroupSpeaker('missing', [], async () => ({}))).toEqual({ error: '没有找到叫 missing 的群成员' })
    expect(await resolveGroupSpeaker(' ', [], async () => ({}))).toEqual({ error: 'speaker 不能为空' })
  })
  it('工具复用正规注册器规范关键词/限制/模式，任意owner或群ID不能进入Host', async () => {
    const search = vi.fn(async () => ({ messages: [] }))
    const registry = createToolRegistry({ tools: [createGroupContextSearchTool({ search })], authorize: async () => true })
    const call = { id: 'call', name: 'group_context_search', input: { query: '部署 方案', queries: [' 部署 ', '部署', '上线'], mode: 'and', limit: 99, speaker: ' 小北 ' } }
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ successful: true })
    expect(search).toHaveBeenLastCalledWith(identity, { keyword: '部署 方案', queries: ['部署', '上线'], mode: 'AND', limit: 30, speaker: '小北' }, scope.signal)
    await registry.tools.dispatch({ ...call, input: { group_id: 'another-group', owner_id: 'another-owner' } }, scope)
    expect(search).toHaveBeenCalledTimes(1)
  })
  it('权限在发现后撤销则派发拒绝，未向Host发起查询', async () => {
    let allowed = true
    const search = vi.fn(async () => ({ messages: [] }))
    const registry = createToolRegistry({ tools: [createGroupContextSearchTool({ search })], authorize: async () => allowed })
    expect(await registry.capabilities(identity)).toHaveLength(1)
    allowed = false
    expect(await registry.tools.dispatch({ id: 'call', name: 'group_context_search', input: {} }, scope)).toMatchObject({ executed: false })
    expect(search).not.toHaveBeenCalled()
  })
})
