import { describe, expect, it } from 'vitest'
import { createSkillRegistry } from '../../../src/agent/skills/registry.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { createUseSkillTool } from '../../../src/agent/tools/meta.js'
import { collect, fixture } from '../run/fixtures.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
function setup() {
  const loadedSkills: NonNullable<ToolScope['loadedSkills']> = {}
  let contentDigest = 'v1'
  const skills = createSkillRegistry({ authorize: async user => user.ownerId === identity.ownerId,
    skills: [{ id: 'U1', name: '项目计划', description: '整理阶段',
      load: async () => ({ content: '项目技能正文', contentDigest }) }] })
  const registry = createToolRegistry({ authorize: async () => true, tools: [createUseSkillTool({ skills,
    origin: async () => ({ source: 'user', ownerFingerprint: 'synthetic-owner-fingerprint' }),
  })] })
  const scope: ToolScope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null, loadedSkills,
    execute: async () => { throw new Error('不执行命令') } }
  const call = { id: 'call', name: 'use_skill', input: { id: 'U1' } }
  return { skills, registry, scope, call, setDigest: (value: string) => { Object.assign(loadedSkills, { U1: { digest: value, source: 'user', ownerFingerprint: 'synthetic-owner-fingerprint' } }) },
    update: () => { contentDigest = 'v2' } }
}

describe('use_skill经真实工具及技能注册器', () => {
  it('返回可信来源标记，同摘要省略正文、更新摘要重新加载', async () => {
    const f = setup()
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true, value: {
      skill_id: 'U1', skill_name: '项目计划', content: '项目技能正文',
      _capability_usage: { kind: 'skill', id: 'U1', loaded: true, content_digest: 'v1', source: 'user', owner_fingerprint: 'synthetic-owner-fingerprint' },
    } })
    // 模拟 Host 已将首个 marker 成功合入当前上下文；不把测试赋值计为 Harness 去重实现。
    f.setDigest('v1')
    const repeated = await f.registry.tools.dispatch(f.call, f.scope)
    expect(repeated).toMatchObject({ successful: true, value: { already_loaded: true } })
    if (repeated.kind === 'completed') expect(repeated.value).not.toHaveProperty('content')
    const otherOwner = await f.registry.tools.dispatch(f.call, { ...f.scope, loadedSkills: { U1: { digest: 'v1', source: 'user', ownerFingerprint: 'other-owner' } } })
    expect(otherOwner).toMatchObject({ value: { content: '项目技能正文' } })
    f.update()
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ value: { content: '项目技能正文', _capability_usage: { content_digest: 'v2' } } })
  })
  it('工具仍启用时，技能停用及跨owner访问也不能加载正文', async () => {
    const f = setup()
    expect(await f.registry.tools.dispatch(f.call, { ...f.scope, identity: { ...identity, ownerId: '其他用户' } }))
      .toMatchObject({ successful: false, value: { available: '' } })
    f.skills.configure({ skills: { U1: false } })
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: false })
  })
  it('非法ID、预取消和加载异常不会绕过边界或泄漏异常', async () => {
    const f = setup()
    expect(await f.registry.tools.dispatch({ ...f.call, input: { id: '../private' } }, f.scope)).toMatchObject({ executed: false })
    f.skills.register({ id: 'S1', name: '测试技能', description: '', load: async () => { throw new Error('secret=synthetic') } })
    expect(await f.registry.tools.dispatch({ ...f.call, input: { id: 'S1' } }, f.scope)).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
    const controller = new AbortController(); controller.abort()
    await expect(f.registry.tools.dispatch(f.call, { ...f.scope, signal: controller.signal })).rejects.toThrow()
  })
  it('元数据查询等待期间停用技能，已经读到的正文也不能发布', async () => {
    const f = setup()
    const tool = createUseSkillTool({ skills: f.skills,
      origin: async () => { f.skills.configure({ skills: { U1: false } }); return { source: 'user', ownerFingerprint: 'synthetic' } },
    })
    const registry = createToolRegistry({ tools: [tool], authorize: async () => true })
    const result = await registry.tools.dispatch(f.call, f.scope)
    expect(result).toMatchObject({ successful: false })
    expect(JSON.stringify(result)).not.toContain('项目技能正文')
  })
  it('真实Harness工具轮接收技能正文及标记后继续回复', async () => {
    const f = setup()
    const h = fixture([[{ type: 'complete', text: '', calls: [f.call] }], [{ type: 'complete', text: '已读取技能。', calls: [] }]])
    h.ports.tools = f.registry.tools
    const result = await collect(h.harness.start(identity))
    expect(result.state.status).toBe('completed')
    expect(JSON.stringify(result.state)).toContain('项目技能正文')
    expect(JSON.stringify(result.state)).toContain('_capability_usage')
  })
})

it('关联 Schema 只加入当前 Run 授权目录匹配项，撤权后不会再次注入', async () => {
  const f = setup()
  f.skills.register({ id: 'U2', name: '外部资料', description: '', related_tools: ['mcp_visible', 'mcp_revoked'],
    load: async () => ({ content: '相关资料正文', contentDigest: 'v1' }) })
  const call = { ...f.call, input: { id: 'U2' } }
  let authorized = true
  const scope = { ...f.scope, async discoverRelatedTools() {
    return authorized ? [{ name: 'mcp_visible', schema: { input_schema: { type: 'object' } } }] : []
  } }
  const result = await f.registry.tools.dispatch(call, scope)
  expect(result).toMatchObject({ canonicalEvents: [
    { type: 'skill-schema', skill_name: 'U2', tool_names: ['mcp_visible'] },
    { type: 'tool-schema', tool_name: 'mcp_visible', schema: { input_schema: { type: 'object' } } },
  ] })
  expect(JSON.stringify(result)).not.toContain('mcp_revoked')
  authorized = false
  expect(await f.registry.tools.dispatch(call, scope)).not.toHaveProperty('canonicalEvents')
})
