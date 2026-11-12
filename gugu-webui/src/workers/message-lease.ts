export type MessageClaimState = 'claimed' | 'busy' | 'completed'

/** 持久存储负责以原子操作执行认领与完成状态变更。 */
export interface MessageLeaseStore {
  claim(
    stateKey: string,
    owner: string,
    leaseSeconds: number,
  ): Promise<MessageClaimState>
  complete(stateKey: string, owner: string, completedSeconds: number): Promise<boolean>
}

/** 队列适配器只在完成状态已持久化后确认消息。 */
export type AcknowledgeMessage = (messageId: string) => Promise<void>

/**
 * 编排消息执行租约和队列确认顺序。Redis/Lua 等持久原子存储及 Worker
 * 生命周期由集成层提供；此协调器不自行保存跨进程状态。
 */
export class MessageLeaseCoordinator {
  constructor(
    private readonly store: MessageLeaseStore,
    private readonly acknowledgeMessage: AcknowledgeMessage,
    private readonly leaseSeconds = 120,
    private readonly completedSeconds = 3600,
  ) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1)
      throw new RangeError('消息租约时长必须为正整数')
    if (!Number.isSafeInteger(completedSeconds) || completedSeconds < 1)
      throw new RangeError('完成状态保留时长必须为正整数')
  }

  async claim(messageId: string, stateKey: string, owner: string): Promise<MessageClaimState> {
    const result = await this.store.claim(
      stateKey,
      owner,
      this.leaseSeconds,
    )
    if (result === 'completed') await this.acknowledgeMessage(messageId)
    return result
  }

  async acknowledge(messageId: string, stateKey: string, owner: string): Promise<boolean> {
    const completed = await this.store.complete(stateKey, owner, this.completedSeconds)
    if (!completed) return false
    await this.acknowledgeMessage(messageId)
    return true
  }
}
