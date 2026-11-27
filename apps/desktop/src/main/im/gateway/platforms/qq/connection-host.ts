import { app, utilityProcess } from 'electron'
import { fork } from 'node:child_process'
import { join } from 'node:path'
import type { QqConnectionPorts } from '@gugu/gateway/qq'
import type { QqChildMessage, QqHostMessage } from './connection-child.js'

/** Electron 持有账号与 Core 授权，子进程独占 QQ 长连接。 */
export function createDesktopQqChildConnection(ports: QqConnectionPorts, executable?: string) {
  const root = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  const binary = executable ? fork('--gateway', ['qq'], {
    execPath: executable, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  }) : undefined
  const utility = binary ? undefined : utilityProcess.fork(join(root, 'dist/gateway/qq.cjs'), [], {
    serviceName: '咕咕 QQ 网关',
    stdio: 'ignore',
  })
  const child = binary || utility!
  const lifetime = new AbortController()
  const requests = new Map<number, AbortController>()
  let exited = false
  const closed = new Promise<void>(resolve => {
    const finish = () => {
      if (exited) return
      exited = true
      lifetime.abort()
      ports.onReadyChange?.(false)
      resolve()
    }
    if (binary) {
      binary.once('exit', finish)
      binary.once('error', finish)
    } else utility!.once('exit', finish)
  })
  const reply = (message: QqHostMessage) => {
    if (exited) return
    if (!binary) utility!.postMessage(message)
    else if (binary.connected) binary.send(message, () => {})
  }
  child.on('message', (message: QqChildMessage) => {
    if (lifetime.signal.aborted) return
    if (message.method === 'cancel') { requests.get(message.id)?.abort(); return }
    if (message.method === 'ready') { ports.onReadyChange?.(message.value); return }
    if (message.method === 'report') {
      if (message.code === 'connection-failed' || message.code === 'event-failed'
        || message.code === 'heartbeat-failed' || message.code === 'heartbeat-timeout' || message.code === 'cleanup-failed')
        ports.report?.(message.code)
      return
    }
    const request = new AbortController()
    requests.set(message.id, request)
    const signal = AbortSignal.any([lifetime.signal, request.signal])
    const run = async () => {
      if (message.method === 'token') return ports.getAccessToken(signal)
      if (message.method === 'url') return ports.getGateway('', signal)
      if (message.method === 'event') await ports.onEvent(message.kind, message.data, signal)
    }
    void run().then(value => reply({ id: message.id, value }), () => reply({ id: message.id, failed: true }))
      .finally(() => requests.delete(message.id))
  })
  let stopping: Promise<void> | undefined
  return {
    closed,
    stop: () => stopping ??= (async () => {
      lifetime.abort()
      if (exited) return
      reply({ stop: true })
      const timer = setTimeout(() => child.kill(), 6_000)
      try { await closed } finally { clearTimeout(timer) }
    })(),
  }
}
