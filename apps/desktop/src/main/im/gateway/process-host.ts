import { app, utilityProcess } from 'electron'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import type { ProviderTransport } from '@gugu/core/providers'
import type { NodeProviderTransportOptions } from '@gugu/core/providers/node'
import type { createFeishuConnection } from '@gugu/gateway/feishu'
import type { ChildMessage, GatewayWork, HostMessage, PollResult } from './process-protocol.js'

function startGatewayWork(work: GatewayWork, signal: AbortSignal,
  executable?: string, onEvent?: (card: boolean, data: unknown, signal: AbortSignal) => Promise<unknown>,
  onDiagnostic?: (code: Extract<ChildMessage, { kind: 'diagnostic' }>['code']) => void) {
  signal.throwIfAborted()
  const root = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  const binary = executable ? fork('--gateway', ['platforms'], {
    execPath: executable, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  }) : undefined
  const utility = binary ? undefined : utilityProcess.fork(join(root, 'dist/gateway/platforms.cjs'), [], {
    serviceName: work.kind === 'feishu' ? '咕咕飞书网关' : '咕咕消息轮询',
    stdio: 'ignore',
  })
  const child = binary ?? utility!
  const lifetime = new AbortController()
  const requests = new Map<number, AbortController>()
  let exited = false
  let received = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const send = (message: HostMessage) => {
    if (exited) return
    if (!binary) utility!.postMessage(message)
    else if (binary.connected) binary.send(message, () => {})
  }
  const stop = () => {
    if (exited || lifetime.signal.aborted) return
    lifetime.abort()
    send({ kind: 'stop' })
    timer = setTimeout(() => child.kill(), 6_000)
  }
  const closed = new Promise<void>(resolve => {
    const finish = () => {
      if (exited) return
      exited = true
      lifetime.abort()
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      resolve()
    }
    if (binary) {
      binary.once('exit', finish)
      binary.once('error', finish)
    } else utility!.once('exit', finish)
  })
  const result = new Promise<unknown>((resolve, reject) => {
    void closed.then(() => {
      if (!received) reject(new Error('网关子进程未完成请求'))
    })
    child.on('message', (message: ChildMessage) => {
      if (message.kind === 'result') {
        received = true
        resolve(message.value)
        if (work.kind === 'poll') stop()
        return
      }
      if (message.kind === 'diagnostic') { onDiagnostic?.(message.code); return }
      if (message.kind === 'failure') { reject(new Error('网关子进程请求失败')); return }
      if (message.kind === 'cancel') { requests.get(message.id)?.abort(); return }
      const request = new AbortController()
      requests.set(message.id, request)
      const active = AbortSignal.any([lifetime.signal, request.signal, signal])
      void Promise.resolve().then(() => {
        active.throwIfAborted()
        if (!onEvent) throw new Error('网关事件处理器不可用')
        return onEvent(message.card, message.data, active)
      }).then(value => send({ kind: 'answer', id: message.id, ok: true, value }),
        () => send({ kind: 'answer', id: message.id, ok: false })).finally(() => requests.delete(message.id))
    })
  })
  signal.addEventListener('abort', stop, { once: true })
  send({ kind: 'start', work })
  if (signal.aborted) stop()
  return { result, closed, async stop() { stop(); await closed } }
}

export async function connectDesktopFeishuProcess(options: Parameters<typeof createFeishuConnection>[0],
  resolveProxy?: NodeProviderTransportOptions['resolveProxy'], executable?: string,
  onDiagnostic?: (code: Extract<ChildMessage, { kind: 'diagnostic' }>['code']) => void) {
  await Promise.all([options.wsNetwork.close(), options.transport?.close?.()])
  const signal = options.signal ?? new AbortController().signal
  const proxy = await resolveProxy?.(new URL('https://open.feishu.cn/callback/ws/endpoint'), signal)
  const worker = startGatewayWork({
    kind: 'feishu', proxy, appId: options.appId, appSecret: options.appSecret, readyTimeoutMs: options.readyTimeoutMs,
  }, signal, executable, (card, data, active) => card ? options.onCardAction(data, active) : options.onMessage(data, active), onDiagnostic)
  try { await worker.result; signal.throwIfAborted() }
  catch (error) { await worker.stop(); throw error }
  return { closed: worker.closed, stop: worker.stop }
}

/** 仅远程执行长轮询 HTTP；游标在宿主持久化确认后仍由共享轮询器推进。 */
export function isolateDesktopImPolling(transport: ProviderTransport, platform: 'telegram' | 'wechat',
  resolveProxy?: NodeProviderTransportOptions['resolveProxy'], executable?: string): ProviderTransport {
  return {
    async request(request, signal) {
      const url = new URL(request.url)
      const poll = request.method === 'POST' && (platform === 'telegram'
        ? url.hostname === 'api.telegram.org' && url.pathname.endsWith('/getUpdates')
        : url.pathname.endsWith('/ilink/bot/getupdates'))
      if (!poll) return transport.request(request, signal)
      const { body } = request
      if (body !== undefined && !(body instanceof Uint8Array)) throw new Error('网关轮询请求格式无效')
      const proxy = await resolveProxy?.(url, signal)
      const worker = startGatewayWork({
        kind: 'poll', proxy,
        request: { url: request.url, method: request.method, headers: request.headers, timeoutMs: request.timeoutMs, body },
      }, signal, executable)
      try {
        const response = await worker.result as PollResult
        signal.throwIfAborted()
        return {
          status: response.status, headers: response.headers,
          body: { async *[Symbol.asyncIterator]() { signal.throwIfAborted(); yield response.bytes } },
          cancel() { return worker.stop() },
        }
      } catch (error) { await worker.stop(); throw error }
    },
    close: () => transport.close?.() ?? Promise.resolve(),
  }
}
