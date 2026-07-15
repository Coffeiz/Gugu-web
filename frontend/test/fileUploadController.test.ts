import { describe, expect, it } from 'vitest'
import { getTopLevelUploadGroups } from '@/composables/files/useFileUploadController'

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
