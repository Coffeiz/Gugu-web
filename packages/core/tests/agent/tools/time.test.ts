import { describe, expect, it } from 'vitest'
import { createTimeTool } from '../../../src/agent/tools/time.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolScope } from '../../../src/agent/tools/contracts.js'
import { collect, fixture, identity as runIdentity } from '../run/fixtures.js'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run-1' }
function scope(): ToolScope {
  return { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('时间工具不执行进程') } }
}

describe('时间工具真实注册和派发', () => {
  it('真实Harness工具轮接收时间结果并继续生成最终回复', async () => {
    const call = { id: 'time-call', name: 'get_current_time', input: {} }
    const f = fixture([
      [{ type: 'complete', text: '', calls: [call] }],
      [{ type: 'complete', text: '当前是星期五。', calls: [] }],
    ])
    f.ports.tools = createToolRegistry({ authorize: async () => true, tools: [createTimeTool({
      now: () => new Date('2026-09-25T12:34:56Z'), timezone: async () => 'UTC',
    })] }).tools
    const result = await collect(f.harness.start(runIdentity))
    expect(result.state.status).toBe('completed')
    expect(result.events.filter(event => event.type === 'tool_done')).toHaveLength(1)
    expect(result.events.find(event => event.type === 'tool_done')).toMatchObject({ payload: { status: 'success' } })
    expect(JSON.stringify(result.state)).toContain('12:34:56')
  })
  it('保持 Python 日期星期结果，并以可信用户时区处理跨日和午夜', async () => {
    const registry = createToolRegistry({ authorize: async () => true, tools: [createTimeTool({
      now: () => new Date('2026-09-24T16:00:00Z'), timezone: async user => {
        expect(user).toEqual(identity)
        return 'Asia/Shanghai'
      },
    })] })
    expect((await registry.capabilities(identity)).map(tool => tool.name)).toEqual(['get_current_time'])
    expect(await registry.tools.dispatch({ id: 'call-1', name: 'get_current_time', input: { timezone: 'UTC' } }, scope()))
      .toEqual({ kind: 'completed', successful: true, mutated: false, value: {
        date: '2026-09-25', weekday: '星期五', time: '00:00:00', datetime: '2026-09-25 00:00:00', timezone: 'Asia/Shanghai',
        ignored_fields:['timezone'],
        hint:'以下字段不在 get_current_time 的当前 schema 中，已被忽略：timezone。参数形状与预期不符时，需要时用 search_tools 的 names 读取最新参数定义再重试。',
      } })
  })
  it('夏令时跳转使用同一实时瞬间，不缓存旧时钟', async () => {
    let current = '2026-03-08T06:59:59Z'
    const registry = createToolRegistry({ authorize: async () => true, tools: [createTimeTool({
      now: () => new Date(current), timezone: async () => 'America/New_York',
    })] })
    const call = { id: 'call-2', name: 'get_current_time', input: {} }
    expect(await registry.tools.dispatch(call, scope())).toMatchObject({ value: { time: '01:59:59' } })
    current = '2026-03-08T07:00:00Z'
    expect(await registry.tools.dispatch(call, scope())).toMatchObject({ value: { time: '03:00:00' } })
  })
  it('可信Python固定偏移跨日时保留原时区名称，非法偏移仍失败', async () => {
    let timezone = 'UTC+08:00'
    const registry = createToolRegistry({ authorize: async () => true, tools: [createTimeTool({
      now: () => new Date('2026-01-01T20:00:00Z'), timezone: async () => timezone,
    })] })
    const call = { id: 'fixed', name: 'get_current_time', input: { timezone: 'UTC' } }
    expect(await registry.tools.dispatch(call, scope())).toMatchObject({ successful: true, value: {
      date: '2026-01-02', weekday: '星期五', time: '04:00:00', datetime: '2026-01-02 04:00:00', timezone: 'UTC+08:00',
    } })
    timezone = 'UTC-03:30'
    expect(await registry.tools.dispatch(call, scope())).toMatchObject({ successful: true, value: {
      date: '2026-01-01', weekday: '星期四', time: '16:30:00', datetime: '2026-01-01 16:30:00', timezone: 'UTC-03:30',
    } })
    timezone = 'UTC+25:00'
    expect(await registry.tools.dispatch(call, scope())).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
  })
  it('非法参数和无效可信时区不能泄露原始异常', async () => {
    const registry = createToolRegistry({ authorize: async () => true, tools: [createTimeTool({
      now: () => new Date(), timezone: async () => 'secret-invalid-zone',
    })] })
    expect(await registry.tools.dispatch({ id: 'call-3', name: 'get_current_time', input: [] }, scope()))
      .toMatchObject({ successful: false, executed: false })
    expect(await registry.tools.dispatch({ id: 'call-4', name: 'get_current_time', input: {} }, scope()))
      .toMatchObject({ successful: false, value: { error: '工具执行失败' } })
  })
})
