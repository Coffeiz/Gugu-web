import { z } from 'zod'
import { sandboxNetworkPolicy } from './sandbox-network.js'
import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { Client } from 'pg'
import { readSystemShellEnabled } from '../terminals/settings.js'

import { pingRedis } from '../../adapters/cache/redis-events.js'

import { readConfigOverride,updateConfigOverride,type ConfigDocument } from '../../adapters/config/config-override-file.js'

import { createPosixConfigFileLock } from '../../adapters/config/posix-config-lock.js'

export interface AdminConfigOptions {
  readonly requireAdmin: preHandlerHookHandler
  readonly path: string
  readonly env: NodeJS.ProcessEnv
}

type Section = Record<string, unknown>
const object = (value: unknown): Section => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Section : {}

const quotaBytes = z.number().int().min(64 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER)
const runtimeSandboxPatch = z.strictObject({
  ephemeral_quota_bytes: quotaBytes.optional(),
  persistent_quota_bytes: quotaBytes.optional(),
  direct_network_policy: sandboxNetworkPolicy.optional(),
})

function currentData(options: AdminConfigOptions): ConfigDocument {
  const saved = readConfigOverride(options.path)
  const dbSaved = object(saved.db)
  const dbUrl = options.env.GUGU_WEBUI_DATABASE_URL?.trim()
  let db: Section = { host: 'localhost', port: 5432, name: 'gugu_web', user: 'gugu', password: '' }
  if (dbUrl) {
    try {
      const url = new URL(dbUrl)
      if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error()
      db = { host: url.hostname, port: Number(url.port || 5432), name: url.pathname.slice(1), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
    } catch { /* Node startup validates this value before mounting the routes. */ }
  }
  const redisRaw = options.env.GUGU_WEBUI_REDIS_URL?.trim()
  let redis: Section = { host: 'localhost', port: 6379, password: '' }
  if (redisRaw) {
    try {
      const url = new URL(redisRaw)
      redis = { host: url.hostname, port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)), password: decodeURIComponent(url.password) }
    } catch { /* Node startup validates this value before mounting the routes. */ }
  }
  const sandbox = object(saved.sandbox)
  const merged: ConfigDocument = {
    sandbox: {
      ephemeral_quota_bytes: Number(options.env.SANDBOX__EPHEMERAL_QUOTA_BYTES ?? sandbox.ephemeral_quota_bytes ?? 1024 * 1024 * 1024),
      ...(typeof sandbox.persistent_quota_bytes === 'number' ? { persistent_quota_bytes: sandbox.persistent_quota_bytes } : {}),
    },
    agent: { shell_system_enabled: readSystemShellEnabled(object(saved.agent), options.env) },
    db: { ...db, ...dbSaved },
    redis: { ...redis, ...object(saved.redis) },
    storage: { backend: 'local', local_path: options.env.STORAGE__LOCAL_PATH || '../Gugu-data/users', ...object(saved.storage) },
    smtp: { enabled: true, port: 465, feedback_email_enabled: true, registration_verification_enabled: true, use_ssl: true, ...object(saved.smtp) },
    security: { alert_email_enabled: false, alert_email_recipients: [], ...object(saved.security) },
    im: { feishu: true, qq: true, wechat: true, telegram: true, ...object(saved.im) },
  }
  const redisSection = object(merged.redis)
  if (options.env.GUGU_WEBUI_REDIS_PASSWORD)
    redisSection.password = options.env.GUGU_WEBUI_REDIS_PASSWORD
  for (const [sectionName, value] of Object.entries(merged)) {
    const sectionValue = object(value)
    for (const [key, field] of Object.entries(sectionValue))
      if (/password|secret|api_key/i.test(key) && typeof field === 'string' && field) sectionValue[key] = '****'
    merged[sectionName] = sectionValue
  }
  return merged
}

