import type { PoolClient } from 'pg'
import type { RunIdentity, Usage } from '@gugu/core/agent'

/** 仅由服务端已认证的模型与运行配置构造，不能直接采用请求体。 */
export interface AgentUsageConfig {
  defaultLimit6h: number | null
  byokEnabled: boolean
  localDeployment: boolean
  model: string
  provider: string
  isByok: boolean
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new TypeError('Agent 用量无效')
  return value
}

function roundStats(rounds: readonly Readonly<Record<string, string | number | null>>[], input: number, read: number, write: number) {
  let fresh = 0, cached = 0, written = 0, cold = 0, warmInput = 0, warmRead = 0
  for (const round of rounds) {
    const f = count(Number(round.input ?? 0)), r = count(Number(round.cache_read ?? 0)), w = count(Number(round.cache_write ?? 0))
    fresh += f; cached += r; written += w
    const total = f + r + w
    if (total > 0) {
      if (r * 100 < total) cold++
      else { warmInput += total; warmRead += r }
    }
  }
  return rounds.length && fresh === input && cached === read && written === write
    ? { cold_calls: cold, warm_input: warmInput, warm_read: warmRead } : null
}

/** 调用方负责与终态 checkpoint 和历史写入同事务提交，并通过 RunStore CAS 防重放。 */
export async function recordAgentUsage(
  client: PoolClient, identity: RunIdentity, usage: Usage, config: AgentUsageConfig,
  rounds: readonly Readonly<Record<string, string | number | null>>[], toolsUsed: readonly string[],
  scenario: 'chat' | 'scheduled' | 'reflection' = 'chat',
): Promise<{ input: number; output: number }> {
  let input = count(usage.input), output = count(usage.output)
  const read = count(usage.cacheRead), write = count(usage.cacheWrite)
  if (config.defaultLimit6h !== null) count(config.defaultLimit6h)
  if (!config.model || !config.provider || typeof config.isByok !== 'boolean'
    || typeof config.byokEnabled !== 'boolean' || typeof config.localDeployment !== 'boolean') throw new TypeError('Agent 记账配置无效')
  const owner = await client.query<{ token_limit_6h: number | null; quota_window_started_at: Date | null }>(
    scenario === 'scheduled'
      ? 'SELECT u.token_limit_6h, u.quota_window_started_at FROM users u WHERE u.id = $1 FOR UPDATE OF u'
      : `SELECT u.token_limit_6h, u.quota_window_started_at FROM users u
      JOIN conversation_sessions s ON s.user_id = u.id WHERE u.id = $1 AND s.id = $2 FOR UPDATE OF u`,
    scenario === 'scheduled' ? [identity.ownerId] : [identity.ownerId, identity.sessionId],
  )
  if (!owner.rows[0]) throw new Error(scenario === 'scheduled' ? '定时任务用户不存在' : 'Agent 会话不存在')
  if (!(input || output || read || write)) return { input: 0, output: 0 }
  const user = owner.rows[0]
  const limit = user.token_limit_6h === -1 ? null : user.token_limit_6h ?? config.defaultLimit6h
  if (limit !== null) count(limit)
  let exempt = false
  if (limit !== null && (config.byokEnabled || config.localDeployment)) {
    const credential = await client.query(`SELECT 1 FROM user_provider_credentials
      WHERE user_id = $1 AND capability = 'llm' AND enabled = true LIMIT 1`, [identity.ownerId])
    exempt = credential.rows.length > 0
  }
  if (limit !== null && !exempt) {
    const window = await client.query<{ started: Date }>(
      `UPDATE users SET quota_window_started_at = CASE WHEN quota_window_started_at IS NULL
         OR quota_window_started_at <= clock_timestamp() - interval '6 hours' THEN clock_timestamp()
         ELSE quota_window_started_at END WHERE id = $1 RETURNING quota_window_started_at AS started`, [identity.ownerId])
    const used = await client.query<{ total: string }>(
      `SELECT coalesce(sum(tokens_in::bigint + tokens_out::bigint), 0)::text AS total FROM agent_usage
       WHERE user_id = $1 AND is_byok = false AND created_at >= $2`, [identity.ownerId, window.rows[0]!.started])
    const total = Number(used.rows[0]!.total)
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('Agent 历史用量无效')
    const remaining = Math.max(0, limit - total)
    if (input + output > remaining) { input = Math.min(input, remaining); output = remaining - input }
  }
  if (!(input || output || read || write)) return { input, output }
  const stats = roundStats(rounds, input, read, write)
  await client.query(`INSERT INTO agent_usage (user_id, session_id, tokens_in, tokens_out, cache_read, cache_write,
    cache_round_stats, model, provider, is_byok, tools_used, scenario, input_source, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,clock_timestamp())`,
  [identity.ownerId, scenario === 'scheduled' ? null : identity.sessionId, input, output, read, write, stats ? JSON.stringify(stats) : null,
    config.model, config.provider, config.isByok, toolsUsed.length ? JSON.stringify(toolsUsed) : null,
    scenario, scenario === 'scheduled' ? null : 'web'])
  return { input, output }
}
