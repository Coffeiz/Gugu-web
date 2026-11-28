import type { ContainerRequest } from '@microsoft/mxc-sdk/v1'
import type { Readable, Writable } from 'node:stream'
import type { PtyHandle } from '../contracts.js'

export interface MxcPtyProcessLike {
  readonly id: number
  readonly input: Writable
  readonly output: Readable
  resize(size: { rows: number; columns: number }): void
  kill(): void
  wait(): Promise<{ exitCode: number; timedOut: boolean }>
  dispose(): void
}

export interface MxcPtyLaunchSpec {
  readonly terminalId: string
  readonly root: string
  readonly readwritePaths: readonly string[]
  readonly readonlyPaths: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly networkProfile: 'none' | 'egress'
  readonly egressProxyUrl?: string
  readonly cols: number
  readonly rows: number
  readonly release?: () => Promise<void>
}

export type MxcPtyHandle = PtyHandle

export interface MxcPtyBridge {
  open(spec: MxcPtyLaunchSpec): Promise<MxcPtyHandle>
}

export interface MxcPtyBridgeOptions {
  readonly command: string
  readonly containment?: 'bubblewrap' | 'seatbelt' | 'process'
  readonly spawn?: (request: ContainerRequest, options: { size: { columns: number; rows: number } }) => Promise<MxcPtyProcessLike>
}

function validateProxy(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('MXC 回环代理地址无效') }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())
    || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('MXC 只接受本机回环 HTTP/S 代理')
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`
}

function onceWritable(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { stream.off('drain', onDrain); reject(error) }
    const onDrain = () => { stream.off('error', onError); resolve() }
    stream.once('error', onError)
    if (stream.write(data)) { stream.off('error', onError); resolve() }
    else stream.once('drain', onDrain)
  })
}

/** 构造隔离策略固定的 MXC PTY transport；不会回退到宿主机普通子进程。 */
export function createMxcPtyBridge(options: MxcPtyBridgeOptions): MxcPtyBridge {
  const spawn = options.spawn ?? (async (request, spawnOptions) => {
    const sdk = await import('@microsoft/mxc-sdk/v1')
    return sdk.spawnWithPty(request, { ...spawnOptions, telemetry: { enabled: false } })
  })
  return {
    async open(spec) {
      if (!spec.terminalId || !spec.root || !options.command.trim()) throw new Error('PTY 启动参数无效')
      if (spec.networkProfile !== 'none' && spec.networkProfile !== 'egress') throw new Error('PTY 网络配置无效')
      if (spec.readwritePaths.length + spec.readonlyPaths.length === 0) throw new Error('PTY 文件系统范围为空')
      if (!spec.readwritePaths.includes(spec.root) && !spec.readonlyPaths.includes(spec.root)) throw new Error('PTY 根目录不在授权范围内')
      if (!Number.isInteger(spec.cols) || spec.cols < 20 || spec.cols > 500 || !Number.isInteger(spec.rows) || spec.rows < 5 || spec.rows > 200)
        throw new Error('PTY 终端尺寸无效')

      const proxy = spec.networkProfile === 'egress' ? spec.egressProxyUrl : undefined
      if (spec.networkProfile === 'egress' && !proxy) throw new Error('MXC 安全出站代理不可用')
      const networkProxy = proxy ? validateProxy(proxy) : undefined
      const request: ContainerRequest = {
        command: options.command,
        containment: { type: options.containment ?? 'bubblewrap' },
        workingDirectory: spec.root,
        filesystem: {
          readwritePaths: [...new Set(spec.readwritePaths)],
          readonlyPaths: [...new Set(spec.readonlyPaths)],
        },
        network: {
          egress: { default: 'deny' },
          ingress: { default: 'deny', hostLoopback: 'deny' },
          ...(networkProxy ? { runtimeConfig: { networkProxy } } : {}),
        },
        ui: { disable: true, clipboard: 'none', allowInputInjection: false },
        environment: { ...spec.environment },
        inheritDefaultEnvironment: false,
      }
      const process = await spawn(request, { size: { columns: spec.cols, rows: spec.rows } })
      let closing: Promise<void> | undefined
      return {
        pid: process.id,
        sandboxId: `${spec.terminalId}:${process.id}`,
        async write(data) {
          if (closing) throw new Error('PTY 已关闭')
          await onceWritable(process.input, data)
        },
        async resize(cols, rows) {
          if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200)
            throw new Error('PTY 终端尺寸无效')
          if (closing) throw new Error('PTY 已关闭')
          process.resize({ columns: cols, rows })
        },
        async signal(name) {
          if (closing) throw new Error('PTY 已关闭')
          if (name === 'SIGTERM') {
            process.kill()
            return
          }
          await onceWritable(process.input, Buffer.from(name === 'SIGINT' ? '\u0003' : '\u001a'))
        },
        async close() {
          if (closing) return closing
          closing = (async () => {
            try {
              process.kill()
              await process.wait()
            } finally {
              try { process.dispose() } finally { await spec.release?.() }
            }
          })()
          return closing
        },
        async *output() {
          for await (const chunk of process.output) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        },
      }
    },
  }
}
