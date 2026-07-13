import { describe, it, expect } from 'vitest'
import { resolveFolderIds } from '@/utils/folderKeys'

const folders = [
  { id: 'f:65', folderId: 65 },
  { id: 'f:66', folderId: 66 },
  { id: 'f:70', folderId: 70 },
]

describe('resolveFolderIds', () => {
  it('key 列表 → 对应数字 folderId', () => {
    expect(resolveFolderIds(['f:65', 'f:70'], folders)).toEqual([65, 70])
  })
  it('不在当前文件夹列表里的陈旧 key 被丢弃', () => {
    expect(resolveFolderIds(['f:65', 'f:999'], folders)).toEqual([65])
  })
  it('保持传入顺序', () => {
    expect(resolveFolderIds(['f:70', 'f:65', 'f:66'], folders)).toEqual([70, 65, 66])
  })
  it('接受 Set 作为入参（selectedFolderKeys 是 Set）', () => {
    expect(resolveFolderIds(new Set(['f:66']), folders)).toEqual([66])
  })
  it('空输入 → 空数组', () => {
    expect(resolveFolderIds([], folders)).toEqual([])
    expect(resolveFolderIds(['f:65'], [])).toEqual([])
  })
})
