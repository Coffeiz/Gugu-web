import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { reconcileCanvasItems } from '@/interaction/sync/InteractionSyncReconciler'

describe('InteractionSync Phase 1 画布契约', () => {
  beforeEach(() => InteractionSync.reset())

  it('同一 Tab 的事件只作为回声，不触发重复刷新', () => {
    const mutation = InteractionSync.begin('mind.canvas.item.move', 'canvas:1:item:2', 'optimistic-1')
    expect(InteractionSync.isOwnEvent(mutation.clientId)).toBe(true)
    expect(InteractionSync.isOwnEvent('another-tab')).toBe(false)
    InteractionSync.finish(mutation.mutationId)
  })

  it('服务端落库响应继承 optimistic clientKey，未返回时保留 placeholder', () => {
    const mutation = InteractionSync.begin('mind.canvas.ref.create', 'canvas:1:project:7', 'optimistic-1')
    mutation.nodeId = 42
    mutation.persistedItemId = 100
    const local = [{ id: -1, nodeId: 42, clientKey: 'optimistic-1', x: 10 }]
    const server = [{ id: 100, nodeId: 42, x: 20 }]
    expect(reconcileCanvasItems(server, local, InteractionSync.pending())).toEqual([
      { id: 100, nodeId: 42, x: 20, clientKey: 'optimistic-1' },
    ])

    InteractionSync.reset()
    const pending = InteractionSync.begin('mind.canvas.ref.create', 'canvas:1:project:8', 'optimistic-2')
    expect(reconcileCanvasItems([], [{ id: -2, nodeId: -2, clientKey: 'optimistic-2', x: 30 }], InteractionSync.pending())).toEqual([
      { id: -2, nodeId: -2, clientKey: 'optimistic-2', x: 30 },
    ])
    InteractionSync.cancel(pending.mutationId)
    expect(reconcileCanvasItems([], [{ id: -2, nodeId: -2, clientKey: 'optimistic-2', x: 30 }], InteractionSync.pending())).toEqual([])
  })

  it('服务端回写同一实体时保持已有身份，切换画布时不借用上一张画布的身份', () => {
    const local = [{ id: 9, nodeId: 4, clientKey: 'canvas-a-item-9', x: 1 }]
    const refreshed = [{ id: 9, nodeId: 4, x: 2 }]
    expect(reconcileCanvasItems(refreshed, local, [])).toEqual([
      { id: 9, nodeId: 4, x: 2, clientKey: 'canvas-a-item-9' },
    ])
    expect(reconcileCanvasItems(refreshed, [], [])).toEqual(refreshed)
  })
})
