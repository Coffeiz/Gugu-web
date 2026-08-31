import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { beginAccountBoundary } from '@/utils/accountBoundary'

const { api } = vi.hoisted(() => ({
  api: {
    listCanvases: vi.fn(),
    listCanvasItems: vi.fn(),
    listCanvasRelations: vi.fn(),
    deleteCanvas: vi.fn(),
  },
}))

vi.mock('@/services/api', () => ({ mindApi: api }))
vi.mock('@/stores/live', () => ({
  useLiveStore: () => ({ rev: { mind: 0 } }),
}))

import { normalizeCanvasRelations, useMindStore } from '@/stores/mind'

const canvas = (id: number) => ({
  id,
  title: `画布 ${id}`,
  projectId: null,
  data: {},
  createdAt: '2026-08-02T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => { resolve = nextResolve })
  return { promise, resolve }
}

describe('画布加载竞态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.listCanvases.mockResolvedValue([canvas(1), canvas(2)])
    api.deleteCanvas.mockResolvedValue(undefined)
  })

  it('删除 pending load 的画布后，旧响应不能重新激活已删除画布', async () => {
    const items = deferred<never[]>()
    const relations = deferred<never[]>()
    api.listCanvasItems.mockReturnValue(items.promise)
    api.listCanvasRelations.mockReturnValue(relations.promise)

    const store = useMindStore()
    await store.fetchCanvases()
    const loading = store.loadCanvas(1)
    await store.deleteCanvas(1)
    items.resolve([])
    relations.resolve([])

    await expect(loading).resolves.toBe(false)
    expect(store.activeCanvasId).toBeNull()
    expect(store.canvases.map(item => item.id)).toEqual([2])
  })

  it('切换画布时只提交最后一次 load 的响应', async () => {
    const firstItems = deferred<never[]>()
    const firstRelations = deferred<never[]>()
    const secondItems = deferred<never[]>()
    const secondRelations = deferred<never[]>()
    api.listCanvasItems
      .mockReturnValueOnce(firstItems.promise)
      .mockReturnValueOnce(secondItems.promise)
    api.listCanvasRelations
      .mockReturnValueOnce(firstRelations.promise)
      .mockReturnValueOnce(secondRelations.promise)

    const store = useMindStore()
    await store.fetchCanvases()
    const first = store.loadCanvas(1)
    const second = store.loadCanvas(2)
    secondItems.resolve([])
    secondRelations.resolve([])
    expect(await second).toBe(true)
    firstItems.resolve([])
    firstRelations.resolve([])

    expect(await first).toBe(false)
    expect(store.activeCanvasId).toBe(2)
  })

  it('加载画布时去掉重复关系，避免连线 TransitionGroup 使用重复 key', async () => {
    const relation = {
      id: 570,
      canvasId: 1,
      srcNodeId: 1,
      dstNodeId: 2,
      relType: 'related' as const,
      origin: 'user' as const,
      status: 'confirmed' as const,
      createdAt: '2026-08-02T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
    }
    api.listCanvasItems.mockResolvedValue([])
    api.listCanvasRelations.mockResolvedValue([relation, { ...relation }])

    const store = useMindStore()
    await store.fetchCanvases()
    await store.loadCanvas(1)

    expect(store.canvasRelations).toHaveLength(1)
    expect(normalizeCanvasRelations([relation, { ...relation }])).toEqual([relation])
  })

  it('画布已不存在时吞掉可恢复的 404，不产生未处理 Promise 异常', async () => {
    api.listCanvasItems.mockRejectedValue(Object.assign(new Error('画布不存在'), { status: 404 }))
    api.listCanvasRelations.mockResolvedValue([])

    const store = useMindStore()
    await store.fetchCanvases()
    await expect(store.loadCanvas(1)).resolves.toBe(false)
    expect(store.activeCanvasId).toBeNull()
    expect(store.canvasItems).toEqual([])
  })

  it('切换账号后，旧账号的画布响应不能回写到新账号', async () => {
    const items = deferred<never[]>()
    const relations = deferred<never[]>()
    api.listCanvasItems.mockReturnValue(items.promise)
    api.listCanvasRelations.mockReturnValue(relations.promise)

    const store = useMindStore()
    await store.fetchCanvases()
    const loading = store.loadCanvas(1)
    store.resetAccountState()
    beginAccountBoundary()
    items.resolve([])
    relations.resolve([])

    await expect(loading).resolves.toBe(false)
    expect(store.activeCanvasId).toBeNull()
    expect(store.canvasItems).toEqual([])
  })
})
