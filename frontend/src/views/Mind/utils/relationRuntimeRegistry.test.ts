import { describe, expect, it } from 'vitest'
import type { NodeConnectionEndpoint } from '@/interaction/runtime'
import {
  setRelationRuntimeConnection,
  takeRelationRuntimeConnection,
  transferRelationRuntimeConnection,
} from './relationRuntimeRegistry'

const reverseConnection: NodeConnectionEndpoint = {
  sourceObjectId: 'mind:20',
  sourcePortId: 'right',
  targetObjectId: 'mind:10',
  targetPortId: 'left',
}

describe('画布 relation 的 Runtime connection 生命周期', () => {
  it('服务端归一 relation 方向后仍保留原始 Runtime endpoint，删除后可再次使用', () => {
    const optimistic = setRelationRuntimeConnection({}, -1, reverseConnection)
    const persisted = transferRelationRuntimeConnection(optimistic, -1, 42)
    const removed = takeRelationRuntimeConnection(persisted, 42)

    expect(removed.connection).toEqual(reverseConnection)
    expect(removed.registry).toEqual({})
  })
})
