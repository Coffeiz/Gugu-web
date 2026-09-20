import { describe, expect, it, vi } from 'vitest'
import type { FileMeta } from '@/stores/filesCache'
import { useProjectFileRename } from './useProjectFileRename'

function makeFile(ext: string): FileMeta {
  return { id: 21, displayName: 'guide', ext, version: 1 } as FileMeta
}

describe('项目文件分段重命名', () => {
  it('同时提交名称与后缀，后缀标准化为大写', () => {
    const file = makeFile('TXT')
    const renameFile = vi.fn()
    const rename = useProjectFileRename({ renameFile, renameFolder: vi.fn() })
    rename.startRename(file)
    rename.renameText.value = 'manual'
    rename.renameExtension.value = 'pdf'

    rename.commitRename()

    expect(renameFile).toHaveBeenCalledWith(file.id, 'manual', 'PDF')
  })

  it('清空已有后缀时不提交并保留编辑状态', () => {
    const file = makeFile('TXT')
    const renameFile = vi.fn()
    const onInvalidExtension = vi.fn()
    const rename = useProjectFileRename({ renameFile, renameFolder: vi.fn(), onInvalidExtension })
    rename.startRename(file)
    rename.renameExtension.value = ''

    rename.commitRename()

    expect(renameFile).not.toHaveBeenCalled()
    expect(onInvalidExtension).toHaveBeenCalledOnce()
    expect(rename.renamingFileId.value).toBe(file.id)
  })
})
