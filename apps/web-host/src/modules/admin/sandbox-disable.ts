import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { MxcDiagnostics } from '@gugu/sandbox/platform'
import { projectSandboxStatus } from './sandbox-status.js'

type RuntimeSettings = {
  shellEnabled: boolean
  shellDangerousEnabled: boolean
  sandboxEnabled: boolean
  sandboxReady: boolean
  sandboxReason?: string
  networkProfile: 'none' | 'egress'
  egressProxyUrl?: string
  egressProxyError?: string
}

export interface SandboxDisableRouteOptions {
  requireAdmin: preHandlerHookHandler
  updateDisabled(): Promise<void>
  publishTerminalRefresh(): Promise<void>
  readSettings(): Promise<RuntimeSettings>
  readiness(): Promise<MxcDiagnostics>
}

/** MXC 命令每秒复核 Shell 策略；先提交停用配置即可在 Host 所有实例撤销运行中授权。 */
export function registerSandboxDisableRoute(app: FastifyInstance, options: SandboxDisableRouteOptions): void {
  app.post('/api/v1/admin/sandbox/disable', { preHandler: options.requireAdmin }, async () => {
    await options.updateDisabled()
    await options.publishTerminalRefresh()
    const [settings, runtime] = await Promise.all([options.readSettings(), options.readiness()])
    return projectSandboxStatus(settings, runtime)
  })
}
