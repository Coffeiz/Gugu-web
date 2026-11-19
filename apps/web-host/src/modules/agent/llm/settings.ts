import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capabilitySnapshot } from '@gugu/core/providers'
import type { RunIdentity } from '@gugu/core/agent'
import { resolveHostEffectiveModelConfiguration } from './resolve.js'
import { resolvePlatformModelSettings } from './platform.js'
import { readConfiguredByokMasterKeys, decryptByokCredential } from '../../byok/crypto.js'

const promptFiles = ['default.md', 'persona.md', 'skills.md', 'policy.md', 'retrieval.md'] as const

/** Web 与 IM 使用同一组固定提示词、环境投影及 BYOK 解封规则；不创建运行配置或密钥。 */
export async function readConfiguredAgentProviderSettings(options: {
  promptRoot: string; environment: NodeJS.ProcessEnv; permissionIdentity: string
}) {
  const environment = options.environment
  const credentialsMasterKeys = await readConfiguredByokMasterKeys(environment)
  const prompt = (await Promise.all(promptFiles.map(name => readFile(join(options.promptRoot, name), 'utf8')))).join('\n\n---\n\n')
  if (!prompt.trim()) throw new Error('Web Agent 提示词不可用')
  return {
    resolveEffective(document: Record<string, unknown>, _identity: RunIdentity) {
      const modelEnvironment = Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined
        && (key === 'AI' || key.startsWith('AI__') || key === 'BYOK__ENABLED')) as Array<[string, string]>)
      return resolveHostEffectiveModelConfiguration({ settings: resolvePlatformModelSettings(document, environment),
        systemPrompt: prompt, credentialsMasterKeys, permissionIdentity: options.permissionIdentity, environment: modelEnvironment })
    },
    decryptCredential(row: Parameters<typeof decryptByokCredential>[0]) {
      return decryptByokCredential(row, version => credentialsMasterKeys[String(version)] ?? '')
    },
    defaultBaseUrl(provider: string, format: string) {
      return capabilitySnapshot({ provider, api_format: format, model: 'web-agent-default-url', api_key: '', base_url: '' }).default_base_url
    },
  }
}
