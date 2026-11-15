import { capabilitySnapshot, providerDiagnosticRequest } from '../providers/index.js'
import type { ProviderConfig, ProviderTransport } from '../providers/contracts.js'

export class LlmPresetTestError extends Error {
  override name = 'LlmPresetTestError'
  constructor(readonly status: 404 | 503, message: string) { super(message) }
}

export interface LlmPresetTestResult {
  ok: boolean
  status: number
  detail: string
  declared_capabilities: Record<string, unknown>
}

export interface LlmPresetTestPorts {
  readPreset(id: string): Promise<ProviderConfig | null>
  createTransport(config: ProviderConfig): ProviderTransport & { close?(): Promise<void> }
}

/** 以生产 Provider 协议探测单个已保存预设；只返回 HTTP 状态和静态能力，不读取上游响应正文。 */
export function createLlmPresetTest(ports: LlmPresetTestPorts) {
  return async (id: string): Promise<LlmPresetTestResult> => {
    let config: ProviderConfig | null
    try { config = await ports.readPreset(id) }
    catch { throw new LlmPresetTestError(503, '暂时无法读取模型配置') }
    if (!config) throw new LlmPresetTestError(404, '预设不存在')

    const declaredCapabilities = capabilitySnapshot(config)
    const failure = (status: number, detail: string): LlmPresetTestResult => ({
      ok: false, status, detail, declared_capabilities: declaredCapabilities,
    })
    const transport = ports.createTransport(config)
    try {
      const request = providerDiagnosticRequest(config)
      const response = await transport.request({ ...request, timeoutMs: 10_000 }, AbortSignal.timeout(10_000))
      const status = response.status
      await response.cancel()
      return {
        ok: status >= 200 && status < 400,
        status,
        detail: status >= 200 && status < 400 ? '' : `上游返回 HTTP ${status}`,
        declared_capabilities: declaredCapabilities,
      }
    } catch {
      return failure(0, '无法连接 Provider，请检查地址、模型和密钥')
    } finally {
      await transport.close?.().catch(() => undefined)
    }
  }
}
