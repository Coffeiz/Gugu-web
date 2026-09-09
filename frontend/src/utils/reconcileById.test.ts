import { describe, expect, it } from 'vitest'
import { reconcileOptimisticById, upsertById } from './reconcileById'

describe('服务端创建结果对账', () => {
  it('实时 create 先到时，确认结果会替换临时项并移除重复实体', () => {
    const items: Array<{ id: string | number; _uid?: string; name: string }> = [
      { id: 'u-1', _uid: 'u-1', name: '测试' },
      { id: 42, name: '测试' },
      { id: 7, name: '其他' },
    ]

    const result = reconcileOptimisticById(items, 'u-1', { id: 42, _uid: 'u-1', name: '测试' })

    expect(result).toEqual([
      { id: 42, _uid: 'u-1', name: '测试' },
      { id: 7, name: '其他' },
    ])
  })

  it('HTTP 响应先到时，按服务端 ID 更新而不是追加第二条', () => {
    const result = upsertById(
      [{ id: '42', name: '旧数据' }, { id: 7, name: '其他' }],
      { id: 42, name: '新数据' },
    )

    expect(result).toEqual([{ id: 42, name: '新数据' }, { id: 7, name: '其他' }])
  })
})
