import { type ByokCredential } from '../../byok/store.js'
import { randomUUID } from 'node:crypto'
import type { RunIdentity } from '@gugu/core/agent'
import type { ProviderConfig, ProviderRuntimeOptions } from '@gugu/core/providers'
import { resolveByokLlm } from './byok.js'

/** 宿主负责选择策略、读取提示词和用户凭据；所有配置只能来自可信服务。 */
export interface ProviderSelectionServices {
  selectPlatformModel(ownerId: string, signal: AbortSignal): Promise<{ config: ProviderConfig; systemPrompt: string; byokEnabled: boolean; localDeployment: boolean; accessScopeHash: string; release?: () => void }>
  readActiveCredential(ownerId: string): Promise<ByokCredential | null>
  decryptCredential(row: ByokCredential): string
  defaultBaseUrl(provider: string, format: string): string
}

/** 每次运行固定模型快照，避免流式生成中配置变更导致模型身份漂移。 */
export async function bindProviderSelection(identity: RunIdentity, services: ProviderSelectionServices, signal: AbortSignal): Promise<{ modelIdentity: string; resolve: ProviderRuntimeOptions['resolve']; release: () => void }> {
  const bound = { ...identity }
  signal.throwIfAborted()
  const selected = await services.selectPlatformModel(bound.ownerId, signal)
  try {
    signal.throwIfAborted()
    if (!selected.accessScopeHash) throw new Error('模型访问范围无效')
    const row = selected.byokEnabled || selected.localDeployment ? await services.readActiveCredential(bound.ownerId) : null
    signal.throwIfAborted()
    const config = resolveByokLlm(selected.config, row, services.decryptCredential, services.defaultBaseUrl)
    const modelIdentity = randomUUID(), accessScopeHash = selected.accessScopeHash
    let released = false
    return { modelIdentity, release: () => { if (!released) { released = true; selected.release?.() } }, resolve: async (request, requestedModel, requestSignal) => {
      requestSignal.throwIfAborted()
      if (request.ownerId !== bound.ownerId || request.sessionId !== bound.sessionId || request.runId !== bound.runId || requestedModel !== modelIdentity) throw new Error('模型访问身份不匹配')
      return { modelIdentity, accessScopeHash, config: structuredClone(config), systemPrompt: selected.systemPrompt }
    } }
  } catch (error) {
    selected.release?.()
    throw error
  }
}
