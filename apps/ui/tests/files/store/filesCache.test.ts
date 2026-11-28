// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { filesApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { useFilesCacheStore, type FileMeta } from '@/stores/filesCache'

vi.mock('@/services/api', () => ({ filesApi: { get: vi.fn() } }))
vi.mock('@/stores/live', async () => {
  const { reactive } = await import('vue')
  const live = reactive({ resourceEvent: null })
  return { useLiveStore: () => live }
})
vi.mock('@/utils/accountBoundary', () => ({ getAccountBoundaryEpoch: () => 0 }))

function file(filePath: string, overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    filePath, displayName: filePath.split('/').at(-1) ?? '合成文件', ext: 'png', space: 'personal',
    workspaceDirectoryId: null, projectId: null, projectName: null, projectColor: null,
    stageName: '', mindMapId: null, size: '1 KB', sizeBytes: 1,
    mimeType: 'image/png', createdAt: '2026-09-09', deletedAt: null,
    imgWidth: null, imgHeight: null, version: 1, ...overrides,
  } as FileMeta
}

describe('filesCache 文件元数据缓存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(filesApi.get).mockReset()
    useLiveStore().resourceEvent = null
  })

  it('并发详情读取共享一次请求并缓存文件结果', async () => {
    const path = '/personal/图片.png'
    const value = file(path)
    vi.mocked(filesApi.get).mockResolvedValue(value as never)
    const store = useFilesCacheStore()

    const first = store.ensureFile(path)
    const second = store.ensureFile(path)
    await expect(Promise.all([first, second])).resolves.toEqual([value, value])
    expect(filesApi.get).toHaveBeenCalledExactlyOnceWith(path)
    expect(store.getFile(path)).toEqual(value)
  })

  it('文件变更只更新文件详情缓存', () => {
    const store = useFilesCacheStore()
    const path = '/personal/文件.png'
    store.addFile(file(path))
    store.updateFile(path, { version: 2 })
    expect(store.getFile(path)?.version).toBe(2)
    store.removeFile(path)
    expect(store.getFile(path)).toBeNull()
  })

  it('只接受文件实体事件，不再处理目录实体事件', () => {
    const store = useFilesCacheStore()
    const fileEvent = {
      resource: 'files', operation: 'create', entity_id: '/personal/文件 9.png',
      payload: { kind: 'file', entity: file('/personal/文件 9.png') },
    } as never
    const folderEvent = {
      resource: 'files', operation: 'create', entity_id: '/personal/旧目录',
      payload: { kind: 'folder', entity: { name: '旧目录' } },
    } as never

    expect(store.applyCanonicalEvent(fileEvent)).toBe(true)
    expect(store.getFile('/personal/文件 9.png')?.displayName).toBe('文件 9.png')
    expect(store.applyCanonicalEvent(folderEvent)).toBe(false)
    expect(store.getFile('/personal/旧目录')).toBeNull()
  })

  it('账号切换清空缓存文件', () => {
    const store = useFilesCacheStore()
    store.addFile(file('/personal/文件.png'))
    store.resetAccountState()
    expect(store.getFile('/personal/文件.png')).toBeNull()
  })
})
