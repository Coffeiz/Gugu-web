import { describe, expect, it } from 'vitest'
import { sortFileProjection } from '@/composables/files/useFileProjection'

type Item = { id: number; name: string; size: number }

const sorters = {
  name: (item: Item) => item.name,
  type: (item: Item) => item.name,
  size: (item: Item) => item.size,
  id: (item: Item) => item.id,
}

describe('sortFileProjection', () => {
  const items: Item[] = [
    { id: 2, name: '乙', size: 20 },
    { id: 1, name: '甲', size: 10 },
  ]

  it('按文本字段排序且不修改原数组', () => {
    expect(sortFileProjection(items, 'name', 'asc', sorters).map(item => item.id)).toEqual([1, 2])
    expect(items.map(item => item.id)).toEqual([2, 1])
  })

  it('按数字字段支持降序', () => {
    expect(sortFileProjection(items, 'size', 'desc', sorters).map(item => item.id)).toEqual([2, 1])
  })
})
