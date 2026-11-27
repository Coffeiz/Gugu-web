import { once } from 'node:events'
import { createFeishuConnection, createFeishuWsNetwork } from '@gugu/gateway/feishu'
import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'
import type { ChildMessage, GatewayWork, HostMessage } from './process-protocol.js'

const port = (process as NodeJS.Process & {
  parentPort?: {
    postMessage(value: ChildMessage): void
    on(event: 'message', listener: (message: { data: HostMessage }) => void): void
  }
}).parentPort ?? (process.send ? {
  postMessage: (data: ChildMessage) => { if (process.connected) process.send!(data, () => {}) },
  on: (_event: 'message', listener: (message: { data: HostMessage }) => void) => {
    process.on('message', data => listener({ data: data as HostMessage }))
  },
} : undefined)
if (!port) throw new Error('缺少网关宿主连接')
const send = (value: ChildMessage) => port.postMessage(value)
const lifetime = new AbortController()
const pending = new Map<number, (reply: Extract<HostMessage, { kind: 'answer' }>) => void>()
let started = false
let sequence = 0

async function forward(card: boolean, data: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  const id = ++sequence
  return new Promise<unknown>((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      send({ kind: 'cancel', id })
      reject(new Error('网关事件已取消'))
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.set(id, reply => {
      signal.removeEventListener('abort', abort)
      if (reply.ok) resolve(reply.value)
      else reject(new Error('网关宿主处理失败'))
    })
    send({ kind: 'event', id, card, data })
  })
}

async function run(work: GatewayWork) {
  const { signal } = lifetime
  if (work.kind === 'poll') {
    const network = createNodeProviderTransport(desktopTransportOptions(false, async () => work.proxy))
    try {
      const response = await network.request(work.request, signal)
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength
          if (size > 4 * 1024 * 1024) throw new Error('网关轮询响应过大')
          chunks.push(chunk)
        }
      } finally { await response.cancel() }
      send({ kind: 'result', value: { status: response.status, headers: response.headers, bytes: new Uint8Array(Buffer.concat(chunks)) } })
    } finally { await network.close?.() }
    if (!signal.aborted) await once(signal, 'abort')
    return
  }

  const handle = await createFeishuConnection({
    appId: work.appId, appSecret: work.appSecret, readyTimeoutMs: work.readyTimeoutMs, signal,
    wsNetwork: createFeishuWsNetwork({ allowDirect: true }),
    transport: createNodeProviderTransport(desktopTransportOptions(false, async () => work.proxy)),
    async onMessage(data, eventSignal) { await forward(false, data, eventSignal) },
    onCardAction: (data, eventSignal) => forward(true, data, eventSignal),
    report(event) {
      if (event === 'sdk-error' || event === 'sdk-warning' || event === 'connection-failed' || event === 'cleanup-failed')
        send({ kind: 'diagnostic', code: `feishu-${event}` })
    },
  })
  send({ kind: 'result' })
  const stop = () => { void handle.stop().catch(() => {}) }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try { await handle.closed } finally { signal.removeEventListener('abort', stop) }
}

process.once('disconnect', () => { lifetime.abort(); if (!started) process.exit(0) })
port.on('message', ({ data }) => {
  if (data.kind === 'stop') { lifetime.abort(); if (!started) process.exit(0); return }
  if (data.kind === 'answer') {
    const callback = pending.get(data.id)
    pending.delete(data.id)
    callback?.(data)
    return
  }
  if (started) return
  started = true
  void run(data.work).then(() => process.exit(0), () => {
    if (!lifetime.signal.aborted) send({ kind: 'failure' })
    process.exit(lifetime.signal.aborted ? 0 : 1)
  })
})
