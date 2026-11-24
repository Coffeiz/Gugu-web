// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { uploadWorkspaceFile } from '@/composables/files/useFileUploadCore'
import { pathFilesApi } from '@/services/api'

vi.mock('@/services/api', () => ({
  pathFilesApi: { entries: vi.fn(), upload: vi.fn() },
}))

it('路径上传先等待同名选择，保留两者会避开已占用后缀，取消不会写入', async () => {
  const file = new File(['新内容'], '方案.txt')
  const target = { directoryId: 'personal', relativePath: '资料' } as const
  const upload = vi.mocked(pathFilesApi.upload)
  const progress = vi.fn()
  vi.mocked(pathFilesApi.entries).mockResolvedValue(['方案.txt', '方案 (1).txt'].map(name => ({
    name, kind: 'file', relativePath: `资料/${name}`, size: 3, mimeType: 'text/plain',
  })))
  const item = { file, relativePath: file.name }
  const prompt = vi.fn(async () => {
    expect(upload).not.toHaveBeenCalled()
    return new Map([[file.name, { action: 'keep_both' as const }]])
  })

  await uploadWorkspaceFile(target, item, progress, prompt, () => true)
  expect(prompt).toHaveBeenCalledWith([{ filename: file.name, canOverwrite: true }])
  expect(upload).toHaveBeenCalledWith({ ...target, relativePath: '资料/方案 (2).txt' }, file, progress, false)
  upload.mockClear()
  await expect(uploadWorkspaceFile(target, item, progress, async () => new Map(), () => true)).resolves.toBe(false)
  expect(upload).not.toHaveBeenCalled()
})