function connectionUrl(type: 'db' | 'redis', raw: unknown): string {
  const value = object(raw)
  const host = String(value.host ?? '')
  const port = Number(value.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('连接参数无效')
  if (type === 'redis') {
    const url = new URL(`redis://${host.includes(':') ? `[${host}]` : host}:${port}/0`)
    if (typeof value.password === 'string' && value.password && value.password !== '****') url.password = value.password
    return url.toString()
  }
  const name = String(value.name ?? '')
  const user = String(value.user ?? '')
  if (!name || !user) throw new Error('连接参数无效')
  const url = new URL(`postgresql://${encodeURIComponent(user)}@${host.includes(':') ? `[${host}]` : host}:${port}/${encodeURIComponent(name)}`)
  if (typeof value.password === 'string' && value.password && value.password !== '****') url.password = value.password
  return url.toString()
}

function stripUnchangedSecrets(patch: ConfigDocument): ConfigDocument {
  const result: ConfigDocument = {}
  for (const [sectionName, rawSection] of Object.entries(patch)) {
    const sectionValue = object(rawSection)
    const clean: Section = {}
    for (const [key, value] of Object.entries(sectionValue)) {
      if (/password|secret|api_key/i.test(key) && (value === '' || value === '****' || value === undefined)) continue
      clean[key] = value
    }
    result[sectionName] = clean
  }
  return result
}

export function registerAdminConfigRoutes(app: FastifyInstance, options: AdminConfigOptions): void {
  app.get('/api/v1/admin/config', { preHandler: options.requireAdmin }, async () => ({
    data: currentData(options),
    capabilities: { database_schema_managed_externally: true },
  }))
  app.patch('/api/v1/admin/config', { preHandler: options.requireAdmin }, async (request, reply) => {
    const payload = object(request.body)
    const patch = object(payload.patch)
    if (!Object.keys(patch).length) return reply.code(400).send({ detail: '配置内容无效' })
    const allowed = new Set(['db', 'redis', 'storage', 'smtp', 'security', 'im', 'agent', 'sandbox'])
    if (Object.keys(patch).some((key) => !allowed.has(key))) return reply.code(400).send({ detail: '配置段不受支持' })
    if (Object.hasOwn(patch, 'agent')) {
      const agent = object(patch.agent)
      if (Object.keys(agent).length !== 1 || typeof agent.shell_system_enabled !== 'boolean')
        return reply.code(400).send({ detail: 'Agent 配置仅支持布尔类型的系统范围 Shell 开关' })
    }
    if (Object.hasOwn(patch, 'sandbox') && !runtimeSandboxPatch.safeParse(patch.sandbox).success)
      return reply.code(422).send({ detail: '沙盒运行配置无效，请检查配额和网络规则' })
    const clean = stripUnchangedSecrets(patch)
    const storage = object(clean.storage)
    if (storage.backend !== undefined && storage.backend !== 'local')
      return reply.code(400).send({ detail: 'Gugu 2.0 自托管版只支持本地文件系统' })
    try {
      await updateConfigOverride(options.path, clean, createPosixConfigFileLock())
      const restartRequired = Object.keys(clean).some(key => key !== 'agent')
      return { ok: true, restart_required: restartRequired,
        detail: restartRequired ? '配置已保存，重启 Node Host 后生效' : '配置已保存' }
    } catch {
      return reply.code(500).send({ detail: '用户运行配置保存失败' })
    }
  })
  app.post('/api/v1/admin/config/test-connection', { preHandler: options.requireAdmin }, async (request, reply) => {
    const payload = object(request.body)
    if (payload.type !== 'db' && payload.type !== 'redis')
      return reply.code(400).send({ ok: false, message: 'Node 2.0 仅支持测试 PostgreSQL 和 Redis 连接' })
    try {
      const input = { ...object(payload[payload.type]) }
      const stored = object(readConfigOverride(options.path)[payload.type])
      if (typeof input.password !== 'string' || !input.password || input.password === '****') {
        let envPassword = ''
        try {
          const rawUrl = payload.type === 'redis'
            ? options.env.GUGU_WEBUI_REDIS_URL
            : options.env.GUGU_WEBUI_DATABASE_URL
          if (rawUrl) {
            const url = new URL(rawUrl)
            if (['postgres:', 'postgresql:', 'redis:', 'rediss:'].includes(url.protocol))
              envPassword = decodeURIComponent(url.password)
          }
        } catch { /* The connection probe returns a generic configuration error below. */ }
        input.password = payload.type === 'redis'
          ? options.env.GUGU_WEBUI_REDIS_PASSWORD || String(stored.password || envPassword)
          : String(stored.password || envPassword)
      }
      const url = connectionUrl(payload.type, input)
      let message = '连接成功'
      if (payload.type === 'redis') {
        if (!await pingRedis(url)) throw new Error('connection failed')
        message = 'PONG — 连接正常'
      } else {
        const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
        try {
          await client.connect()
          const result = await client.query<{ version: string | null }>('SELECT version()')
          const version = result.rows[0]?.version
          if (version) message = version.split(',')[0] || message
        } finally { await client.end().catch(() => undefined) }
      }
      return { ok: true, message }
    } catch {
      return { ok: false, message: '连接失败，请检查地址、端口、凭据和网络' }
    }
  })
}
