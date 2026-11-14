import { describe,expect,it } from 'vitest'
import { sealDisplayTimeline,updateDisplayItem } from "../../../../src/agent/harness/index.js"

const scope = { anchorMessageId: '17', now: '2026-01-01T00:00:00Z' }
const tool = { kind: 'tool' as const, runId: 'run-synthetic', roundId: 'round-synthetic', toolCallId: 'call-synthetic', toolStatus: 'running' }

describe('统一展示时间线', () => {
  it('工具更新保留首次身份、时间、序号、原问题anchor，迟到running不能覆盖终态', () => {
    const first = updateDisplayItem([], tool, scope)
    const updated = updateDisplayItem(first, { ...tool, toolStatus: 'success' }, { anchorMessageId: '99', now: '2026-01-01T00:01:00Z' })
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ eventId: first[0]!.eventId, sequence: 1, anchorMessageId: '17', createdAt: scope.now, timelineOrder: '17000001', toolStatus: 'success' })
    expect(updateDisplayItem(updated, tool, scope)).toEqual(updated)
  })

  it('同名toolCallId属于不同run/round时不能覆盖；相同eventId更新不移动原位置', () => {
    const one = updateDisplayItem([], tool, scope)
    const two = updateDisplayItem(one, { ...tool, roundId: 'second-round' }, scope)
    const three = updateDisplayItem(two, { ...tool, eventId: one[0]!.eventId, toolStatus: 'success' }, scope)
    expect(three).toHaveLength(2)
    expect(three.map((item) => item.eventId)).toEqual(two.map((item) => item.eventId))
    expect(three[0]!.toolStatus).toBe('success')
  })

  it('封存只关闭未终结气泡，保持身份与时间顺序且重复封存幂等', () => {
    const source = updateDisplayItem([], tool, scope)
    const sealed = sealDisplayTimeline(source, '2026-01-01T00:01:00Z')
    expect(source[0]!.toolStatus).toBe('running')
    expect(sealed[0]).toMatchObject({ ...source[0], toolStatus: 'stopped', updatedAt: '2026-01-01T00:01:00Z' })
    expect(sealDisplayTimeline(sealed, '2026-01-01T00:02:00Z')).toEqual(sealed)
  })

  it('晚提交的取消展示仍锚定旧问题，下一条继续消息排在它后面，大编号不丢精度', () => {
    const old = updateDisplayItem([], tool, { ...scope, anchorMessageId: '9007199254740993' })
    const newer = updateDisplayItem([], { ...tool, runId: 'new-run' }, { ...scope, anchorMessageId: '9007199254740994' })
    expect(old[0]!.timelineOrder).toBe('9007199254740993000001')
    expect(BigInt(old[0]!.timelineOrder!)).toBeLessThan(BigInt(newer[0]!.timelineOrder!))
  })
})
