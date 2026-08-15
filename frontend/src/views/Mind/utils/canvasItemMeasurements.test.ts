import { describe, expect, it } from 'vitest'
import {
  cacheCanvasItemSize, measuredCanvasItemSize, migrateCanvasItemSize,
} from './canvasItemMeasurements'

describe('画布乐观项目尺寸缓存', () => {
  it('乐观项目换成真实 node 后仍保留自然高度，避免后续拖动回退到 120px 导致落点上移', () => {
    const byNodeId = new Map<number, { w: number; h: number }>()
    const byClientKey = new Map<string, { w: number; h: number }>()
    const optimistic = { nodeId: -1, clientKey: 'optimistic--1' }
    const resolved = { nodeId: 196, clientKey: 'optimistic--1' }
    const measured = { w: 240, h: 97.55 }

    cacheCanvasItemSize(byNodeId, byClientKey, optimistic, measured)
    migrateCanvasItemSize(byNodeId, byClientKey, resolved)

    expect(measuredCanvasItemSize(byNodeId, byClientKey, resolved)).toEqual(measured)
    expect(byNodeId.get(196)).toEqual(measured)
  })
})
