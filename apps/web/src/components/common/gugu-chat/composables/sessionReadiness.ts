import { watch, type Ref } from 'vue'

/** 等待目标会话正在进行的首次加载/布局结算结束；会话切走时也解除等待。 */
export function waitForSessionSettlement(
  sessionId: Readonly<Ref<number | null>>,
  sessionSettling: Readonly<Ref<boolean>>,
  targetSessionId: number,
): Promise<void> {
  if (sessionId.value !== targetSessionId || !sessionSettling.value) return Promise.resolve()

  return new Promise((resolve) => {
    const stop = watch([sessionId, sessionSettling], ([currentId, settling]) => {
      if (currentId !== targetSessionId || !settling) {
        stop()
        resolve()
      }
    }, { flush: 'sync' })

    if (sessionId.value !== targetSessionId || !sessionSettling.value) {
      stop()
      resolve()
    }
  })
}
