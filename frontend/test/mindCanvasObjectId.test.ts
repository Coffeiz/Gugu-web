import { describe, expect, it } from 'vitest'
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'

describe('mindCanvasObjectId', () => {
  it('乐观卡片和落库后的同一张卡保持相同 Runtime 身份', () => {
    const clientKey = 'optimistic--7'

    expect(mindCanvasObjectId({ nodeId: -7, clientKey })).toBe('mind:optimistic--7')
    expect(mindCanvasObjectId({ nodeId: 165, clientKey })).toBe('mind:optimistic--7')
  })

  it('历史卡没有 clientKey 时继续使用 nodeId', () => {
    expect(mindCanvasObjectId({ nodeId: 165 })).toBe('mind:165')
  })

  it('clientKey 为空字符串时不回退到临时 nodeId', () => {
    expect(mindCanvasObjectId({ nodeId: -7, clientKey: '' })).toBe('mind:')
  })
})
