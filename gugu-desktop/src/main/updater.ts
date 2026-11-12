import { DesktopError } from './core-host.js'

export interface UpdateBackend {
  check(): Promise<string | null>
  download(): Promise<void>
  install(): void
}
export class DesktopUpdater {
  private state:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'failed'
  private version?: string
  private pending?: Promise<void>
  constructor(
    private backend: UpdateBackend | null,
    private stop: () => Promise<void>,
  ) {
    this.state = backend ? 'idle' : 'disabled'
  }
  status() {
    return {
      state: this.state,
      ...(this.version ? { version: this.version } : {}),
    }
  }
  check(): Promise<void> {
    if (this.pending) return this.pending
    if (!this.backend || !['idle', 'available', 'failed'].includes(this.state))
      return Promise.reject(
        new DesktopError('update_unavailable', '当前版本未提供可用的更新通道'),
      )
    this.state = 'checking'
    this.pending = this.backend
      .check()
      .then((version) => {
        if (version && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error()
        this.version = version ?? undefined
        this.state = version ? 'available' : 'idle'
      })
      .catch(() => {
        this.state = 'failed'
        throw new DesktopError('update_failed', '更新检查失败，请稍后重试')
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  download(): Promise<void> {
    if (this.pending)
      return Promise.reject(new DesktopError('update_busy', '更新流程正在进行'))
    if (!this.backend || this.state !== 'available')
      return Promise.reject(
        new DesktopError('update_unavailable', '没有已确认的可下载更新'),
      )
    this.state = 'downloading'
    this.pending = this.backend
      .download()
      .then(() => {
        this.state = 'downloaded'
      })
      .catch(() => {
        this.state = 'failed'
        throw new DesktopError('update_failed', '更新下载或校验失败，未安装更新')
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  async install(confirmed: boolean): Promise<void> {
    if (!confirmed || !this.backend || this.state !== 'downloaded')
      throw new DesktopError('update_unavailable', '更新安装需要用户确认及已校验的下载制品')
    this.state = 'installing'
    try {
      await this.stop()
      this.backend.install()
    } catch {
      this.state = 'failed'
      throw new DesktopError(
        'update_failed',
        '更新安装失败，请重新启动当前版本并检查数据状态',
      )
    }
  }
}
