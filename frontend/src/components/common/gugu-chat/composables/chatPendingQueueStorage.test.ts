import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPendingQueueKey,
  getDraftPendingQueueId,
  getSessionPendingQueueId,
  isPendingQueueRecoveryNeeded,
  setPendingQueueRecoveryNeeded,
} from './chatPendingQueueStorage'

const QUEUE_ID_STORAGE_KEY = 'gugu-chat-pending-queue-id-v1'

describe('聊天待发队列标识', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('正式队列按会话 ID 稳定命名，跨浏览器得到相同队列', () => {
    expect(getSessionPendingQueueId(41)).toBe('session-41')
    window.sessionStorage.clear()
    expect(getSessionPendingQueueId(41)).toBe('session-41')
    expect(getSessionPendingQueueId(52)).not.toBe(getSessionPendingQueueId(41))
  })

  it('草稿队列使用标签级持久 ID', () => {
    const draftId = getDraftPendingQueueId()

    expect(window.sessionStorage.getItem(QUEUE_ID_STORAGE_KEY)).toBe(draftId)
    expect(getDraftPendingQueueId()).toBe(draftId)
  })

  it('没有已保存标识时生成新的草稿 ID', () => {
    const draft = getDraftPendingQueueId()
    window.sessionStorage.clear()

    const otherDraft = getDraftPendingQueueId()
    expect(otherDraft).not.toBe(draft)
  })

  it('队列项使用跨浏览器碰撞概率极低的正整数 key', () => {
    const first = createPendingQueueKey()
    const second = createPendingQueueKey()
    expect(Number.isSafeInteger(first)).toBe(true)
    expect(first).toBeGreaterThan(0)
    expect(second).not.toBe(first)
  })

  it('只记录下次打开时是否需要恢复，不保存队列正文', () => {
    const draftId = getDraftPendingQueueId()
    setPendingQueueRecoveryNeeded(true)
    expect(isPendingQueueRecoveryNeeded()).toBe(true)
    expect(window.sessionStorage.getItem('gugu-chat-pending-queue-recovery-v1')).toBe('1')

    setPendingQueueRecoveryNeeded(false)
    expect(isPendingQueueRecoveryNeeded()).toBe(false)
    expect(window.sessionStorage.getItem(QUEUE_ID_STORAGE_KEY)).toBe(draftId)
    expect(isPendingQueueRecoveryNeeded()).toBe(false)
  })
})
