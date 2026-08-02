import { describe, expect, it, vi } from 'vitest'
import { uploadFilesWithFolders } from '@/composables/useFileUpload'
import { getTopLevelUploadGroups } from '@/composables/files/useFileUploadController'

vi.mock('@/composables/useFileUpload', async importOriginal => {
  const actual = await importOriginal<typeof import('@/composables/useFileUpload')>()
  return { ...actual, uploadFilesWithFolders: vi.fn() }
})

describe('getTopLevelUploadGroups', () => {
  it('按顶层目录聚合文件数量，不修改上传列表', () => {
    const items = [
      { file: new File([''], 'a.md'), relativePath: 'docs/a.md' },
      { file: new File([''], 'b.md'), relativePath: 'docs/sub/b.md' },
      { file: new File([''], 'c.md'), relativePath: 'notes/c.md' },
      { file: new File([''], 'root.md'), relativePath: 'root.md' },
    ]
    expect(getTopLevelUploadGroups(items)).toEqual([
      { name: 'docs', total: 2 },
      { name: 'notes', total: 1 },
    ])
    expect(items).toHaveLength(4)
  })
})

describe('executeUploadLifecycle', () => {
  it('上传成功后移除文件 ghost，并完成顶层文件夹 ghost', async () => {
    const { executeUploadLifecycle } = await import('@/composables/files/useFileUploadController')
    vi.mocked(uploadFilesWithFolders).mockImplementationOnce(async (_items, options) => {
      await options.uploadOne(new File([''], 'a.txt'), null, 'docs/a.txt')
      options.onFolderCreated?.({ id: 1, name: 'docs', parentId: null, projectId: null })
      return []
    })

    const events: string[] = []
    const folderGhost = { name: 'docs' }
    await executeUploadLifecycle([{ file: new File([''], 'a.txt'), relativePath: 'docs/a.txt' }], {
      projectId: null,
      baseFolderId: null,
      folderGroups: [{ name: 'docs', total: 1 }],
      decisions: new Map(),
      createGhost: () => ({ name: 'file' }),
      updateGhostProgress: () => undefined,
      removeGhost: () => events.push('remove-file'),
      failGhost: () => events.push('fail-file'),
      createFolderGhost: () => folderGhost,
      bumpFolderGhost: () => events.push('bump-folder'),
      onFolderCreated: () => events.push('folder-created'),
      onTopFolderReady: () => events.push('folder-ready'),
      uploadOne: async () => undefined,
    })

    expect(events).toEqual(['bump-folder', 'folder-ready', 'folder-created'])
  })

  it('上传失败后标记文件 ghost，不会把失败吞成成功移除', async () => {
    const { executeUploadLifecycle } = await import('@/composables/files/useFileUploadController')
    vi.mocked(uploadFilesWithFolders).mockImplementationOnce(async (_items, options) => {
      await options.uploadOne(new File([''], 'broken.txt'), null, 'broken.txt')
      return []
    })

    const events: string[] = []
    await executeUploadLifecycle([{ file: new File([''], 'broken.txt'), relativePath: 'broken.txt' }], {
      projectId: null,
      baseFolderId: null,
      folderGroups: [],
      decisions: new Map(),
      createGhost: () => ({ name: 'file' }),
      updateGhostProgress: () => undefined,
      removeGhost: () => events.push('remove'),
      failGhost: () => events.push('fail'),
      createFolderGhost: () => ({ name: 'folder' }),
      bumpFolderGhost: () => undefined,
      onFolderCreated: () => undefined,
      onTopFolderReady: () => undefined,
      uploadOne: async () => { throw new Error('upload failed') },
    })

    expect(events).toEqual(['fail'])
  })
})
