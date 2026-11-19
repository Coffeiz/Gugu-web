import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { openLocalFile, UnsafeLocalPathError } from '@gugu/fs/node'
import { createGreetingGenerator } from '@gugu/core/agent'
import { stableJson } from '@gugu/core/agent'
import { capabilitySnapshot, completeStandaloneText } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import type { ProviderConfig, ProviderTransport } from '@gugu/core/providers'
import type { GreetingCache, GreetingGeneratorPorts, GreetingMemory, GreetingProject, GreetingPromptInput } from '@gugu/core/agent'
import { createModelStrategy } from '../agent/model-config/model-strategy.js'
import { readActiveLlmCredential, resolveByokLlmAsync } from '../agent/model-config/byok.js'
import { resolvePlatformModelSettings } from '../agent/model-config/platform-model-settings.js'
import { createConfiguredByokEnvelope } from '../../adapters/security/byok-envelope.js'
import { readConfigOverride } from '../../adapters/config/config-override-file.js'
import type { ScheduledTaskRedisCommands } from '../../modules/scheduled-tasks/persistence/redis-lease.js'

const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const releaseLock = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"

function date(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : null
  }
  return null
}

function parseDaily(value: string): Array<{ date: string; note: string }> {
  let current = ''
  const rows: Array<{ date: string; note: string }> = []
  for (const raw of value.split(/\r?\n/u)) {
    const line = raw.trim()
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})$/u.exec(line)
    if (heading) { current = heading[1]!; continue }
    const bullet = /^-\s+(.+?)\s*$/u.exec(line)
    if (current && bullet?.[1]) rows.push({ date: current, note: bullet[1] })
  }
  return rows
}

async function readMemoryFile(root: string, ownerId: string, name: string): Promise<string | null> {
  const key = `${ownerId}/.agent/${name}`
  try {
    const opened = await openLocalFile(root, key)
    if (!opened) return null
    try {
      if (opened.size > 256 * 1024) throw new Error('问候记忆文件超出限制')
      return new TextDecoder('utf-8').decode(await opened.handle.readFile())
    } finally { await opened.handle.close() }
  } catch (error) {
    if (error instanceof UnsafeLocalPathError) throw error
    return null
  }
}

async function readGreetingMemory(root: string, ownerId: string): Promise<GreetingMemory | null> {
  try {
    const [summaryRaw, summaryLegacy, summaryTimestamp, profileRaw, dailyRaw] = await Promise.all([
      readMemoryFile(root, ownerId, 'summary.json'), readMemoryFile(root, ownerId, 'summary.md'),
      readMemoryFile(root, ownerId, 'summary.ts'), readMemoryFile(root, ownerId, 'profile.json'),
      readMemoryFile(root, ownerId, 'daily.md'),
    ])
    // Python 兼容旧 summary.md + summary.ts；问候读取不触发迁移写入。
    const summary = summaryRaw ? JSON.parse(summaryRaw) as Record<string, unknown>
      : summaryLegacy ? { text: summaryLegacy, ts: Number(summaryTimestamp) || null } : null
    const profile = profileRaw ? JSON.parse(profileRaw) as unknown : null
    if (summary && (typeof summary !== 'object' || Array.isArray(summary))) return null
    if (profile !== null && !Array.isArray(profile)) return null
    return {
      summary: summary && typeof summary.text === 'string' ? summary.text : '',
      summaryAt: summary && typeof summary.ts === 'number' ? new Date(summary.ts * 1000) : null,
      profile: Array.isArray(profile) ? profile.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' ? [`- ${(item as Record<string, string>).text}`] : []).join('\n') : '',
      daily: parseDaily(dailyRaw ?? ''),
    }
  } catch { return null }
}

function readStance(root: string, ownerId: string): Promise<{ value: string; updatedAt: Date | null } | null> {
  return readMemoryFile(root, ownerId, 'stance.json').then(raw => {
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    return typeof record.stance === 'string' ? { value: record.stance, updatedAt: typeof record.ts === 'number' ? new Date(record.ts * 1000) : null } : null
  }).catch(() => null)
}

