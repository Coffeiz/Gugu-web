import { describe, expect, it } from 'vitest'
import { createRelationRuntimeConnection } from './relationRuntimeConnection'

describe('画布 relation 的 Runtime endpoint', () => {
  it('只注销当前 relation 的端点，不影响同一节点对的平行边', () => {
    expect(createRelationRuntimeConnection(
      { srcSide: 'right', dstSide: 'left' },
      'mind:1',
      'mind:2',
    )).toEqual({
      sourceObjectId: 'mind:1',
      sourcePortId: 'right',
      targetObjectId: 'mind:2',
      targetPortId: 'left',
    })
  })

  it('缺少历史端点数据时返回 null，交给兼容清理路径处理', () => {
    expect(createRelationRuntimeConnection(undefined, 'mind:1', 'mind:2')).toBeNull()
  })
})
