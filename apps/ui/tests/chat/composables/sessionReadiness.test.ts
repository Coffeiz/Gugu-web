import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { waitForSessionSettlement } from '@/components/common/gugu-chat/composables/sessionReadiness'

describe('聊天会话布局就绪等待', () => {
  it('同会话首次恢复仍在结算时等待，结算完成后再继续定位', async () => {
    const sessionId = ref<number | null>(2536)
    const sessionSettling = ref(true)
    let settled = false

    const ready = waitForSessionSettlement(sessionId, sessionSettling, 2536).then(() => {
      settled = true
    })

    expect(settled).toBe(false)
    sessionSettling.value = false
    await ready

    expect(settled).toBe(true)
  })

  it('等待期间切换到其他会话时解除旧会话等待', async () => {
    const sessionId = ref<number | null>(2536)
    const sessionSettling = ref(true)
    let settled = false

    const ready = waitForSessionSettlement(sessionId, sessionSettling, 2536).then(() => {
      settled = true
    })

    sessionId.value = 3000
    await ready

    expect(settled).toBe(true)
  })
})
