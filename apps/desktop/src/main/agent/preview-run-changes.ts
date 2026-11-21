import type { ServerResponse } from 'node:http'
import { encodeAgentChatSse } from '@gugu/core/agent/chat-sse'

export function streamPreviewRunChanges(res: ServerResponse,
  subscribe: (listener: (sessionId: number) => void) => () => void,
): Promise<void> {
  if (res.destroyed) return Promise.resolve()
  res.setHeader('X-Accel-Buffering', 'no')
  res.write(encodeAgentChatSse({ type: 'ready' }))
  return new Promise(resolve => {
    const unsubscribe = subscribe(sessionId => {
      if (res.destroyed) return
      if (res.writableLength >= 65_536) { res.destroy(); return }
      res.write(encodeAgentChatSse({ type: 'run_changed', session_id: sessionId }))
    })
    res.once('close', () => { unsubscribe(); resolve() })
  })
}
