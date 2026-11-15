import { execFile as execFileCallback, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

const execFile = promisify(execFileCallback)
const RESTARTABLE = Object.freeze({ worker: 'worker', gateway: 'agent.gateway.gateway' })
const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../backend')

interface ServiceHeartbeat {
  readonly pid?: unknown
  readonly host?: unknown
}

export interface ServiceRestartRuntime {
  readHeartbeat(name: string): Promise<ServiceHeartbeat | null>
  hostName(): string
  processCommandLine(pid: number): string
  processExecutable(pid: number): string
  signal(pid: number, signal: NodeJS.Signals): void
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>
  isSystemdManaged(name: string): Promise<boolean>
  respawn(name: string, executable: string): Promise<number>
}

export class UnsupportedServiceError extends Error {
  readonly code = 'unsupported_service'

  constructor(name: string) {
    super(`不支持重启 ${name}`)
    this.name = 'UnsupportedServiceError'
  }
}

export interface ServiceRestartOperations {
  readonly restart: ReturnType<typeof createServiceRestarter>
}

export function createServiceRestarter(runtime: ServiceRestartRuntime) {
  return async (name: string): Promise<{ ok: boolean; msg: string }> => {
    if (!Object.hasOwn(RESTARTABLE, name)) throw new UnsupportedServiceError(name)
    const moduleName = RESTARTABLE[name as keyof typeof RESTARTABLE]
    let heartbeat: ServiceHeartbeat | null = null
    try { heartbeat = await runtime.readHeartbeat(name) } catch { /* Redis 故障按无心跳处理，与 Python 行为一致。 */ }
    if (!heartbeat)
      return { ok: false, msg: `${name} 当前无心跳（可能已挂）。若配置 systemd Restart=always，它会自动拉起；否则需手动启动。` }
    if (heartbeat.host !== runtime.hostName())
      return { ok: false, msg: `${name} 在另一台主机（${String(heartbeat.host ?? '未知主机')}）上，本机无法重启。` }

    const pid = heartbeat.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2)
      return { ok: false, msg: `${name} 心跳中的进程号无效，已跳过，避免误杀。` }
    if (!runtime.processCommandLine(pid).includes(moduleName))
      return { ok: false, msg: `pid ${pid} 命令行不匹配（可能已重启或 pid 复用），已跳过，避免误杀。` }

    let executable = ''
    try { executable = runtime.processExecutable(pid) } catch { /* systemd 模式无需自行拉起。 */ }
    try {
      runtime.signal(pid, 'SIGTERM')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ESRCH') return { ok: false, msg: `进程 ${pid} 不存在（可能刚退出）。` }
      if (code === 'EPERM') return { ok: false, msg: `无权限停止 pid ${pid}（Web 与 ${name} 需同用户运行）。` }
      return { ok: false, msg: `停止 ${name} 失败，已跳过后续重启。` }
    }

    let systemdManaged = false
    try { systemdManaged = await runtime.isSystemdManaged(name) } catch { /* systemctl 不可用时沿用手动拉起路径。 */ }
    if (systemdManaged)
      return { ok: true, msg: `已重启 ${name}(pid ${pid})，systemd 将在几秒内自动拉起。` }

    if (!await runtime.waitForExit(pid, 8_000)) {
      try { runtime.signal(pid, 'SIGKILL') } catch { /* 进程可能在等待期间退出。 */ }
      await runtime.waitForExit(pid, 3_000)
    }
    try {
      const newPid = await runtime.respawn(name, executable)
      return { ok: true, msg: `已重启 ${name}：旧 pid ${pid} → 新 pid ${newPid}（后端自管理，非 systemd）。` }
    } catch {
      return { ok: false, msg: `已停止旧 ${name}，但自动拉起失败；请检查服务日志并手动恢复。` }
    }
  }
}

export function registerServiceRestartRoute(
  app: FastifyInstance,
  options: {
    requireAdmin: preHandlerHookHandler
    restart: ReturnType<typeof createServiceRestarter>
  },
): void {
  app.post<{ Params: { name: string } }>(
    '/api/v1/admin/services/:name/restart',
    { preHandler: options.requireAdmin },
    async (request, reply) => {
      try { return await options.restart(request.params.name) }
      catch (error) {
        if (error instanceof UnsupportedServiceError)
          return reply.code(400).send({ detail: error.message })
        throw error
      }
    },
  )
}

/** Node Host 的本机进程与 systemd 适配，不读取或写入业务配置。 */
export function createNodeServiceRestartRuntime(
  readValue: (key: string) => Promise<string | null>,
  options: { hostName?: () => string; backendRoot?: string } = {},
): ServiceRestartRuntime {
  const root = resolve(options.backendRoot ?? BACKEND_ROOT)
  const host = options.hostName ?? hostname
  return {
    async readHeartbeat(name) {
      try {
        const raw = await readValue(`health:${name}`)
        if (!raw) return null
        const value: unknown = JSON.parse(raw)
        return value && typeof value === 'object' && !Array.isArray(value) ? value as ServiceHeartbeat : null
      } catch { return null }
    },
    hostName: host,
    processCommandLine(pid) {
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() }
      catch { return '' }
    },
    processExecutable(pid) {
      return readlinkSync(`/proc/${pid}/exe`)
    },
    signal(pid, signal) {
      process.kill(pid, signal)
    },
    async waitForExit(pid, timeoutMs) {
      const attempts = Math.ceil(timeoutMs / 500)
      for (let attempt = 0; attempt < attempts; attempt++) {
        try { process.kill(pid, 0) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
      }
      try { process.kill(pid, 0); return false }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
    },
    async isSystemdManaged(name) {
      try {
        await execFile('systemctl', ['is-enabled', `gugu-${name}`], { timeout: 3_000, windowsHide: true })
        return true
      } catch { return false }
    },
    async respawn(name, executable) {
      if (!executable.startsWith('/')) throw new Error('服务解释器不可用')
      const moduleName = RESTARTABLE[name as keyof typeof RESTARTABLE]
      if (!moduleName) throw new UnsupportedServiceError(name)
      const logDirectory = resolve(root, 'logs')
      mkdirSync(logDirectory, { recursive: true })
      const logPath = resolve(logDirectory, `gugu-${name}.log`)
      if (dirname(logPath) !== logDirectory || basename(logPath) !== `gugu-${name}.log`)
        throw new Error('服务日志路径无效')
      const logFd = openSync(logPath, 'a', 0o600)
      try {
        const child = spawn(executable, ['-m', moduleName], {
          cwd: root,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: process.env,
          windowsHide: true,
        })
        const pid = await new Promise<number>((resolveSpawn, rejectSpawn) => {
          child.once('spawn', () => child.pid ? resolveSpawn(child.pid) : rejectSpawn(new Error('服务进程未返回 PID')))
          child.once('error', rejectSpawn)
        })
        child.unref()
        return pid
      } finally {
        closeSync(logFd)
      }
    },
  }
}
