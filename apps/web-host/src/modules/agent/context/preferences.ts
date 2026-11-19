import type { Pool } from 'pg'
import type { ContextDataPorts, HistoryIdentity, Json } from '@gugu/core/agent'
import { agentContextSubject } from './subject.js'
import type { PreferenceTextFiles } from '@gugu/core'

const truthy = (value: unknown): boolean => value != null && value !== false && value !== 0 && value !== '' && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)
function normalized(value: string | null): string | null {
  if (value === null) return null
  const text = value.trim()
  if (Array.from(text).length > 10000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufeff]/u.test(text)) throw new Error('偏好文本无效')
  return text || null
}
function parseData(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
function revision(value: unknown): number {
  if (!(typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value))) return 0
  const number = Math.trunc(Number(value))
  return Number.isSafeInteger(number) ? Math.max(0, number) : 0
}
function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}

/** 只负责用户时区/偏好和业务修订；其他领域数据必须显式注入。 */
export function createAgentPreferenceContextSources(pool: Pick<Pool, 'query'>, files: Pick<PreferenceTextFiles, 'read'>, redis: { get(key: string): Promise<string | null> }, serverTimezone: string, kind: 'chat' | 'scheduled_task' = 'chat') {
  if (!validTimezone(serverTimezone)) throw new TypeError('服务时区无效')
  async function owned(identity: HistoryIdentity) {
    const subject = agentContextSubject(kind, identity)
    const result = await pool.query<{ timezone: string | null; data_json: string | null }>(`SELECT u.timezone,p.data_json FROM ${subject.from} s
      JOIN users u ON u.id=s.user_id LEFT JOIN user_preferences p ON p.user_id=u.id WHERE s.user_id=$1 AND s.id=$2`, [identity.ownerId, subject.id])
    if (!result.rows[0]) throw new Error(subject.missing)
    return result.rows[0]
  }
  const loadTimezone: ContextDataPorts['loadTimezone'] = async (identity, signal) => {
    signal?.throwIfAborted(); const row = await owned(identity); signal?.throwIfAborted()
    return row.timezone && validTimezone(row.timezone) ? row.timezone : serverTimezone
  }
  const loadStylePreferences: ContextDataPorts['loadStylePreferences'] = async (identity, signal) => {
    signal?.throwIfAborted(); const row = await owned(identity); signal?.throwIfAborted()
    if (row.data_json === null) return {}
    const data = parseData(row.data_json), output: Record<string, Json> = {}
    if (truthy(data.custom_reply_style_enabled)) output.custom_reply_style_enabled = data.custom_reply_style_enabled as Json
    const reply = normalized(await files.read(identity.ownerId, 'reply-style')) ?? (typeof data.custom_reply_style === 'string' ? data.custom_reply_style : null)
    if (reply) output.custom_reply_style = reply
    if (typeof data.locale === 'string' && ['zh-CN', 'ja-JP', 'en-US'].includes(data.locale)) output.locale = data.locale
    const enabled = truthy(data.personality_preference_enabled)
    const personality = enabled ? normalized(await files.read(identity.ownerId, 'personality')) : null
    output.personality_preference_enabled = Boolean(personality && enabled)
    if (personality) output.personality_preference = personality
    output.personality_preference_revision = revision(data.personality_preference_revision)
    signal?.throwIfAborted()
    return output
  }
  const currentRevision = async (identity: HistoryIdentity, signal?: AbortSignal): Promise<number> => {
    signal?.throwIfAborted(); await owned(identity); signal?.throwIfAborted()
    const raw = await redis.get(`context-revision:${identity.ownerId}`)
    signal?.throwIfAborted()
    if (raw === null) return 0
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('上下文版本无效')
    return Number(raw)
  }
  return { loadTimezone, loadStylePreferences, currentRevision }
}
