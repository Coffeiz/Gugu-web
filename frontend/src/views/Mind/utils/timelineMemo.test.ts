import { describe, expect, it } from 'vitest'
import { timelineColumnMemoKey } from './timelineMemo'

describe('Mind 时间流列 memo', () => {
  it('便签乐观替换但服务端版本未变时仍让所属列更新', () => {
    const original = { id: 42, version: 3, contentMd: '- [ ] 任务' }
    const before = timelineColumnMemoKey([original], null, null, false)
    const optimistic = { ...original, contentMd: '- [x] 任务' }

    const after = timelineColumnMemoKey([optimistic], null, null, false)

    expect(optimistic.version).toBe(original.version)
    expect(after).not.toBe(before)
  })

  it('本列对象和交互状态不变时保持 memo 稳定，避免无关日期列重绘', () => {
    const item = { id: 42, version: 3, contentMd: '内容' }
    const first = timelineColumnMemoKey([item], null, null, false)
    const nextRender = timelineColumnMemoKey([item], null, null, false)

    expect(nextRender).toBe(first)
  })
})
