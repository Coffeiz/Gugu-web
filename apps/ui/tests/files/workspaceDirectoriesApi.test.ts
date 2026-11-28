// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceDirectoriesApi } from '@/services/api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Workspace Directory API', () => {
  it('把 Python/Core 删除预览的 snake_case 计数转换为 UI 使用的字段', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 7,
      name: '数据分析',
      directory_name: 'workspace-7',
      is_default: false,
      is_system: false,
      file_count: 2,
      folder_count: 3,
      bound_session_count: 4,
      bound_task_count: 5,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(workspaceDirectoriesApi.previewDelete(7)).resolves.toEqual({
      id: 7,
      name: '数据分析',
      directoryName: 'workspace-7',
      isDefault: false,
      isSystem: false,
      fileCount: 2,
      folderCount: 3,
      boundSessionCount: 4,
      boundTaskCount: 5,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/workspace-directories/7/delete-preview')
  })
})
