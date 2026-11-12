export interface WebUiConfig {
  readonly appName: string
  readonly host: string
  readonly port: number
  readonly databaseUrl: string
  readonly secretKey: string
  readonly postgresPoolMax: number
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
  }
  Object.defineProperty(config, 'databaseUrl', {
    value: databaseUrl,
    enumerable: false,
  })
  Object.defineProperty(config, 'secretKey', {
    value: secretKey,
    enumerable: false,
  })
  return Object.freeze(config) as WebUiConfig
}
