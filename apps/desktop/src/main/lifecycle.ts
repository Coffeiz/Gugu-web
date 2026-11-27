import { setTimeout as delay } from 'node:timers/promises'
import { DesktopError } from './core-host.js'
import type { CoreHost } from './core-host.js'

type Host = Pick<CoreHost, 'request' | 'close'> & Partial<Pick<CoreHost, 'onAgentRunChanged' | 'setHostRequestHandler'>>
export class DesktopLifecycle {
  private hostRequestHandler?: Parameters<NonNullable<Host['setHostRequestHandler']>>[0]
  private current?: Host
  private readonly runListeners = new Set<(sessionId: number, runId: string | undefined, interactionChanged?: true) => void>()
  private detachRunListener?: () => void
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private phase: 'idle' | 'starting' | 'running' | 'stopping' | 'closed' = 'idle'
  private terminal = false
  private requestVersion = 0
  constructor(private factory: () => Promise<Host>) {}
  async start(): Promise<void> {
    if (this.terminal) throw new DesktopError('closed', '桌面运行时已退出')
    if (this.stopping) await this.stopping
    if (this.terminal) throw new DesktopError('closed', '桌面运行时已退出')
    if (this.current) return
    if (this.starting) return this.starting
    this.phase = 'starting'
    this.starting = this.factory()
      .then((host) => {
        if (this.hostRequestHandler) host.setHostRequestHandler?.(this.hostRequestHandler)
        this.current = host
        this.detachRunListener = host.onAgentRunChanged?.((sessionId, runId, interactionChanged) => {
          for (const listener of this.runListeners) listener(sessionId, runId, interactionChanged)
        })
        if (this.phase !== 'stopping') this.phase = 'running'
      })
      .catch((error) => {
        if (this.phase !== 'stopping') this.phase = 'idle'
        if (error instanceof DesktopError) throw error
        throw new DesktopError(
          'startup_failed',
          '本地运行时启动失败，请检查制品和数据库状态',
        )
      })
      .finally(() => {
        this.starting = undefined
      })
    return this.starting
  }
  onAgentRunChanged(listener: (sessionId: number, runId: string | undefined, interactionChanged?: true) => void): () => void {
    this.runListeners.add(listener)
    return () => { this.runListeners.delete(listener) }
  }
  setHostRequestHandler(handler: Parameters<NonNullable<Host['setHostRequestHandler']>>[0]): void {
    if (this.phase !== 'running' || !this.current?.setHostRequestHandler)
      throw new DesktopError('closed', 'Core 宿主能力只能在运行时启动后配置')
    this.current.setHostRequestHandler(handler)
    this.hostRequestHandler = handler
  }
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, operationId?: string): Promise<T> {
    if (this.phase !== 'running' || !this.current) {
      return Promise.reject(
        new DesktopError('closed', '本地运行时正在暂停或退出，请稍后重读数据'),
      )
    }
    this.requestVersion++
    return this.current.request<T>(method, params, operationId)
  }
  async whenIdle(action: () => Promise<void> | void, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      const host = this.current
      if (this.terminal || !host || this.phase !== 'running')
        throw new DesktopError('closed', '本地运行时不可用，无法重载')
      const version = this.requestVersion
      const idle = await host.request<boolean>('core.devReloadIdle').catch(error => {
        if (error instanceof DesktopError && error.code === 'busy') return false
        throw error
      })
      signal?.throwIfAborted()
      if (this.terminal || this.current !== host || this.phase !== 'running')
        throw new DesktopError('closed', '本地运行时已切换，无法重载')
      // 检查期间已有新请求入队时，等它完成再重新确认。
      if (idle === true && version === this.requestVersion) {
        await action()
        return
      }
      await delay(500, undefined, { signal, ref: false })
    }
  }
  pause(): Promise<void> {
    if (this.stopping) return this.stopping
    this.phase = 'stopping'
    this.stopping = (async () => {
      try {
        await this.starting
      } catch {
        /* 启动失败时仍需收敛状态。 */
      }
      try {
        await this.current?.close()
      } finally {
        this.detachRunListener?.()
        this.detachRunListener = undefined
        this.current = undefined
        this.phase = this.terminal ? 'closed' : 'idle'
      }
    })().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }
  close(): Promise<void> {
    this.terminal = true
    this.runListeners.clear()
    return this.pause()
  }
}