/** PostgreSQL 与 owner 本地记忆的可信读取；每类上下文分别容错，保持 Python 问候的降级边界。 */
export function createPostgresGreetingContextReader(pool: Pick<Pool, 'query'>, storageRoot: string, serverTimezone: string) {
  if (!storageRoot.trim()) throw new TypeError('问候记忆存储未配置')
  return async (ownerId: string, signal: AbortSignal) => {
    if (!ownerPattern.test(ownerId)) throw new TypeError('问候身份无效')
    signal.throwIfAborted()
    const [timezoneResult, lastMessageResult, projectResult, memory, stance] = await Promise.all([
      pool.query<{ timezone: string | null }>('SELECT timezone FROM users WHERE id = $1 LIMIT 1', [ownerId]).catch(() => ({ rows: [] as { timezone: string | null }[] })),
      pool.query<{ created_at: Date | string }>(`SELECT m.created_at FROM conversation_messages m
        JOIN conversation_sessions s ON s.id = m.session_id WHERE s.user_id = $1
        ORDER BY m.created_at DESC LIMIT 1`, [ownerId]).catch(() => ({ rows: [] as { created_at: Date | string }[], queryFailed: true as const })),
      pool.query<GreetingProject & { start_date: string | null; deadline: string | null }>(`SELECT id, name, status, progress, priority,
        start_date::text AS start_date, deadline::text AS deadline FROM projects
        WHERE user_id = $1 AND deleted_at IS NULL AND archived IS FALSE AND status IN ('pending','active')`, [ownerId]).catch(() => ({ rows: [] as Array<GreetingProject & { start_date: string | null; deadline: string | null }> })),
      readGreetingMemory(storageRoot, ownerId), readStance(storageRoot, ownerId),
    ])
    signal.throwIfAborted()
    const timezoneValue = timezoneResult.rows[0]?.timezone
    let timeZone = serverTimezone || 'UTC'
    if (timezoneValue) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneValue }); timeZone = timezoneValue } catch { /* Python user_tz falls back to the server timezone. */ }
    }
    const stanceValue = stance
    const result: Omit<import('@gugu/core/agent').GreetingPromptInput, 'locale' | 'now'> = {
      timeZone, lastMessageAt: date(lastMessageResult.rows[0]?.created_at),
      ...('queryFailed' in lastMessageResult ? { lastMessageQueryFailed: true } : {}),
      projects: projectResult.rows.map(row => ({ id: Number(row.id), name: String(row.name), status: row.status, progress: Number(row.progress), priority: row.priority, startDate: row.start_date, deadline: row.deadline })),
      memory: memory ? { summary: memory.summary, summaryAt: memory.summaryAt, profile: memory.profile, daily: memory.daily } : null,
      stance: stanceValue && stanceValue.updatedAt ? { value: stanceValue.value, updatedAt: stanceValue.updatedAt } : null,
    }
    return result
  }
}

/** Redis 锁与 Python 共用 key/TTL；wait 在 Host 异步轮询，不阻塞事件循环。 */
export function createRedisGreetingCache(redis: ScheduledTaskRedisCommands, get: (key: string) => Promise<string | null>, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): GreetingCache {
  return {
    get,
    async set(key, value, ttlSeconds) { await redis.set(key, value, 'EX', String(ttlSeconds)) },
    async acquire(key, ttlSeconds, waitSeconds, signal) {
      const token = randomUUID(), end = Date.now() + waitSeconds * 1000
      do {
        signal?.throwIfAborted()
        if (await redis.set(key, token, 'EX', String(ttlSeconds), 'NX') === 'OK') {
          let released = false
          return { async release() { if (released) return; released = true; await redis.eval(releaseLock, 1, key, token) } }
        }
        if (Date.now() >= end) break
        await wait(Math.min(250, Math.max(1, end - Date.now())))
        signal?.throwIfAborted()
      } while (Date.now() <= end)
      return null
    },
  }
}

