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
  it('反向创建经服务端归一后删除，Runtime endpoint 可再次注册', () => {
    const registered = new Set<string>()
    const keyOf = (connection: NodeConnectionEndpoint) => [
      connection.sourceObjectId,
      connection.sourcePortId,
      connection.targetObjectId,
      connection.targetPortId,
    ].join(':')
    const register = (connection: NodeConnectionEndpoint) => {
      const key = keyOf(connection)
      if (registered.has(key)) return false
      registered.add(key)
      return true
    }
    const unregister = (connection: NodeConnectionEndpoint) => registered.delete(keyOf(connection))

    expect(register(reverseConnection)).toBe(true)
    const optimistic = setRelationRuntimeConnection({}, -1, reverseConnection)
    // 后端将 20 -> 10 归一为 10 -> 20，但 Runtime 仍持有用户实际拖出的方向。
    const persisted = transferRelationRuntimeConnection(optimistic, -1, 42)
    const removed = takeRelationRuntimeConnection(persisted, 42)

    expect(removed.connection).toEqual(reverseConnection)
    expect(removed.registry).toEqual({})
    expect(unregister(removed.connection!)).toBe(true)
    expect(register(reverseConnection)).toBe(true)
  })
})
