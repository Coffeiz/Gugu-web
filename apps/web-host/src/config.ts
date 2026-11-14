import { createPublicSiteConfig, type PublicSiteConfig } from './domains/site/site-config.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfigOverride, type ConfigDocument } from './adapters/config-override-file.js'

export interface WebUiConfig {
  readonly appName: string
  readonly host: string
  readonly port: number
  readonly databaseUrl: string
  readonly secretKey: string
  readonly redisUrl: string | null
  readonly storageDefaultLimitBytes: number | null
  readonly postgresPoolMax: number
  readonly publicSiteConfig: PublicSiteConfig
  readonly smtp: {
    readonly host: string
    readonly port: number
    readonly user: string
    readonly password: string
    readonly fromAddress: string
    readonly enabled: boolean
    readonly useSsl: boolean
  }
  readonly publicAppUrl: string
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
  readonly filesyncEnabled: boolean
  readonly personalityPreferenceEnabled: boolean
  readonly sandboxdSocket: string
  readonly configOverridePath: string | null
}

function integerSetting(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  error: string,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^-?\d+$/.test(value)) throw new Error(error)
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

function overrideBooleanSetting(value: unknown, fallback: boolean, error: string): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') return booleanSetting(value, fallback, error)
  throw new Error(error)
}

function section(document: ConfigDocument, name: string): Record<string, unknown> {
  const value = document[name]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function loadConfig(env: NodeJS.ProcessEnv, configOverridePath: string | null = null): WebUiConfig {
  const override = configOverridePath ? readConfigOverride(configOverridePath) : {}
  const dbOverride = section(override, 'db')
  const agentOverride = section(override, 'agent')
  const filesyncOverride = section(override, 'filesync')
  const smtpOverride = section(override, 'smtp')
  let envDatabasePassword = ''
  try {
    const envDatabaseUrl = env.GUGU_WEBUI_DATABASE_URL?.trim()?.replace(/^postgresql\+asyncpg:/i, 'postgresql:')
    if (envDatabaseUrl) envDatabasePassword = decodeURIComponent(new URL(envDatabaseUrl).password)
  } catch { /* The main validation below reports malformed database URLs without exposing credentials. */ }
  const rawDatabaseUrl = typeof dbOverride.host === 'string'
    ? `postgresql://${encodeURIComponent(String(dbOverride.user ?? 'gugu'))}:${encodeURIComponent(String(dbOverride.password || envDatabasePassword))}@${String(dbOverride.host)}:${Number(dbOverride.port ?? 5432)}/${encodeURIComponent(String(dbOverride.name ?? 'gugu_web'))}`
    : env.GUGU_WEBUI_DATABASE_URL?.trim()
  if (!rawDatabaseUrl) throw new Error('必须配置 GUGU_WEBUI_DATABASE_URL 或 config.override.json 数据库地址')
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

  const redisOverride = section(override, 'redis')
  let envRedisPassword = ''
  try {
    const envRedisUrl = env.GUGU_WEBUI_REDIS_URL?.trim()
    if (envRedisUrl) envRedisPassword = decodeURIComponent(new URL(envRedisUrl).password)
  } catch { /* Redis URL validation below reports malformed values. */ }
  const redisPassword = env.GUGU_WEBUI_REDIS_PASSWORD || String(redisOverride.password || envRedisPassword)
  const rawRedisUrl = typeof redisOverride.host === 'string'
    ? `redis://${redisPassword ? `:${encodeURIComponent(redisPassword)}@` : ''}${String(redisOverride.host)}:${Number(redisOverride.port ?? 6379)}/0`
    : env.GUGU_WEBUI_REDIS_URL?.trim()
  let redisUrl: string | null = null
  if (rawRedisUrl) {
    try {
      const parsed = new URL(rawRedisUrl)
      if (!['redis:', 'rediss:'].includes(parsed.protocol) || !parsed.hostname || parsed.search || parsed.hash)
        throw new Error()
      if (parsed.pathname && !/^\/(?:\d+)?$/.test(parsed.pathname)) throw new Error()
      const password = env.GUGU_WEBUI_REDIS_PASSWORD
      if (password !== undefined && password !== '') parsed.password = password
      redisUrl = parsed.toString()
    } catch {
      throw new Error('GUGU_WEBUI_REDIS_URL 必须是有效的 Redis 连接地址')
    }
  }

  const storageOverride = section(override, 'storage')
  const storageBackend = String(storageOverride.backend ?? env.STORAGE__BACKEND ?? '').trim().toLowerCase()
  if (storageBackend && storageBackend !== 'local')
    throw new Error('Gugu 2.0 自托管版只支持本地文件系统；旧 OSS 数据需先完成迁移或导出')

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

  const smtp = Object.freeze({
    host: String(smtpOverride.host ?? env.SMTP__HOST ?? '').trim(),
    port: integerSetting(
      typeof smtpOverride.port === 'number' ? String(smtpOverride.port) : env.SMTP__PORT,
      465,
      1,
      65535,
      'SMTP 端口配置无效',
    ),
    user: String(smtpOverride.user ?? env.SMTP__USER ?? '').trim(),
    password: String(smtpOverride.password ?? env.SMTP__PASSWORD ?? ''),
    fromAddress: String(smtpOverride.from_addr ?? smtpOverride.fromAddress ?? env.SMTP__FROM_ADDR ?? '').trim(),
    enabled: overrideBooleanSetting(
      smtpOverride.enabled,
      booleanSetting(env.SMTP__ENABLED, true, 'SMTP__ENABLED 配置无效'),
      'smtp.enabled 配置无效',
    ),
    useSsl: overrideBooleanSetting(
      smtpOverride.use_ssl ?? smtpOverride.useSsl,
      booleanSetting(env.SMTP__USE_SSL, true, 'SMTP__USE_SSL 配置无效'),
      'smtp.use_ssl 配置无效',
    ),
  })
  const publicAppUrl = String(override.public_app_url ?? env.GUGU_SITE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  if (publicAppUrl) {
    try {
      const parsed = new URL(publicAppUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicAppUrl)
        throw new Error()
    } catch {
      throw new Error('GUGU_SITE_PUBLIC_URL 配置无效')
    }
  }

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
      smtpHost: smtp.host,
      smtpUser: smtp.user,
      smtpPassword: smtp.password,
      smtpFromAddress: smtp.fromAddress,
      smtpEnabled: smtp.enabled,
      registrationVerificationEnabled: booleanSetting(
        env.SMTP__REGISTRATION_VERIFICATION_ENABLED,
        true,
        'SMTP__REGISTRATION_VERIFICATION_ENABLED 配置无效',
      ),
    }),
    staticRoot: env.GUGU_WEBUI_STATIC_DIR?.trim()
      ? resolve(env.GUGU_WEBUI_STATIC_DIR.trim())
      : resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
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
  Object.defineProperty(config, 'smtp', { value: smtp, enumerable: false })
  Object.defineProperty(config, 'publicAppUrl', { value: publicAppUrl, enumerable: false })
  Object.defineProperty(config, 'logFile', {
    value: env.GUGU_LOG_FILE?.trim() ? resolve(env.GUGU_LOG_FILE.trim()) : null,
    enumerable: false,
  })
  Object.defineProperty(config, 'storageDefaultLimitBytes', {
    value: env.QUOTA__DEFAULT_STORAGE_LIMIT_BYTES === undefined
      || env.QUOTA__DEFAULT_STORAGE_LIMIT_BYTES.trim() === ''
      ? null
      : integerSetting(
        env.QUOTA__DEFAULT_STORAGE_LIMIT_BYTES.trim(),
        -1,
        -1,
        Number.MAX_SAFE_INTEGER,
        'QUOTA__DEFAULT_STORAGE_LIMIT_BYTES 配置无效',
      ),
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
      value: resolve(String(storageOverride.local_path ?? env.STORAGE__LOCAL_PATH?.trim() ?? '../Gugu-data/users')),
      enumerable: false,
    },
    filesyncEnabled: {
      value: overrideBooleanSetting(
        filesyncOverride.enabled,
        booleanSetting(env.FILESYNC__ENABLED, true, 'FILESYNC__ENABLED 配置无效'),
        'filesync.enabled 配置无效',
      ),
      enumerable: false,
    },
    personalityPreferenceEnabled: {
      value: overrideBooleanSetting(
        agentOverride.personality_preference_enabled,
        booleanSetting(env.AGENT__PERSONALITY_PREFERENCE_ENABLED, true, 'AGENT__PERSONALITY_PREFERENCE_ENABLED 配置无效'),
        'agent.personality_preference_enabled 配置无效',
      ),
      enumerable: false,
    },
    configOverridePath: { value: configOverridePath, enumerable: false },
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