export type GreetingGenerator = ReturnType<typeof import('@gugu/core/agent').createGreetingGenerator>
export type GreetingContextReader = ReturnType<typeof createPostgresGreetingContextReader>
export type GreetingPorts = Omit<GreetingGeneratorPorts, 'readContext' | 'cache'>

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function greetingEnabled(overridePath: string, env: NodeJS.ProcessEnv): boolean {
  let value: unknown = true
  if (env.AGENT) {
    const parsed: unknown = JSON.parse(env.AGENT)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Agent 环境配置无效')
    if (Object.hasOwn(parsed, 'greeting_enabled')) value = (parsed as Record<string, unknown>).greeting_enabled
  }
  if (env.AGENT__GREETING_ENABLED !== undefined) {
    const raw = env.AGENT__GREETING_ENABLED.trim().toLowerCase()
    value = ['1', 'true', 't', 'yes', 'y', 'on'].includes(raw) ? true
      : ['0', 'false', 'f', 'no', 'n', 'off'].includes(raw) ? false : (() => { throw new Error('问候开关配置无效') })()
  }
  const override = record(readConfigOverride(overridePath).agent)
  if (Object.hasOwn(override, 'greeting_enabled')) value = override.greeting_enabled
  return Boolean(value)
}

/** 完整复用 Python 运行配置优先级、模型池选择、BYOK gate/owner 凭据和 Core Provider。 */
export function createStandaloneGreetingCompleter(pool: Pick<Pool, 'query'>, overridePath: string, env: NodeJS.ProcessEnv, createTransport?: (config: ProviderConfig) => ProviderTransport & { close?(): Promise<void> }) {
  const readSelection = async (_ownerId: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const document = readConfigOverride(overridePath)
    const settings = resolvePlatformModelSettings(document, env)
    return { ai: settings.ai, ai_presets: settings.ai_presets,
      byokEnabled: settings.byokEnabled, systemPrompt: '', accessScopeHash: 'standalone-greeting' }
  }
  const select = createModelStrategy(readSelection)
  const envelope = createConfiguredByokEnvelope(env)
  return async (ownerId: string, prompt: string, maxTokens: number, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted()
    const selected = await select(ownerId, signal)
    try {
      const local = selected.config.deployment_mode === 'local' || ['local', 'ollama'].includes((selected.config.provider ?? '').toLowerCase())
      const credential = selected.byokEnabled || local ? await readActiveLlmCredential(pool, ownerId) : null
      signal.throwIfAborted()
      const config = await resolveByokLlmAsync(selected.config as ProviderConfig & Record<string, unknown>, credential, row => envelope.decrypt({
        ciphertext: row.encrypted_value, nonce: row.nonce, encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version,
      }), (provider, format) => {
        const base = { ...selected.config, provider, api_format: format, base_url: '' } as ProviderConfig
        return capabilitySnapshot(base).default_base_url
      }) as unknown as ProviderConfig
      const transport = createTransport?.(config) ?? createNodeProviderTransport({ allowLocal: local, connectTimeoutMs: 5_000, writeTimeoutMs: 10_000, environment: () => env })
      try {
        return await completeStandaloneText({ config, prompt, maxTokens, signal,
          identity: { ownerId, sessionId: 'greeting', runId: 'greeting' } }, {
          transport, digest: value => createHash('sha256').update(stableJson(value)).digest('hex'),
        })
      } finally { await transport.close?.() }
    } finally { selected.release() }
  }
}

export function createProductionGreeting(options: {
  pool: Pick<Pool, 'query'>; storageRoot: string; serverTimezone: string; overridePath: string; env: NodeJS.ProcessEnv
  redis?: GreetingCache; enabled?: () => boolean
  onFailure?: GreetingGeneratorPorts['onFailure']
}) {
  const readContext = createPostgresGreetingContextReader(options.pool, options.storageRoot, options.serverTimezone)
  const complete = createStandaloneGreetingCompleter(options.pool, options.overridePath, options.env)
  const enabled = options.enabled ?? (() => greetingEnabled(options.overridePath, options.env))
  return createGreetingGenerator({ enabled, readContext: readContext as (ownerId: string, signal: AbortSignal) => Promise<Omit<GreetingPromptInput, 'locale' | 'now'>>,
    complete, ...(options.redis ? { cache: options.redis } : {}), onFailure: options.onFailure })
}
