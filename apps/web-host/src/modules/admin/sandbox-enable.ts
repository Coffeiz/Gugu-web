import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { MxcDiagnostics } from '@gugu/sandbox/platform'
import { mutateConfigOverride, type ConfigOverrideLock } from '../../adapters/config-override-file.js'
import { createPosixConfigFileLock } from '../../adapters/posix-config-lock.js'
import { projectSandboxStatus } from './sandbox-status.js'

type RuntimeSettings = {
  sandboxEnabled: boolean
  sandboxReady: boolean
  sandboxReason?: string
  networkProfile: 'none' | 'egress'
  egressProxyUrl?: string
  egressProxyError?: string
  shellEnabled: boolean
  shellDangerousEnabled: boolean
}

export interface SandboxEnableRouteOptions {
  requireAdmin: preHandlerHookHandler
  updateEnabled(enabled: boolean): Promise<void>
  publishTerminalRefresh(): Promise<void>
  readSettings(): Promise<RuntimeSettings>
  readiness(): Promise<MxcDiagnostics>
}

/** 持锁原子更新 MXC Shell 开关；启用前要求隔离与代理能力已就绪。 */
export function createSandboxRuntimeUpdater(path: string, lock: ConfigOverrideLock = createPosixConfigFileLock()) {
  if (!path.trim()) throw new TypeError('配置文件路径无效')
  return async (enabled: boolean): Promise<void> => {
    await mutateConfigOverride(path, document => {
      const value = document.sandbox
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)))
        throw new Error('沙盒配置格式无效，已拒绝覆盖')
      document.sandbox = { ...(value as Record<string, unknown> | undefined), enabled }
      if (!enabled) {
        const agentValue = document.agent
        if (agentValue !== undefined && (agentValue === null || typeof agentValue !== 'object' || Array.isArray(agentValue)))
          throw new Error('Agent 配置格式无效，已拒绝覆盖')
        document.agent = { ...(agentValue as Record<string, unknown> | undefined), shell_enabled: false, shell_system_enabled: false, shell_dangerous_enabled: false }
      }
    }, lock)
  }
}

export function registerSandboxEnableRoute(app: FastifyInstance, options: SandboxEnableRouteOptions): void {
  app.post('/api/v1/admin/sandbox/enable', { preHandler: options.requireAdmin }, async (request, reply) => {
    const [settings, runtime] = await Promise.all([options.readSettings(), options.readiness()])
    if (!runtime.supported || !settings.sandboxReady) {
      return reply.code(409).send({ detail: settings.sandboxReason ?? runtime.reason ?? 'MXC 隔离执行环境尚未就绪' })
    }
    await options.updateEnabled(true)
    await options.publishTerminalRefresh()
    const updated = await options.readSettings()
    return projectSandboxStatus(updated, runtime)
  })
}
