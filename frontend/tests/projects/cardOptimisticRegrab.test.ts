// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { useMindStore } from '@/stores/mind'
import { useProjectStore } from '@/stores/projects'
import type { MindCanvasItem, MindNote } from '@/services/api'
import type { Project } from '@/types/project'
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'

const mocks = vi.hoisted(() => ({
  projectsApi: {
    list: vi.fn(),
    update: vi.fn(),
  },
  eventsApi: { list: vi.fn() },
  mindApi: {
    createRefNode: vi.fn(),
    addCanvasItem: vi.fn(),
    bringCanvasItemToFront: vi.fn(),
    removeCanvasItem: vi.fn(),
  },
}))

vi.mock('@/services/api', () => ({
  projectsApi: mocks.projectsApi,
  eventsApi: mocks.eventsApi,
  mindApi: mocks.mindApi,
  searchApi: {},
}))

vi.mock('@/stores/live', async () => {
  const { reactive } = await import('vue')
  return {
    useLiveStore: () => reactive({
      rev: { projects: 0, calendar: 0, mind: 0 },
      resourceEvent: null,
    }),
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 7,
    name: '示例项目',
    client: null,
    status: 'active',
    stages: [{ key: 'draft', label: '草稿', todos: [{ id: 'todo-1', text: '草稿', done: false }] }],
    currentStage: 'draft',
    progress: 0,
    version: 1,
    doneAt: null,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Project
}

function refNode(id = 91): MindNote {
  return {
    id,
    kind: 'ref',
    title: '示例项目',
    contentMd: '',
    color: null,
    capturedAt: '2026-01-01T00:00:00Z',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    refType: 'project',
    refId: 5,
  }
}

function canvasItem(id: number, x: number, y: number, node = refNode()): MindCanvasItem {
  return {
    id,
    canvasId: 3,
    nodeId: node.id,
    x,
    y,
    w: null,
    h: null,
    z: 1000,
    collapsed: false,
    data: {},
    node,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  InteractionSync.reset()
  mocks.projectsApi.list.mockReset().mockResolvedValue([project()])
  mocks.projectsApi.update.mockReset()
  mocks.eventsApi.list.mockReset().mockResolvedValue([])
  mocks.mindApi.createRefNode.mockReset()
  mocks.mindApi.addCanvasItem.mockReset()
  mocks.mindApi.bringCanvasItemToFront.mockReset()
  mocks.mindApi.removeCanvasItem.mockReset().mockResolvedValue(undefined)
})

describe('看板项目乐观写入', () => {
  it('快速拖回时旧响应不覆盖最新状态，并把已确认版本传给排队请求', async () => {
    const store = useProjectStore()
    await store.fetchProjects()
    const firstResponse = deferred<Project>()
    const latestResponse = deferred<Project>()
    let firstPayload: Record<string, unknown> | undefined
    let latestPayload: Record<string, unknown> | undefined
    mocks.projectsApi.update
      .mockImplementationOnce((_id: number, payload: Record<string, unknown>) => {
        firstPayload = payload
        return firstResponse.promise
      })
      .mockImplementationOnce((_id: number, payload: Record<string, unknown>) => {
        latestPayload = payload
        return latestResponse.promise
      })

    const markDone = store.moveProject(7, 'done')
    await vi.waitFor(() => expect(mocks.projectsApi.update).toHaveBeenCalledOnce())
    const moveBack = store.moveProject(7, 'active')

    expect(store.projects[0].status).toBe('active')
    expect(store.projects[0].doneAt).toBeNull()
    firstResponse.resolve(project({ ...firstPayload, status: 'done', version: 2, doneAt: '2026-09-30T10:00:00Z' } as Partial<Project>))

    await vi.waitFor(() => expect(mocks.projectsApi.update).toHaveBeenCalledTimes(2))
    expect(store.projects[0].status).toBe('active')
    expect(store.projects[0].doneAt).toBeNull()
    expect(store.projects[0].version).toBe(2)
    expect(latestPayload?.version).toBe(2)

    latestResponse.resolve(project({ ...latestPayload, version: 3, doneAt: null } as Partial<Project>))
    await Promise.all([markDone, moveBack])
    expect(store.projects[0].status).toBe('active')
    expect(store.projects[0].stages[0].todos[0].done).toBe(false)
    expect(store.projects[0].version).toBe(3)
  })

  it('最新写入失败时回滚到最近一次服务端确认状态', async () => {
    const store = useProjectStore()
    await store.fetchProjects()
    mocks.projectsApi.update.mockRejectedValueOnce(new Error('网络不可用'))

    await store.updateProject(7, { name: '尚未保存的名称' })

    expect(store.projects[0].name).toBe('示例项目')
    expect(store.error).toBe('项目保存失败：网络不可用')
  })
})

describe('Mind 画布抽屉卡片乐观 regrab', () => {
  it('创建未完成时的连续 regrab 只持久化正 id，并最终保存最新位置且保持对象身份', async () => {
    const store = useMindStore()
    store.activeCanvasId = 3
    const create = deferred<MindNote>()
    const firstMove = deferred<MindCanvasItem>()
    const latestMove = deferred<MindCanvasItem>()
    mocks.mindApi.createRefNode.mockReturnValueOnce(create.promise)
    mocks.mindApi.addCanvasItem.mockResolvedValueOnce(canvasItem(77, 10, 10))
    mocks.mindApi.bringCanvasItemToFront
      .mockReturnValueOnce(firstMove.promise)
      .mockReturnValueOnce(latestMove.promise)

    const optimistic = store.addProjectRefOptimistic(3, 5, 10, 10)
    const stableClientKey = optimistic.item.clientKey
    await store.bringCanvasItemToFront(optimistic.item.id, 20, 30)
    expect(mocks.mindApi.bringCanvasItemToFront).not.toHaveBeenCalled()

    create.resolve(refNode())
    await vi.waitFor(() => expect(mocks.mindApi.addCanvasItem).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(mocks.mindApi.bringCanvasItemToFront).toHaveBeenCalledOnce())
    await store.bringCanvasItemToFront(optimistic.item.id, 40, 50)
    firstMove.resolve(canvasItem(77, 20, 30))
    await vi.waitFor(() => expect(mocks.mindApi.bringCanvasItemToFront).toHaveBeenCalledTimes(2))
    latestMove.resolve(canvasItem(77, 40, 50))

    const resolved = await optimistic.ready
    expect(mocks.mindApi.bringCanvasItemToFront.mock.calls.map(([, id, position]) => [id, position]))
      .toEqual([[77, { x: 20, y: 30 }], [77, { x: 40, y: 50 }]])
    expect(resolved).toMatchObject({ id: 77, clientKey: stableClientKey, x: 40, y: 50 })
    expect(store.canvasItems).toEqual([resolved])
  })

  it('拖回抽屉时取消尚未落库的卡，并补偿删除随后创建的服务端对象', async () => {
    const store = useMindStore()
    store.activeCanvasId = 3
    const create = deferred<MindNote>()
    mocks.mindApi.createRefNode.mockReturnValueOnce(create.promise)
    mocks.mindApi.addCanvasItem.mockResolvedValueOnce(canvasItem(88, 10, 10))

    const optimistic = store.addProjectRefOptimistic(3, 5, 10, 10)
    await store.returnCanvasItemToDrawer(optimistic.item.id)
    expect(store.canvasItems).toHaveLength(0)

    create.resolve(refNode())
    await optimistic.ready

    expect(mocks.mindApi.removeCanvasItem).toHaveBeenCalledWith(3, 88, expect.anything())
    expect(store.canvasItems).toHaveLength(0)
    expect(mocks.mindApi.bringCanvasItemToFront).not.toHaveBeenCalled()
  })
})

describe('画布 Runtime 身份契约', () => {
  it('乐观节点替换成服务端 id 后仍使用相同 clientKey 身份', () => {
    expect(mindCanvasObjectId({ nodeId: -7, clientKey: 'optimistic--7' }))
      .toBe(mindCanvasObjectId({ nodeId: 42, clientKey: 'optimistic--7' }))
  })
})
