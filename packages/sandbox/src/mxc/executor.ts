import { ExecutionError } from '../contracts.js'
import type { ExecutionBackend, ExecutionPolicy, ExecutionResult } from '../contracts.js'
import type { Readable } from 'node:stream'

export interface NativeProcess {
  standardOutput: Readable | null
  standardError: Readable | null
  kill(): void
  wait(): Promise<{ exitCode: number; timedOut: boolean }>
  dispose(): void
}
export type NativeSpawn = (request: {
  containment: { type: 'process' | 'bubblewrap' }
  command: string
  workingDirectory: string
  timeoutMs: number
  filesystem: { readonlyPaths: string[]; readwritePaths: string[] }
  network: {
    egress: { default: 'deny' }
    ingress: { default: 'deny'; hostLoopback: 'deny' }
    runtimeConfig?: { networkProxy: string }
  }
  ui: { disable: true; clipboard: 'none'; injection: false }
  environment: Record<string, string>
  inheritDefaultEnvironment: false
}) => Promise<NativeProcess>

export class MxcExecutor implements ExecutionBackend {
  readonly id = 'mxc'
  readonly capabilities = Object.freeze({
    filesystem: true,
    networkDeny: true,
    uiDeny: true,
    timeout: true,
    cancellation: true,
  })
  private networkProxy?: string
  constructor(private spawn: NativeSpawn, private containment: 'process' | 'bubblewrap' = 'process', networkProxy?: string) {
    if (networkProxy !== undefined) {
      let proxy: URL
      try { proxy = new URL(networkProxy) } catch { throw new ExecutionError('denied', 'MXC 回环代理地址无效') }
      const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80')
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash
        || proxy.pathname !== '/' || !['localhost', '127.0.0.1'].includes(proxy.hostname.toLowerCase())
        || Number(port) < 1 || Number(port) > 65535)
        throw new ExecutionError('denied', 'MXC 只接受本机回环 HTTP/S 代理')
      this.networkProxy = `${proxy.protocol}//${proxy.hostname.toLowerCase()}:${port}`
    }
  }
  async execute(policy: ExecutionPolicy, signal?: AbortSignal, onOutput?: (stream: 'stdout' | 'stderr', chunk: Uint8Array) => void): Promise<ExecutionResult> {
    if (signal?.aborted) throw new ExecutionError('cancelled', '执行已取消')
    let child: NativeProcess | undefined
    const output: Buffer[] = [],
      errors: Buffer[] = []
    let size = 0,
      exceeded = false,
      streamFailed = false
    const cancel = () => {
      try {
        child?.kill()
      } catch {
        /* 后续 wait/dispose 完成回收，原始异常不透出。 */
      }
    }
    const collect = (target: Buffer[], stream: 'stdout' | 'stderr') => (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      size += chunk.length
      if (size > policy.maxOutputBytes) {
        exceeded = true
        cancel()
      } else {
        target.push(chunk)
        try { onOutput?.(stream, chunk) } catch { /* 通知失败不能中断命令执行。 */ }
      }
    }
    const stdout = collect(output, 'stdout'),
      stderr = collect(errors, 'stderr')
    const streamError = () => {
      streamFailed = true
      cancel()
    }
    try {
      child = await this.spawn({
        containment: { type: this.containment },
        command: policy.command,
        workingDirectory: policy.cwd,
        timeoutMs: policy.timeoutMs,
        filesystem: {
          readonlyPaths: [...policy.readonlyPaths],
          readwritePaths: [...policy.readwritePaths],
        },
        network: {
          egress: { default: 'deny' },
          ingress: { default: 'deny', hostLoopback: 'deny' },
          ...(this.networkProxy ? { runtimeConfig: { networkProxy: this.networkProxy } } : {}),
        },
        ui: { disable: true, clipboard: 'none', injection: false },
        environment: { ...policy.environment },
        inheritDefaultEnvironment: false,
      })
      child.standardOutput?.on('data', stdout)
      child.standardError?.on('data', stderr)
      child.standardOutput?.on('error', streamError)
      child.standardError?.on('error', streamError)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      const result = await child.wait()
      if (signal?.aborted) throw new ExecutionError('cancelled', '执行已取消')
      if (streamFailed) throw new ExecutionError('native_failure', '原生执行输出通道失败')
      if (exceeded) throw new ExecutionError('output_limit', '执行输出超出授权限制')
      return {
        stdout: Buffer.concat(output).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      }
    } catch (error) {
      cancel()
      if (error instanceof ExecutionError) throw error
      throw new ExecutionError('native_failure', '原生执行失败，未放宽隔离策略')
    } finally {
      signal?.removeEventListener('abort', cancel)
      child?.standardOutput?.off('data', stdout)
      child?.standardError?.off('data', stderr)
      child?.standardOutput?.off('error', streamError)
      child?.standardError?.off('error', streamError)
      try {
        child?.dispose()
      } catch {
        throw new ExecutionError('native_failure', '原生资源回收失败')
      }
    }
  }
}
