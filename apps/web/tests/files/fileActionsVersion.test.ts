import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileActions } from '@/composables/files/useFileActions'
import { useFilesCacheStore, type FileMeta } from '@/stores/filesCache'

const { updateFileRequest } = vi.hoisted(() => ({ updateFileRequest: vi.fn() }))

vi.mock('@/services/api', () => ({
  filesApi: {
    update: updateFileRequest,
    get: vi.fn(),
  },
  foldersApi: {},
}))

describe('文件改名和移动的版本条件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    updateFileRequest.mockReset()
  })

  it('提交缓存版本并把服务端递增后的版本回填缓存', async () => {
    const cache = useFilesCacheStore()
    cache.addFile({
      id: 7, displayName: '原名', ext: 'md', version: 4,
    } as FileMeta)
    updateFileRequest.mockImplementation(async (_id, body) => ({
      id: 7, displayName: body.displayName, ext: 'md', version: body.version + 1,
    }))

    const result = await useFileActions().renameFile(7, '新名')

    expect(updateFileRequest).toHaveBeenCalledWith(7, { displayName: '新名', version: 4 }, undefined)
    expect(result.version).toBe(5)
    expect(cache.getFile(7)?.version).toBe(5)
  })
})
