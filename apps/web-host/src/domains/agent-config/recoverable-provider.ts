import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { RunIdentity } from '@gugu/core/agent'
import type { ProviderConfig, ProviderRuntimeOptions } from '@gugu/core/providers'
import { resolveByokLlm, type ByokCredential } from './byok.js'

/** 由同一可信配置快照返回所选模型、凭据及对应的不透明版本；版本变更必须与写入原子提交。 */
export interface RecoverableModelSnapshot {
  modelRef: string
  configVersion: string
  credentialVersion: string
  accessScopeHash: string
  config: ProviderConfig
  credential: ByokCredential | null
  systemPrompt: string
  release(): void
}
export interface RecoverableProviderServices {
  /** ref 缺省执行策略选择；提供 ref 时必须精确重取该模型，不能重新选池。 */
  select(identity: RunIdentity, signal: AbortSignal, ref?: string): Promise<RecoverableModelSnapshot>
  decryptCredential(row: ByokCredential): string
  defaultBaseUrl(provider: string, format: string): string
}
type Binding = { v: 1; nonce: string; ownerId: string; sessionId: string; runId: string; modelRef: string; configVersion: string; credentialVersion: string; accessScopeHash: string }
function sign(payload: string, secret: string): Buffer { return createHmac('sha256', secret).update(payload).digest() }
function decode(value: string, secret: string): Binding {
  if (value.length > 8192) throw new Error('模型恢复身份无效')
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'gugu-model-v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) throw new Error('模型恢复身份无效')
  const expected = sign(parts[1]!, secret), actual = Buffer.from(parts[2]!, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('模型恢复身份无效')
  let binding: Binding
  try { binding = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Binding } catch { throw new Error('模型恢复身份无效') }
  if (!binding || binding.v !== 1 || !['nonce', 'ownerId', 'sessionId', 'runId', 'modelRef', 'configVersion', 'credentialVersion', 'accessScopeHash'].every(key => typeof (binding as unknown as Record<string, unknown>)[key] === 'string' && !!(binding as unknown as Record<string, string>)[key])) throw new Error('模型恢复身份无效')
  return binding
}

/** recovery 必须来自已解密且验证 owner/run 的 checkpoint，不接受 HTTP 请求数据。 */
export async function bindRecoverableProvider(identity: RunIdentity, services: RecoverableProviderServices, secret: string, signal: AbortSignal, recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string }): Promise<{ modelIdentity: string; accessScopeHash: string; resolve: ProviderRuntimeOptions['resolve']; release(): void }> {
  identity = { ...identity }
  if (!secret || !identity.ownerId || !identity.sessionId || !identity.runId) throw new Error('模型身份无效')
  signal.throwIfAborted()
  let previous: Binding | undefined
  if (recovery) {
    if (recovery.identity.ownerId !== identity.ownerId || recovery.identity.sessionId !== identity.sessionId || recovery.identity.runId !== identity.runId) throw new Error('模型恢复身份不匹配')
    previous = decode(recovery.modelIdentity, secret)
    if (previous.ownerId !== identity.ownerId || previous.sessionId !== identity.sessionId || previous.runId !== identity.runId || previous.accessScopeHash !== recovery.accessScopeHash) throw new Error('模型恢复身份不匹配')
  }
  const snapshot = await services.select(identity, signal, previous?.modelRef)
  try {
    signal.throwIfAborted()
    if (!(snapshot.modelRef === 'active' || /^preset:[A-Za-z0-9_-]{1,128}$/.test(snapshot.modelRef)) || !/^[A-Za-z0-9:_-]{1,256}$/.test(snapshot.configVersion) || !/^[A-Za-z0-9:_-]{1,256}$/.test(snapshot.credentialVersion) || !/^[A-Za-z0-9:_-]{1,256}$/.test(snapshot.accessScopeHash)) throw new Error('模型配置版本无效')
    if (previous && (snapshot.modelRef !== previous.modelRef || snapshot.configVersion !== previous.configVersion || snapshot.credentialVersion !== previous.credentialVersion || snapshot.accessScopeHash !== previous.accessScopeHash)) throw new Error('模型配置或访问范围已变化，无法恢复')
    const config = structuredClone(resolveByokLlm(snapshot.config, snapshot.credential, services.decryptCredential, services.defaultBaseUrl))
    const binding: Binding = previous ?? { v: 1, nonce: randomUUID(), ...identity, modelRef: snapshot.modelRef, configVersion: snapshot.configVersion, credentialVersion: snapshot.credentialVersion, accessScopeHash: snapshot.accessScopeHash }
    const payload = Buffer.from(JSON.stringify(binding)).toString('base64url')
    const modelIdentity = recovery?.modelIdentity ?? `gugu-model-v1.${payload}.${sign(payload, secret).toString('base64url')}`
    let released = false
    return { modelIdentity, accessScopeHash: binding.accessScopeHash, release: () => { if (!released) { released = true; snapshot.release() } },
      resolve: async (requested, model, requestSignal) => {
        requestSignal.throwIfAborted()
        if (requested.ownerId !== identity.ownerId || requested.sessionId !== identity.sessionId || requested.runId !== identity.runId || model !== modelIdentity) throw new Error('模型访问身份不匹配')
        return { modelIdentity, accessScopeHash: binding.accessScopeHash, config: structuredClone(config), systemPrompt: snapshot.systemPrompt }
      } }
  } catch (error) { snapshot.release(); throw error }
}
