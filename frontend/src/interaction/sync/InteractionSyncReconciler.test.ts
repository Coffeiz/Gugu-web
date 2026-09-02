import { describe, expect, it } from 'vitest'
import { canvasLocalItemsForLoad, reconcileCanvasItems } from './InteractionSyncReconciler'

describe('reconcileCanvasItems', () => {
  it('切换画布时不复用上一张画布的本地 identity', () => {
    expect(canvasLocalItemsForLoad(1, 2, [{ id: 10, nodeId: 7, clientKey: 'canvas-a-item' }])).toEqual([])
  })

  it('服务端认领 optimistic mutation 后不重复保留临时占位项', () => {
    const result = reconcileCanvasItems(
      [{ id: 42, nodeId: 42 }],
      [{ id: -1, nodeId: -1, clientKey: 'optimistic--1' }],
      [{
        mutationId: 'mutation-1',
        clientId: 'client-1',
        scope: 'mind.canvas.ref.create',
        entityKey: 'canvas:1:project:2',
        clientKey: 'optimistic--1',
        persistedItemId: 42,
        nodeId: 42,
        cancelled: false,
      }],
    )

    expect(result).toEqual([{ id: 42, nodeId: 42, clientKey: 'optimistic--1' }])
  })

  it('取消态 optimistic create 不会被中途刷新重新复活', () => {
    const result = reconcileCanvasItems(
      [{ id: 42, nodeId: 42 }],
      [{ id: -1, nodeId: -1, clientKey: 'optimistic--1' }],
      [{
        mutationId: 'mutation-1',
        clientId: 'client-1',
        scope: 'mind.canvas.ref.create',
        entityKey: 'canvas:1:project:2',
        clientKey: 'optimistic--1',
        persistedItemId: 42,
        nodeId: 42,
        cancelled: true,
      }],
    )

    expect(result).toEqual([])
  })
})
