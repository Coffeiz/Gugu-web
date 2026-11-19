import type { ProviderConfig } from '@gugu/core/providers'
import type { EffectiveModelConfiguration } from './file-model-snapshot-boundary.js'
import type { ModelSettingsSnapshot } from './model-strategy.js'

/** 来自 Host 已完成环境变量、Python 等价默认值和 override 合并后的模型设置。 */
export interface ResolvedPlatformModelSettings {
  readonly ai: ProviderConfig
  readonly ai_presets?: ModelSettingsSnapshot['ai_presets']
  /** 代表 Python BYOKSettings.enabled；宿主必须先应用真实默认值和环境配置。 */
  readonly byokEnabled: boolean
}

/** 安全敏感的版本材料必须由可信 Host 来源解析后提供，不能由 override 推测。 */
export interface HostEffectiveModelInputs {
  readonly settings: ResolvedPlatformModelSettings
  readonly systemPrompt: string
  readonly credentialsMasterKeys: Readonly<Record<string, string>>
  readonly permissionIdentity: string
  readonly environment: Readonly<Record<string, unknown>>
}

/**
 * 组装供文件快照边界使用的完整有效配置。
 *
 * 模型池选择仍由 createModelStrategy 按 Python 的策略语义执行；这里保留完整
 * ai_presets，避免把 pool 配置误折叠成单一 ai。权限、prompt、环境与密钥轮换集
 * 必须由 Host 的真实解析器提供，缺失时 fail closed。
 */
export function resolveHostEffectiveModelConfiguration(input: HostEffectiveModelInputs): EffectiveModelConfiguration {
  const { settings, systemPrompt, credentialsMasterKeys, permissionIdentity, environment } = input
  if (!settings || !settings.ai || typeof settings.ai.model !== 'string' || !settings.ai.model.trim()
    || typeof settings.byokEnabled !== 'boolean') {
    throw new Error('有效平台模型设置不可用')
  }
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) throw new Error('system prompt 不可用')
  if (typeof permissionIdentity !== 'string' || !permissionIdentity.trim()) throw new Error('permission identity 不可用')
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('environment snapshot 不可用')
  if (!credentialsMasterKeys || typeof credentialsMasterKeys !== 'object' || Array.isArray(credentialsMasterKeys)
    || Object.values(credentialsMasterKeys).some(key => typeof key !== 'string' || !key)) {
    throw new Error('credentials master keys 不可用')
  }

  // Python resolve_run_config_for_user 在本地部署下即使平台 BYOK 开关关闭也会尝试 BYOK。
  const byokEnabled = settings.byokEnabled || settings.ai.deployment_mode === 'local'
  if (byokEnabled && Object.keys(credentialsMasterKeys).length === 0) {
    throw new Error('credentials master keys 不可用')
  }

  return {
    ai: structuredClone(settings.ai),
    ...(settings.ai_presets === undefined ? {} : { ai_presets: structuredClone(settings.ai_presets) }),
    byokEnabled,
    systemPrompt,
    versionMaterial: {
      credentialsMasterKeys: structuredClone(credentialsMasterKeys),
      permissionIdentity,
      environment: structuredClone(environment),
    },
  }
}
