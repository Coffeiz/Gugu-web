import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFilesCacheStore, type FileMeta, type FolderMeta } from './filesCache'

vi.mock('@/services/api', () => ({
  filesApi: { all: vi.fn(), version: vi.fn() },
  foldersApi: { all: vi.fn() },
}))

vi.mock('@/stores/live', () => ({
  useLiveStore: () => ({ resourceEvent: null }),
}))

vi.mock('@/utils/accountBoundary', () => ({
  getAccountBoundaryEpoch: () => 0,
}))

function file(overrides: Partial<FileMeta>): FileMeta {
  return {
    id: 1, displayName: '文件', ext: 'png', space: 'personal',
    workspaceDirectoryId: null, projectId: null, projectName: null,
    projectColor: null, stageName: '', folderId: null, folderName: null,
    mindMapId: null, size: '1 KB', sizeBytes: 1, mimeType: 'image/png',
    createdAt: '2026-09-09', deletedAt: null, imgWidth: null, imgHeight: null,
    version: 1, ...overrides,
  } as FileMeta
}

function folder(overrides: Partial<FolderMeta>): FolderMeta {
  return {
    id: 1, name: '目录', projectId: null, workspaceDirectoryId: null,
    parentId: null, fileCount: 0, version: 1, ...overrides,
  } as FolderMeta
}

describe('filesCache 空间索引', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('不会把独立 Workspace 根文件和文件夹混入个人根目录', () => {
    const store = useFilesCacheStore()
    const personal = file({ id: 1, displayName: '个人文件' })
    const workspace = file({
      id: 2, displayName: 'F1 图表', space: 'workspace', workspaceDirectoryId: 34,
    })
    const personalFolder = folder({ id: 1, name: '个人目录' })
    const workspaceFolder = folder({ id: 2, name: 'scripts', workspaceDirectoryId: 34 })
    store.allFiles = [personal, workspace]
    store.allFolders = [personalFolder, workspaceFolder]

    expect(store.getPersonalRootFiles()).toEqual([personal])
    expect(store.getPersonalRootFolders()).toEqual([personalFolder])
  })

  it('Workspace 投影按目录和父级过滤文件及文件夹', () => {
    const store = useFilesCacheStore()
    const rootFile = file({ id: 10, displayName: '根文件', space: 'workspace', workspaceDirectoryId: 34 })
    const nestedFile = file({ id: 11, displayName: '子目录文件', space: 'workspace', workspaceDirectoryId: 34, folderId: 20 })
    const otherWorkspaceFile = file({ id: 12, displayName: '其他工作区文件', space: 'workspace', workspaceDirectoryId: 35 })
    const rootFolder = folder({ id: 20, name: 'scripts', workspaceDirectoryId: 34 })
    const nestedFolder = folder({ id: 21, name: 'charts', workspaceDirectoryId: 34, parentId: 20 })
    const otherWorkspaceFolder = folder({ id: 22, name: '其他工作区目录', workspaceDirectoryId: 35 })
    store.allFiles = [rootFile, nestedFile, otherWorkspaceFile]
    store.allFolders = [rootFolder, nestedFolder, otherWorkspaceFolder]

    expect(store.getWorkspaceFiles(34)).toEqual([rootFile])
    expect(store.getWorkspaceFiles(34, 20)).toEqual([nestedFile])
    expect(store.getWorkspaceFolders(34)).toEqual([rootFolder])
    expect(store.getWorkspaceFolders(34, 20)).toEqual([nestedFolder])
  })
})
