import { expect, it, vi } from 'vitest'
import { desktopPathFileAccess } from '@desktop/files/pathFileAccess'

const request = vi.hoisted(() => vi.fn())
vi.mock('@desktop/bridge/bridge', () => ({ requestDesktopFile: request, callDesktopBridge: vi.fn() }))

it('桌面相对引用校验源文件并限制在所属目录根内', async () => {
  request.mockImplementation(async (input: { action: string; path: string }) => {
    if (input.action === 'reference') return { id: 'path-source' }
    if (input.action === 'list' && input.path === '笔记') return [{ name: '图.png', relativePath: '笔记/图.png', kind: 'file' }]
    return []
  })
  const result = await desktopPathFileAccess.resolveRelative!({ directoryId: 'personal', relativePath: '笔记/计划.md' }, ['图.png', '../../private.txt'])
  expect(result[0]?.file?.relativePath).toBe('笔记/图.png')
  expect(result[1]?.file).toBeNull()
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'reference', path: '笔记/计划.md' }))
})
