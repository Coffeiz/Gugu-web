import { MAX_FRAME, boundedFrame, desktopFrame } from '../commands.js'
import type { LocalRuntime } from '../local.js'

export interface IpcPort {
  on(event: 'message' | 'close', listener: (message: unknown) => void): unknown
  off(event: 'message' | 'close', listener: (message: unknown) => void): unknown
  postMessage(message: unknown): void
}

// Host 注入消息端口；Core 不依赖 Electron，也不信任 Renderer 的来源/身份。
export function attachIpcTransport(
  runtime: Pick<LocalRuntime, 'call' | 'schemaVersion' | 'close'>,
  port: IpcPort,
): { close(): Promise<void> } {
  let queue = Promise.resolve(),
    pending = 0,
    closed = false,
    closing: Promise<void> | undefined
  const send = (frame: Record<string, unknown>) =>
    port.postMessage(JSON.parse(boundedFrame(frame)))
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    port.off('message', receive)
    port.off('close', disconnected)
    closing = queue.finally(() => runtime.close())
    return closing
  }
  const disconnected = () => {
    void close().catch(() => undefined)
  }
  const receive = (raw: unknown) => {
    if (closed) return
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) + 1 > MAX_FRAME) {
        send({
          v: 2,
          id: null,
          error: { code: 'invalid_frame', message: '桌面请求超出协议限制' },
        })
        void close().catch(() => undefined)
        return
      }
      if (pending >= 128) {
        send({
          v: 2,
          id: null,
          error: { code: 'busy', message: '本地数据队列已满' },
        })
        return
      }
    } catch {
      send({
        v: 2,
        id: null,
        error: { code: 'invalid_request', message: '桌面请求无效' },
      })
      return
    }
    pending++
    queue = queue
      .then(async () => {
        send(await desktopFrame(raw, runtime))
      })
      .catch(() => {
        disconnected()
      })
      .finally(() => {
        pending--
      })
  }
  port.on('message', receive)
  port.on('close', disconnected)
  send({
    v: 2,
    event: 'ready',
    schema: runtime.schemaVersion,
    capabilities: ['operation_receipts'],
  })
  return { close }
}
