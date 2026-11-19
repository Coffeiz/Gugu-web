import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { capabilitySnapshot } from '@gugu/core/providers'
import { stableJson, DEFAULT_AGENT_COMPACTION_INSTRUCTION, type ContextLoadPolicy, type ContextSourceSelection, type RunIdentity } from '@gugu/core/agent'
import { decryptByokCredential } from './byok.js'
import { resolveHostEffectiveModelConfiguration } from './effective-model-resolver.js'
import { readConfigOverride } from '../../../adapters/config/config-override-file.js'
import { readConfiguredByokMasterKeys } from '../../../adapters/security/byok-envelope.js'
import { resolvePlatformModelSettings } from './platform-model-settings.js'
import { agentContextAccessScope } from './access-scope.js'
import { createWebAgentProviderBinding } from './web-provider-binding.js'
import type { AgentUsageConfig } from '../../../modules/agent-sessions/persistence/agent-usage-postgres.js'

const promptFiles = ['default.md', 'persona.md', 'skills.md', 'policy.md', 'retrieval.md'] as const

function modelEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined
    && (key === 'AI' || key.startsWith('AI__') || key === 'BYOK__ENABLED')) as Array<[string, string]>)
}

/**
 * 使用当前 Web Host 的真实文件配置、BYOK 版本密钥与固定提示词建立可恢复 Provider 绑定。
 * 密钥只在本次工厂闭包中用于解封和 HMAC 版本材料，不进入公开返回值。
 */
export async function createConfiguredWebAgentProviderBinding(options: {
  pool: Pick<Pool, 'connect'>
  configPath: string
  versionSecret: string
  promptRoot: string
  environment: NodeJS.ProcessEnv
  permissionIdentity: string
  contextPolicy(identity: RunIdentity): ContextLoadPolicy
  defaultLimit6h: number | null
}) {
  if (!options.permissionIdentity.trim() || typeof options.contextPolicy !== 'function') throw new TypeError('Web Agent 权限或上下文策略未配置')
  const credentialsMasterKeys = await readConfiguredByokMasterKeys(options.environment)
  const prompt = (await Promise.all(promptFiles.map(name => readFile(join(options.promptRoot, name), 'utf8')))).join('\n\n---\n\n')
  if (!prompt.trim()) throw new Error('Web Agent 提示词不可用')
  let compactionInstruction: string
  try { compactionInstruction = (await readFile(join(options.promptRoot, 'compress_conv.md'), 'utf8')).trim() || DEFAULT_AGENT_COMPACTION_INSTRUCTION }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    compactionInstruction = DEFAULT_AGENT_COMPACTION_INSTRUCTION
  }
  const policies = new Map<string, ContextLoadPolicy>()
  const runKey = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
  const contextPolicy = (identity: RunIdentity) => {
    const key = runKey(identity), existing = policies.get(key)
    if (existing) return existing
    const resolved = options.contextPolicy(identity)
    if (!resolved || typeof resolved.loadOwnerContext !== 'boolean' || typeof resolved.memoryEnabled !== 'boolean') throw new TypeError('Web Agent 上下文策略无效')
    const frozen = Object.freeze(structuredClone(resolved))
    policies.set(key, frozen)
    return frozen
  }
  const binding = createWebAgentProviderBinding({
    pool: options.pool,
    configPath: options.configPath,
    versionSecret: options.versionSecret,
    readConfiguration: readConfigOverride,
    resolveEffective(document, _identity: RunIdentity) {
      const settings = resolvePlatformModelSettings(document, options.environment)
      return resolveHostEffectiveModelConfiguration({
        settings,
        systemPrompt: prompt,
        credentialsMasterKeys,
        permissionIdentity: options.permissionIdentity,
        environment: modelEnvironment(options.environment),
      })
    },
    async resolveAccessScope(identity, modelVersion, credentialVersion, permissionIdentity) {
      return agentContextAccessScope(options.versionSecret, identity, {
        groupChat: false,
        contextPolicy: contextPolicy(identity),
      }, { permissions: permissionIdentity, model: modelVersion, credentials: credentialVersion },
      value => createHash('sha256').update(stableJson(value)).digest('hex'), 'owner')
    },
    decryptCredential(row) {
      return decryptByokCredential(row, version => credentialsMasterKeys[String(version)] ?? '')
    },
    defaultBaseUrl(provider, format) {
      return capabilitySnapshot({ provider, api_format: format, model: 'web-agent-default-url', api_key: '', base_url: '' }).default_base_url
    },
    defaultLimit6h: options.defaultLimit6h,
  })
  return {
    async accessVersion(identity: RunIdentity): Promise<string> {
      let bound: Awaited<ReturnType<typeof binding.bind>> | undefined
      try {
        bound = await binding.bind(identity, new AbortController().signal)
        return bound.contextScopeKey
      } finally { policies.delete(runKey(identity)); bound?.release() }
    },
    async bind(identity: RunIdentity, signal: AbortSignal,
      recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string }) {
      try { return await binding.bind(identity, signal, recovery) }
      finally { policies.delete(runKey(identity)) }
    },
    async bindRun(identity: RunIdentity, locale: string | null,
      recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string }) {
      const policy = contextPolicy(identity)
      let bound: Awaited<ReturnType<typeof binding.bind>>
      try { bound = await binding.bind(identity, new AbortController().signal, recovery) }
      catch (error) { policies.delete(runKey(identity)); throw error }
      const selectedLocale = locale ?? 'zh-CN'
      if (!['zh-CN', 'ja-JP', 'en-US'].includes(selectedLocale)) {
        policies.delete(runKey(identity)); bound.release()
        throw new TypeError('Web Agent 语言无效')
      }
      const selection: ContextSourceSelection = {
        modelIdentity: bound.modelIdentity,
        contextWindow: bound.contextWindow,
        locale: selectedLocale,
        groupChat: false,
        workspaceBinding: null,
        contextPolicy: policy,
        contextScopeKey: bound.contextScopeKey,
      }
      let released = false
      return {
        selection,
        compactionInstruction,
        resolve: bound.resolve,
        usageConfig: bound.usageConfig satisfies AgentUsageConfig,
        release() {
          if (released) return
          released = true
          policies.delete(runKey(identity))
          bound.release()
        },
      }
    },
  }
}
