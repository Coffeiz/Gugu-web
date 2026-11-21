// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findFileCopyConflicts } from '@/composables/files/useFilePasteCore'

describe('文件复制冲突的共同规则', () => {
  it('按源选择顺序返回同名同后缀冲突，保留目标 ID 并跳过缺失源文件', () => {
    const sources = new Map([
      [1, { id: 1, displayName: '计划', ext: 'MD' }],
      [2, { id: 2, displayName: '封面', ext: 'PNG' }],
    ])
    const destination = [
      { id: 11, displayName: '计划', ext: 'MD' },
      { id: 12, displayName: '封面', ext: 'PNG' },
    ]
    expect(findFileCopyConflicts([2, 99, 1], id => sources.get(id), destination)).toEqual([
      { filename: '封面.PNG', existingFile: { id: 12 } },
      { filename: '计划.MD', existingFile: { id: 11 } },
    ])
    expect(destination).toHaveLength(2)
  })

  it('名称与后缀都严格匹配，目标目录之外或只有后缀不同不会触发覆盖选择', () => {
    const source = { id: 1, displayName: '计划', ext: 'MD' }
    expect(findFileCopyConflicts([1], () => source, [
      { id: 2, displayName: '计划', ext: 'TXT' },
      { id: 3, displayName: '计划', ext: 'md' },
      { id: 4, displayName: '计划副本', ext: 'MD' },
    ])).toEqual([])
    expect(findFileCopyConflicts([1], () => source, [])).toEqual([])
  })
})
