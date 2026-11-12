import type { SandboxStatus } from '@gugu/core/desktop'
import type { CoreHost } from '../main/core-host.js'

// 只调用可信 Core 的固定探测，不运行任意命令、不修改 ACL 或隔离策略。
export async function sandboxDiagnostics(
  host: Pick<CoreHost, 'request'>,
): Promise<SandboxStatus> {
  const result = await host.request<SandboxStatus>('executor.diagnostics')
  if (
    typeof result?.supported !== 'boolean' ||
    !Array.isArray(result.methods) ||
    !result.methods.every((item) => typeof item === 'string') ||
    typeof result.checkAvailable !== 'boolean'
  )
    throw new Error('隔离诊断响应无效')
  return result
}
