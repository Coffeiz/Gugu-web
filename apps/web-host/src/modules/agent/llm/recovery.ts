import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { RunIdentity } from '@gugu/core/agent'
import type { ProviderConfig, ProviderRuntimeOptions } from '@gugu/core/providers'
import { resolveByokLlm } from './byok.js'
import type { AgentUsageConfig } from '../run/usage.js'
import { LlmCredentialUnavailable, type ByokCredential } from '../../byok/store.js'
import { ModelPresetUnavailable } from './selection.js'

/** 由同一可信配置快照返回所选模型、凭据及对应的不透明版本；版本变更必须与写入原子提交。 */
export interface RecoverableModelSnapshot {
  modelRef: string
  configVersion: string
  credentialVersion: string
  credentialId?: number | null
  contextScopeKey: string
  accessScopeHash: string
  byokEnabled: boolean
  localDeployment: boolean
  defaultLimit6h: number | null
  config: ProviderConfig
  credential: ByokCredential | null
  systemPrompt: string
  release(): void
}
export interface RecoverableProviderServices {
  /** ref 缺省执行策略选择；提供 ref 时必须精确重取该模型，不能重新选池。 */
  select(identity: RunIdentity, signal: AbortSignal, ref?: string, credentialId?: number | null): Promise<RecoverableModelSnapshot>
  verifyCredential?(identity: RunIdentity, id: number, version: string, signal: AbortSignal): Promise<void>
  decryptCredential(row: ByokCredential): string
  defaultBaseUrl(provider: string, format: string): string
}
type Binding = { v: 1; nonce: string; ownerId: string; sessionId: string; runId: string; modelRef: string; configVersion: string; credentialVersion: string; credentialId?: number | null; contextScopeKey: string; accessScopeHash: string }
export class RecoverableProviderVersionError extends Error {}
function sign(payload: string, secret: string): Buffer { return createHmac('sha256', secret).update(payload).digest() }
function decode(value: string, secret: string): Binding {
  if (typeof value !== 'string' || value.length > 8192) throw new RecoverableProviderVersionError('模型恢复身份无效')
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'gugu-model-v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) throw new RecoverableProviderVersionError('模型恢复身份无效')
  const expected = sign(parts[1]!, secret), actual = Buffer.from(parts[2]!, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new RecoverableProviderVersionError('模型恢复身份无效')
  let binding: Binding
  try { binding = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Binding } catch { throw new RecoverableProviderVersionError('模型恢复身份无效') }
  if (!binding || binding.v !== 1 || !['nonce', 'ownerId', 'sessionId', 'runId', 'modelRef', 'configVersion', 'credentialVersion', 'contextScopeKey', 'accessScopeHash'].every(key => typeof (binding as unknown as Record<string, unknown>)[key] === 'string' && !!(binding as unknown as Record<string, string>)[key])) throw new RecoverableProviderVersionError('模型恢复身份无效')
  if (binding.credentialId !== undefined && binding.credentialId !== null
    && (!Number.isSafeInteger(binding.credentialId) || binding.credentialId < 1))
    throw new RecoverableProviderVersionError('模型恢复凭据无效')
  return binding
}

type ModelIdentity = { modelIdentity: string; accessScopeHash: string }
function readRunModel(identity: RunIdentity, model: ModelIdentity, secret: string): Binding {
  const binding = decode(model.modelIdentity, secret)
  if (binding.ownerId !== identity.ownerId || binding.sessionId !== identity.sessionId
    || binding.runId !== identity.runId || binding.accessScopeHash !== model.accessScopeHash)
    throw new RecoverableProviderVersionError('模型恢复身份不匹配')
  return binding
}

/** 验证每个 Run 的签名，再用不含 Run ID 的摘要标识可使用同一模型的回合。 */
export function createReflectionModelScope(secret: string) {
  if (!secret) throw new TypeError('反思模型范围签名不可用')
  return (identity: RunIdentity, model: ModelIdentity): string => {
    const binding = readRunModel(identity, model, secret)
    return sign(JSON.stringify(['owner-reflection-model-v1', binding.ownerId, binding.sessionId, binding.modelRef,
      binding.configVersion, binding.credentialVersion, binding.contextScopeKey, binding.accessScopeHash]), secret).toString('hex')
  }
}

/** recovery 必须来自已解密且验证 owner/run 的 checkpoint，不接受 HTTP 请求数据。 */
export async function bindRecoverableProvider(identity: RunIdentity, services: RecoverableProviderServices, secret: string, signal: AbortSignal, recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string }, requestedCredentialId?: number): Promise<{ modelIdentity: string; contextScopeKey: string; accessScopeHash: string; contextWindow: number; usageConfig: AgentUsageConfig; resolve: ProviderRuntimeOptions['resolve']; release(): void }> {
  identity = { ...identity }
  if (!secret || !identity.ownerId || !identity.sessionId || !identity.runId) throw new Error('模型身份无效')
  signal.throwIfAborted()
  let previous: Binding | undefined
  if (recovery) {
    if (recovery.identity.ownerId !== identity.ownerId || recovery.identity.sessionId !== identity.sessionId || recovery.identity.runId !== identity.runId) throw new RecoverableProviderVersionError('模型恢复身份不匹配')
    previous = readRunModel(identity, recovery, secret)
  }
  let snapshot: RecoverableModelSnapshot
  try { snapshot = await services.select(identity, signal, previous?.modelRef, previous ? previous.credentialId : requestedCredentialId) }
  catch (error) {
    if (previous && error instanceof LlmCredentialUnavailable)
      throw new RecoverableProviderVersionError('原 LLM 凭据已失效，无法恢复')
    if (previous && error instanceof ModelPresetUnavailable)
      throw new RecoverableProviderVersionError('原模型预设已不可用，无法恢复')
    throw error
  }
  try {
    signal.throwIfAborted()
    if (!(snapshot.modelRef === 'active' || /^preset:[A-Za-z0-9_-]{1,128}$/.test(snapshot.modelRef)) || !/^[A-Za-z0-9:_-]{1,256}$/.test(snapshot.configVersion) || !/^[A-Za-z0-9:_-]{1,256}$/.test(snapshot.credentialVersion) || !/^[a-f0-9]{64}$/.test(snapshot.contextScopeKey) || !/^[a-f0-9]{64}$/.test(snapshot.accessScopeHash)) throw new Error('模型配置版本无效')
    if (previous && previous.credentialVersion !== snapshot.credentialVersion)
      throw new RecoverableProviderVersionError('原 LLM 凭据版本已变化，无法恢复')
    if (previous && (snapshot.modelRef !== previous.modelRef || snapshot.configVersion !== previous.configVersion || snapshot.contextScopeKey !== previous.contextScopeKey || snapshot.accessScopeHash !== previous.accessScopeHash)) throw new RecoverableProviderVersionError('模型配置或访问范围已变化，无法恢复')
    let config: ProviderConfig
    try {
      config = structuredClone(resolveByokLlm(snapshot.config, snapshot.credential, services.decryptCredential, services.defaultBaseUrl, snapshot.credentialId !== undefined))
    } catch (error) {
      if (snapshot.credential) throw new LlmCredentialUnavailable()
      throw error
    }
    const contextWindow = Number(config.context_tokens)
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) throw new Error('模型上下文长度无效')
    if (typeof config.model !== 'string' || !config.model.trim() || typeof config.provider !== 'string' || !config.provider.trim()) throw new Error('模型供应商配置无效')
    const binding: Binding = previous ?? { v: 1, nonce: randomUUID(), ...identity, modelRef: snapshot.modelRef, configVersion: snapshot.configVersion, credentialVersion: snapshot.credentialVersion, credentialId: snapshot.credentialId, contextScopeKey: snapshot.contextScopeKey, accessScopeHash: snapshot.accessScopeHash }
    const payload = Buffer.from(JSON.stringify(binding)).toString('base64url')
    const modelIdentity = recovery?.modelIdentity ?? `gugu-model-v1.${payload}.${sign(payload, secret).toString('base64url')}`
    let released = false
    const usageConfig: AgentUsageConfig = { defaultLimit6h: snapshot.defaultLimit6h, byokEnabled: snapshot.byokEnabled,
      localDeployment: snapshot.localDeployment, model: config.model, provider: config.provider, isByok: snapshot.credential !== null }
    if (usageConfig.defaultLimit6h !== null && (!Number.isSafeInteger(usageConfig.defaultLimit6h) || usageConfig.defaultLimit6h < 0)) throw new Error('Agent 用量配置无效')
    return { modelIdentity, contextScopeKey: binding.contextScopeKey, accessScopeHash: binding.accessScopeHash, contextWindow, usageConfig, release: () => { if (!released) { released = true; snapshot.release() } },
      resolve: async (requested, model, requestSignal) => {
        requestSignal.throwIfAborted()
        if (requested.ownerId !== identity.ownerId || requested.sessionId !== identity.sessionId || requested.runId !== identity.runId || model !== modelIdentity) throw new Error('模型访问身份不匹配')
        if (released) throw new RecoverableProviderVersionError('模型绑定已释放')
        if (typeof binding.credentialId === 'number')
          await services.verifyCredential?.(identity, binding.credentialId, binding.credentialVersion, requestSignal)
        if (released) throw new RecoverableProviderVersionError('模型绑定已释放')
        return { modelIdentity, accessScopeHash: binding.accessScopeHash, config: structuredClone(config), systemPrompt: snapshot.systemPrompt }
      } }
  } catch (error) { snapshot.release(); throw error }
}
