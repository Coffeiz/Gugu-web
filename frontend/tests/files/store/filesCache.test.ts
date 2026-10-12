// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFilesCacheStore, type FileMeta, type FolderMeta } from '@/stores/filesCache'
import type { CursorPage } from '@/services/api'

vi.mock('@/services/api', () => ({
  filesApi: { get: vi.fn() },
  foldersApi: { get: vi.fn() },
}))
vi.mock('@/stores/live', () => ({ useLiveStore: () => ({ resourceEvent: null }) }))
vi.mock('@/utils/accountBoundary', () => ({ getAccountBoundaryEpoch: () => 0 }))

function file(id: number, overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id, displayName: `文件 ${id}`, ext: 'png', space: 'personal',
    workspaceDirectoryId: null, projectId: null, projectName: null, projectColor: null,
    stageName: '', folderId: null, folderName: null, mindMapId: null,
    size: '1 KB', sizeBytes: 1, mimeType: 'image/png', createdAt: '2026-09-09',
    deletedAt: null, imgWidth: null, imgHeight: null, version: 1, ...overrides,
  } as FileMeta
}
function folder(id: number, overrides: Partial<FolderMeta> = {}): FolderMeta {
  return { id, name: `目录 ${id}`, projectId: null, workspaceDirectoryId: null,
    parentId: null, fileCount: 0, version: 1, ...overrides } as FolderMeta
}
const page = <T>(items: T[]): CursorPage<T> => ({ items, next_cursor: null, has_more: false })

describe('filesCache 有界目录页与 ID 缓存', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('目录页按 personal/project/workspace 与父目录隔离', () => {
    const store = useFilesCacheStore()
    const personal = file(1)
    const root = file(2, { space: 'workspace', workspaceDirectoryId: 34 })
    const child = file(3, { space: 'workspace', workspaceDirectoryId: 34, folderId: 20 })
    const rootFolder = folder(20, { workspaceDirectoryId: 34 })
    const childFolder = folder(21, { workspaceDirectoryId: 34, parentId: 20 })
    store.setDirectoryPage({ space: 'personal' }, page([personal]), page([]))
    store.setDirectoryPage({ space: 'workspace', workspaceDirectoryId: 34 }, page([root]), page([rootFolder]))
    store.setDirectoryPage({ space: 'workspace', workspaceDirectoryId: 34, folderId: 20 }, page([child]), page([childFolder]))

    expect(store.getPersonalRootFiles()).toEqual([personal])
    expect(store.getWorkspaceFiles(34)).toEqual([root])
    expect(store.getWorkspaceFiles(34, 20)).toEqual([child])
    expect(store.getWorkspaceFolders(34)).toEqual([rootFolder])
    expect(store.getWorkspaceFolders(34, 20)).toEqual([childFolder])
  })

  it('实体变更使目录 cursor 链失效，但按 ID 详情仍可读取', () => {
    const store = useFilesCacheStore()
    const original = file(1)
    store.setDirectoryPage({ space: 'personal' }, page([original]), page([]))
    store.updateFile(1, { space: 'workspace', workspaceDirectoryId: 34 })

    expect(store.getDirectory({ space: 'personal' })).toBeNull()
    expect(store.getFile(1)?.workspaceDirectoryId).toBe(34)
  })

  it('目录页缓存按 LRU 限制在 8 个 scope，淘汰不表示 ID 详情不存在', () => {
    const store = useFilesCacheStore()
    const first = file(1)
    for (let id = 1; id <= 9; id++) {
      store.setDirectoryPage({ space: 'project', projectId: id }, page([file(id)]), page([]))
    }
    expect(store.directories.size).toBe(8)
    expect(store.getDirectory({ space: 'project', projectId: 1 })).toBeNull()
    expect(store.getFile(first.id)).toEqual(first)
  })

  it('账号切换清空 ID、目录页和进行中的请求引用', () => {
    const store = useFilesCacheStore()
    store.addFile(file(1))
    store.setDirectoryPage({ space: 'personal' }, page([file(1)]), page([]))
    store.resetAccountState()
    expect(store.getFile(1)).toBeNull()
    expect(store.directories.size).toBe(0)
  })
})
