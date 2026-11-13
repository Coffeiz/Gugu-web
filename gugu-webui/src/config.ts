import { createPublicSiteConfig, type PublicSiteConfig } from './domains/site/site-config.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WebUiConfig {
  readonly appName: string
  readonly host: string
  readonly port: number
  readonly databaseUrl: string
  readonly secretKey: string
  readonly redisUrl: string | null
  readonly storageBackend: 'local' | 'oss'
  readonly postgresPoolMax: number
  readonly publicSiteConfig: PublicSiteConfig
  readonly staticRoot: string
  readonly logFile: string | null
  readonly workspaceRuntimeSettings: {
    readonly shellEnabled: boolean
    readonly shellSystemEnabled: boolean
    readonly shellDangerousEnabled: boolean
    readonly automaticModeEnabled: boolean
    readonly fullUserSandboxAuthorizationEnabled: boolean
    readonly terminalMode: 'auto' | 'pty_disabled' | 'entry_disabled'
  }
  readonly adminUsername: string
  readonly adminPassword: string
  readonly adminAllowedHosts: string
  readonly accessTokenExpiresMinutes: number
  readonly storageLocalPath: string
  readonly sandboxdSocket: string
}

function integerSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  error: string,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(error)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(error)
  return parsed
}

function booleanSetting(value: string | undefined, fallback: boolean, error: string): boolean {
  if (value === undefined || value === '') return fallback
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 't':
    case 'yes':
    case 'y':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'f':
    case 'no':
    case 'n':
    case 'off':
      return false
    default:
      throw new Error(error)
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): WebUiConfig {
  const rawDatabaseUrl = env.GUGU_WEBUI_DATABASE_URL?.trim()
  if (!rawDatabaseUrl) throw new Error('必须配置 GUGU_WEBUI_DATABASE_URL')
  const secretKey = env.GUGU_WEBUI_SECRET_KEY?.trim() || env.SECRET_KEY?.trim()
  if (!secretKey) throw new Error('必须配置 GUGU_WEBUI_SECRET_KEY 或 SECRET_KEY')

  const databaseUrl = rawDatabaseUrl.replace(/^postgresql\+asyncpg:/i, 'postgresql:')
  let protocol: string
  try {
    protocol = new URL(databaseUrl).protocol
  } catch {
    throw new Error('GUGU_WEBUI_DATABASE_URL 必须是有效的 PostgreSQL 连接地址')
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:')
    throw new Error('GUGU_WEBUI_DATABASE_URL 必须使用 PostgreSQL')

  const rawRedisUrl = env.GUGU_WEBUI_REDIS_URL?.trim()
  let redisUrl: string | null = null
  if (rawRedisUrl) {
    try {
      const parsed = new URL(rawRedisUrl)
      if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash)
        throw new Error()
      if (parsed.pathname && !/^\/(?:\d+)?$/.test(parsed.pathname)) throw new Error()
      redisUrl = rawRedisUrl
    } catch {
      throw new Error('GUGU_WEBUI_REDIS_URL 必须是有效的 Redis 连接地址')
    }
  }

  const storageBackend = (env.STORAGE__BACKEND?.trim().toLowerCase() || 'local')
  if (storageBackend !== 'local' && storageBackend !== 'oss')
    throw new Error('STORAGE__BACKEND 必须是 local 或 oss')

  const terminalMode = env.SANDBOX__TERMINAL_MODE?.trim().toLowerCase() || 'auto'
  if (!['auto', 'pty_disabled', 'entry_disabled'].includes(terminalMode))
    throw new Error('SANDBOX__TERMINAL_MODE 配置无效')
  const workspaceRuntimeSettings = Object.freeze({
    shellEnabled: booleanSetting(env.AGENT__SHELL_ENABLED, true, 'AGENT__SHELL_ENABLED 配置无效'),
    shellSystemEnabled: booleanSetting(env.AGENT__SHELL_SYSTEM_ENABLED, false, 'AGENT__SHELL_SYSTEM_ENABLED 配置无效'),
    shellDangerousEnabled: booleanSetting(env.AGENT__SHELL_DANGEROUS_ENABLED, true, 'AGENT__SHELL_DANGEROUS_ENABLED 配置无效'),
    automaticModeEnabled: booleanSetting(env.AGENT__AUTOMATIC_MODE_ENABLED, true, 'AGENT__AUTOMATIC_MODE_ENABLED 配置无效'),
    fullUserSandboxAuthorizationEnabled: booleanSetting(
      env.SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED,
      true,
      'SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED 配置无效',
    ),
    terminalMode: terminalMode as 'auto' | 'pty_disabled' | 'entry_disabled',
  })

  const host = env.GUGU_WEBUI_HOST?.trim() || '127.0.0.1'
  if (!host || /[\s/]/.test(host)) throw new Error('GUGU_WEBUI_HOST 配置无效')

  const config = {
    appName: env.GUGU_WEBUI_APP_NAME?.trim() || 'Gugu',
    host,
    port: integerSetting(env.GUGU_WEBUI_PORT, 9595, 1, 65535, 'GUGU_WEBUI_PORT 端口无效'),
    postgresPoolMax: integerSetting(
      env.GUGU_WEBUI_PG_POOL_MAX,
      10,
      1,
      100,
      'GUGU_WEBUI_PG_POOL_MAX 连接池参数无效',
    ),
    publicSiteConfig: createPublicSiteConfig({
      icpNumber: env.GUGU_SITE_ICP_NUMBER ?? '',
      icpUrl: env.GUGU_SITE_ICP_URL ?? 'https://beian.miit.gov.cn/',
      smtpHost: env.SMTP__HOST ?? '',
      smtpUser: env.SMTP__USER ?? '',
      smtpPassword: env.SMTP__PASSWORD ?? '',
      smtpFromAddress: env.SMTP__FROM_ADDR ?? '',
      smtpEnabled: booleanSetting(env.SMTP__ENABLED, true, 'SMTP__ENABLED 配置无效'),
      registrationVerificationEnabled: booleanSetting(
        env.SMTP__REGISTRATION_VERIFICATION_ENABLED,
        true,
        'SMTP__REGISTRATION_VERIFICATION_ENABLED 配置无效',
      ),
    }),
    staticRoot: env.GUGU_WEBUI_STATIC_DIR?.trim()
      ? resolve(env.GUGU_WEBUI_STATIC_DIR.trim())
      : resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/dist'),
  }
  Object.defineProperty(config, 'databaseUrl', {
    value: databaseUrl,
    enumerable: false,
  })
  Object.defineProperty(config, 'secretKey', {
    value: secretKey,
    enumerable: false,
  })
  Object.defineProperty(config, 'redisUrl', {
    value: redisUrl,
    enumerable: false,
  })
  Object.defineProperty(config, 'logFile', {
    value: env.GUGU_LOG_FILE?.trim() ? resolve(env.GUGU_LOG_FILE.trim()) : null,
    enumerable: false,
  })
  Object.defineProperty(config, 'storageBackend', {
    value: storageBackend,
    enumerable: false,
  })
  Object.defineProperties(config, {
    adminUsername: { value: env.ADMIN_USERNAME?.trim() || 'admin', enumerable: false },
    adminPassword: { value: env.ADMIN_PASSWORD ?? '', enumerable: false },
    adminAllowedHosts: { value: env.ADMIN_ALLOWED_HOSTS?.trim() ?? '', enumerable: false },
    accessTokenExpiresMinutes: {
      value: integerSetting(env.ACCESS_TOKEN_EXPIRE_MINUTES, 10080, 1, 525600, 'ACCESS_TOKEN_EXPIRE_MINUTES 配置无效'),
      enumerable: false,
    },
    storageLocalPath: {
      value: resolve(env.STORAGE__LOCAL_PATH?.trim() || '../Gugu-data/users'),
      enumerable: false,
    },
    sandboxdSocket: {
      value: env.GUGU_SANDBOXD_SOCKET?.trim() || '/run/gugu/sandboxd.sock',
      enumerable: false,
    },
  })
  Object.defineProperty(config, 'workspaceRuntimeSettings', {
    value: workspaceRuntimeSettings,
    enumerable: false,
  })
  return Object.freeze(config) as WebUiConfig
}
