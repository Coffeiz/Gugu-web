import { DesktopError } from './core-host.js'
import type { CoreHost } from './core-host.js'

type Host = Pick<CoreHost, 'request' | 'close'>
export class DesktopLifecycle {
  private current?: Host
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private phase: 'idle' | 'starting' | 'running' | 'stopping' | 'closed' = 'idle'
  private terminal = false
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
        this.current = host
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
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.phase !== 'running' || !this.current)
      return Promise.reject(
        new DesktopError('closed', '本地运行时正在暂停或退出，请稍后重读数据'),
      )
    return this.current.request<T>(method, params)
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
    return this.pause()
  }
}
