import { dataContext } from '../contracts/index.js'

export interface MemoryClearPorts {
  clearOwner(ownerId: string): Promise<unknown>
  enqueueMemoryRebuild(ownerId: string): Promise<unknown>
  bumpContextRevision(ownerId: string, resource: 'memory'): Promise<unknown>
}

/** 删除当前用户派生记忆并使 Agent 上下文快照失效；实际存储根由 Host 绑定。 */
export function createMemoryClearer(ports: MemoryClearPorts) {
  return async (rawOwnerId: string): Promise<void> => {
    const ownerId = dataContext(rawOwnerId).ownerId
    await ports.clearOwner(ownerId)
    await ports.enqueueMemoryRebuild(ownerId)
    await ports.bumpContextRevision(ownerId, 'memory')
  }
}
