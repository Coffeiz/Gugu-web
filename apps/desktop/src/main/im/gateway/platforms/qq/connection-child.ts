import { createQqConnection, createQqSocketFactory, type QqMessageEvent } from '@gugu/gateway/qq'
import { desktopTransportOptions } from '@gugu/core/providers/node'

export type QqChildRequest =
  | { id: number; method: 'token' | 'url' }
  | { id: number; method: 'event'; kind: QqMessageEvent; data: Readonly<Record<string, unknown>> }
export type QqChildMessage = QqChildRequest | { method: 'ready'; value: boolean } | { method: 'report'; code: string } | { method: 'cancel'; id: number }
export type QqHostMessage = { id: number; value?: string | void; failed?: boolean } | { stop: true }

const port = (process as NodeJS.Process & {
  parentPort?: {
    postMessage(message: QqChildMessage): void
    on(event: 'message', listener: (message: { data: QqHostMessage }) => void): void
  }
}).parentPort ?? (process.send ? {
  postMessage: (message: QqChildMessage) => { if (process.connected) process.send!(message, () => {}) },
  on: (_event: 'message', listener: (message: { data: QqHostMessage }) => void) => {
    process.on('message', data => listener({ data: data as QqHostMessage }))
  },
} : undefined)
if (!port) throw new Error('缺少 QQ 网关宿主连接')

let next = 0
const pending = new Map<number, (reply: QqHostMessage) => void>()
function request(message: Omit<Extract<QqChildRequest, { method: 'event' }>, 'id'> | { method: 'token' | 'url' }, signal: AbortSignal) {
  signal.throwIfAborted()
  const id = ++next
  return new Promise<string | void>((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      port!.postMessage({ method: 'cancel', id })
      reject(new Error('QQ 网关请求已取消'))
    }
    pending.set(id, reply => {
      signal.removeEventListener('abort', abort)
      if ('id' in reply && !reply.failed) resolve(reply.value)
      else reject(new Error('QQ 网关宿主请求失败'))
    })
    signal.addEventListener('abort', abort, { once: true })
    port!.postMessage({ ...message, id })
  })
}

const connection = createQqConnection({
  async getAccessToken(signal) { return String(await request({ method: 'token' }, signal) ?? '') },
  async getGateway(_token, signal) { return String(await request({ method: 'url' }, signal) ?? '') },
  openSocket: createQqSocketFactory({ allowDirect: true, resolve: desktopTransportOptions().resolve }),
  async onEvent(kind, data, signal) { await request({ method: 'event', kind, data }, signal) },
  onReadyChange: value => port.postMessage({ method: 'ready', value }),
  report: code => port.postMessage({ method: 'report', code }),
})
port.on('message', ({ data }) => {
  if ('stop' in data) {
    void connection.stop().then(() => process.exit(0), () => process.exit(1))
    return
  }
  const callback = pending.get(data.id)
  pending.delete(data.id)
  callback?.(data)
})
process.once('disconnect', () => { void connection.stop().finally(() => process.exit(0)) })
void connection.closed.then(() => process.exit(0), () => process.exit(1))
