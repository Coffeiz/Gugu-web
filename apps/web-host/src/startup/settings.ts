import { type WebUiConfig } from '../config.js'
import { readConfigOverride } from '../adapters/config/config-override-file.js'
import { type UserQuotaSettings } from '../modules/auth/quota/read.js'

export function objectSetting(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function optionalIntegerSetting(envValue: string | undefined, configValue: unknown, key: string): number | null {
  const raw = envValue === undefined ? configValue : envValue.trim()
  if (raw === undefined || raw === null || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${key} 配置无效`)
  return value
}

export function userQuotaSettings(config: WebUiConfig, env: NodeJS.ProcessEnv): UserQuotaSettings {
  const override = config.configOverridePath ? readConfigOverride(config.configOverridePath) : {}
  const quota = objectSetting(override.quota)
  const byok = objectSetting(override.byok)
  const ai = objectSetting(override.ai)
  const deploymentMode = env.AI__DEPLOYMENT_MODE?.trim().toLowerCase()
    || String(ai.deployment_mode ?? 'cloud').trim().toLowerCase()
  return {
    defaultLimit6h: optionalIntegerSetting(
      env.QUOTA__DEFAULT_TOKEN_LIMIT_6H, quota.default_token_limit_6h, 'QUOTA__DEFAULT_TOKEN_LIMIT_6H',
    ),
    defaultLimitWeekly: optionalIntegerSetting(
      env.QUOTA__DEFAULT_TOKEN_LIMIT_WEEKLY, quota.default_token_limit_weekly, 'QUOTA__DEFAULT_TOKEN_LIMIT_WEEKLY',
    ),
    byokEnabled: booleanSetting(env.BYOK__ENABLED, byok.enabled, true),
    localDeployment: deploymentMode === 'local',
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }
}

export function booleanSetting(envValue: string | undefined, configValue: unknown, fallback: boolean): boolean {
  const raw = envValue === undefined ? configValue : envValue.trim().toLowerCase()
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(raw.toLowerCase())) return true
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(raw.toLowerCase())) return false
  }
  throw new Error('用户配额功能开关配置无效')
}
