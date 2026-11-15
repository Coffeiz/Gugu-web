import type { ContextDataPorts } from '@gugu/core/agent'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'

export const AGENT_IM_PLATFORMS = ['feishu', 'qq', 'wechat', 'telegram'] as const
export type AgentImPlatform = typeof AGENT_IM_PLATFORMS[number]

function parseReach(raw: string): unknown {
  try { return JSON.parse(raw) } catch { throw new Error('IM 可达记录格式无效') }
}

/** 全局平台开关由可信配置服务提供；Redis 值只用于判断是否可触达，绝不返回凭据或地址。 */
export function createAgentImChannelLoader(options: {
  pool: Pick<Pool, 'query'>
  redis: { get(key: string): Promise<string | null> }
  enabled(platform: AgentImPlatform): boolean | Promise<boolean>
}): ContextDataPorts['loadImChannels'] {
  if (typeof options.enabled !== 'function') throw new TypeError('缺少 IM 平台策略')
  return async (identity, signal) => {
    signal?.throwIfAborted()
    const owner = normalizeOwnerId(identity.ownerId)
    if (!/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId))) throw new TypeError('会话 ID 无效')
    const result = await options.pool.query<{ platform: string | null }>(`SELECT b.platform FROM conversation_sessions s
      LEFT JOIN user_bots b ON b.user_id=s.user_id AND b.enabled=true AND b.platform=ANY($3::text[])
      WHERE s.user_id=$1 AND s.id=$2`, [owner, identity.sessionId, [...AGENT_IM_PLATFORMS]])
    signal?.throwIfAborted()
    if (!result.rows.length) throw new Error('会话不存在')
    const bots = new Set(result.rows.map(row => row.platform))
    const channels: Record<string, boolean> = {}
    for (const platform of AGENT_IM_PLATFORMS) {
      signal?.throwIfAborted()
      if (!await options.enabled(platform)) { channels[platform] = false; continue }
      const specific = await options.redis.get(`imreach:${owner}:${platform}`)
      let reach: unknown = specific ? parseReach(specific) : null
      if (!specific) {
        const recent = await options.redis.get(`imreach:${owner}`)
        const value: unknown = recent ? parseReach(recent) : null
        reach = value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).platform === platform ? value : null
      }
      // Python 的 bool({}) 为 false；损坏数据不能默认为已连接。
      const reachable = !!reach && typeof reach === 'object' && !Array.isArray(reach) && Object.keys(reach).length > 0
      channels[platform] = bots.has(platform) || reachable
    }
    signal?.throwIfAborted()
    return channels
  }
}
