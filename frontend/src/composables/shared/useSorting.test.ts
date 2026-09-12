import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import { readStoredFileSort, SORT_OPTION_KEYS, useSorting } from './useSorting'

const FILES_KEY = 'gugu-file-sort:files'

function storage(): Storage {
  return window.localStorage
}

describe('排序选择持久化（方案 A：localStorage 按 surface 分 key）', () => {
  beforeEach(() => {
    storage().clear()
  })

  it('选择排序键写入 {key, dir}，重新初始化时恢复', () => {
    const first = useSorting('files')
    first.onSortSelect('createdAt')
    expect(storage().getItem(FILES_KEY)).toBe(JSON.stringify({ key: 'createdAt', dir: 'asc' }))

    // 同键再点一次切方向，整对持久化。
    const second = useSorting('files')
    expect(second.sortKey.value).toBe('createdAt')
    second.onSortSelect('createdAt')
    expect(second.sortDir.value).toBe('desc')
    expect(readStoredFileSort('files')).toEqual({ key: 'createdAt', dir: 'desc' })

    // 第三个实例从存储恢复：键与方向都不丢。
    const third = useSorting('files')
    expect(third.sortKey.value).toBe('createdAt')
    expect(third.sortDir.value).toBe('desc')
  })

  it('不同 surface 各自独立记录', () => {
    const files = useSorting('files')
    files.onSortSelect('size')
    const modal = useSorting('project-modal')
    expect(modal.sortKey.value).toBe('name')
    modal.onSortSelect('type')
    expect(readStoredFileSort('files')).toEqual({ key: 'size', dir: 'asc' })
    expect(readStoredFileSort('project-modal')).toEqual({ key: 'type', dir: 'asc' })
  })

  it('脏存储（白名单外/解析失败）回默认，不抛错', () => {
    storage().setItem(FILES_KEY, JSON.stringify({ key: 'hacked', dir: 'asc' }))
    expect(readStoredFileSort('files')).toBeNull()
    expect(useSorting('files').sortKey.value).toBe('name')

    storage().setItem(FILES_KEY, '{not-json')
    expect(readStoredFileSort('files')).toBeNull()

    storage().setItem(FILES_KEY, JSON.stringify({ key: 'name', dir: 'up' }))
    expect(readStoredFileSort('files')).toBeNull()
  })

  it('不传 storageKey 保持纯内存行为，不写 storage', () => {
    const plain = useSorting()
    plain.onSortSelect('type')
    expect(plain.sortKey.value).toBe('type')
    expect(storage().length).toBe(0)
  })

  it('白名单覆盖全部排序选项', () => {
    expect(SORT_OPTION_KEYS).toContain('name')
    for (const key of SORT_OPTION_KEYS) {
      storage().setItem(FILES_KEY, JSON.stringify({ key, dir: 'desc' }))
      expect(readStoredFileSort('files')).toEqual({ key, dir: 'desc' })
    }
  })
})
