import { readConfigOverride } from '../../adapters/config-override-file.js'
import type { SafeEgressReadSettings } from '@gugu/core/preferences/safe-egress'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function enabled(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    if (['1','true','t','yes','y','on'].includes(value.toLowerCase())) return true
    if (['0','false','f','no','n','off'].includes(value.toLowerCase())) return false
  }
  throw new Error('安全出站配置 enabled 无效')
}

/** 与 Python 一致：默认 < SAFE_EGRESS JSON < 嵌套环境变量 < override；读取时热更新，不写配置。 */
export function createSafeEgressSettingsReader(env: NodeJS.ProcessEnv, path: string) {
  return (): SafeEgressReadSettings => {
    const normalized = Object.fromEntries(Object.entries(env).map(([key,value]) => [key.toUpperCase(),value]))
    let base: unknown = {}
    if (normalized.SAFE_EGRESS !== undefined) {
      try { base = JSON.parse(normalized.SAFE_EGRESS) } catch { throw new Error('安全出站环境配置无效') }
      if (!object(base)) throw new Error('安全出站环境配置无效')
    }
    const values: Record<string, unknown> = { enabled:false, proxy_url:'', proxy_auth_secret:'', ...base as Record<string, unknown> }
    for (const key of ['enabled','proxy_url','proxy_auth_secret']) {
      const value = normalized[`SAFE_EGRESS__${key.toUpperCase()}`]
      if (value !== undefined) values[key] = value
    }
    const raw = readConfigOverride(path).safe_egress
    if (raw !== undefined && raw !== null) {
      if (!object(raw)) throw new Error('安全出站配置必须是对象')
      for (const key of ['enabled','proxy_url','proxy_auth_secret']) if (Object.hasOwn(raw,key)) values[key] = raw[key]
    }
    if (typeof values.proxy_url !== 'string' || typeof values.proxy_auth_secret !== 'string') throw new Error('安全出站配置文本字段无效')
    return { enabled:enabled(values.enabled), proxy_url:values.proxy_url, proxy_auth_secret:values.proxy_auth_secret }
  }
}
