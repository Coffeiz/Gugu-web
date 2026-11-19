import type { Pool } from 'pg'
import { readConfigOverride } from '../../../adapters/config/config-override-file.js'
import { pythonQueryBoolean } from '../../../http/python-query.js'

/** 与当前agent配置同源；每次重读，冻结版本由Provider绑定负责，不从入站声明memory。 */
export function createImRuntimeSettings(configPath: string, environment: NodeJS.ProcessEnv) {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    memoryEnabled(): boolean {
      try {
        const document = readConfigOverride(configPath), configured = record(document.agent)
        const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]))
        const aggregate = env.agent ? record(JSON.parse(env.agent)) : {}
        const base = env.agent__memory_enabled ?? aggregate.memory_enabled ?? true
        const value = Object.hasOwn(configured, 'memory_enabled') ? configured.memory_enabled : base
        return pythonQueryBoolean(value === 0 || value === 1 ? Boolean(value) : value)
      } catch { throw new Error('IM 记忆配置不可用') }
    },
    defaultLimit6h(): number | null {
      try {
        const document = readConfigOverride(configPath), raw = environment.QUOTA__DEFAULT_TOKEN_LIMIT_6H ?? record(document.quota).default_token_limit_6h
        if (raw === undefined || raw === null || raw === '') return null
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value < 0) throw new Error()
        return value
      } catch { throw new Error('IM 模型配额配置不可用') }
    },
  }
}

/** 只检查已显式应用的迁移；禁止启动入口自行DDL或修补用户表。 */
export async function assertImHostSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  const names = ['agent_run_startups', 'agent_run_dispatch', 'agent_interaction_intents', 'agent_interaction_bindings', 'agent_interaction_resumes', 'gugu_agent_active_reasoning',
    'gugu_im_gateway_admissions', 'gugu_im_inbound_receipts', 'gugu_im_inbound_segments', 'gugu_im_inbound_batch_members',
    'gugu_im_run_delivery', 'gugu_im_delivery_receipts', 'gugu_im_platform_projection', 'gugu_im_accepted_delivery_facts',
    'gugu_im_binding_consumptions', 'gugu_im_shortcut_controls', 'gugu_im_native_deliveries', 'gugu_im_native_prompt_messages',
    'gugu_im_pending_ask_runs', 'gugu_im_reaction_receipts', 'gugu_im_file_tool_receipts', 'gugu_im_reflection_jobs',
    'gugu_im_reflection_owner_revisions', 'gugu_im_reflection_run_revisions', 'gugu_im_reflection_cursor_positions',
    'gugu_im_reflection_trigger_states','gugu_im_reflection_trigger_observed','gugu_im_reflection_trigger_windows','gugu_im_runtime_bindings',
    'gugu_im_voice_cache', 'gugu_im_voice_run_bindings', 'gugu_im_owner_sessions', 'gugu_im_owner_session_receipts', 'gugu_im_compact_commands', 'gugu_im_retired_inbound',
    'gugu_im_history_retention_targets','gugu_im_history_retention_storage']
  try {
    const rows = await pool.query<{ name: string; present: boolean }>('SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name', [names])
    if (rows.rows.length !== names.length || rows.rows.some(row => !names.includes(row.name) || row.present !== true)) throw new Error()
    await pool.query('SELECT s.bot_id,m.im_platform_message_id,m.conversation_seq,m.run_id FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id LIMIT 0')
    await pool.query('SELECT window_key FROM gugu_im_reflection_jobs LIMIT 0')
    const projection = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid=to_regclass('gugu_im_platform_projection') AND conname='gugu_im_platform_projection_platform_check' AND contype='c' AND convalidated`)
    if (projection.rows.length !== 1 || !['feishu', 'qq', 'telegram'].every(platform => projection.rows[0]!.definition.includes(`'${platform}'`))) throw new Error()
    await pool.query('SELECT scope_versions FROM gugu_im_reflection_run_revisions LIMIT 0')
    await pool.query('SELECT last_sequence,last_message_id,scope_version FROM gugu_im_reflection_cursor_positions LIMIT 0')
    await pool.query('SELECT st.observe_after,w.scope_versions,w.through_message_seq FROM gugu_im_reflection_trigger_states st CROSS JOIN gugu_im_reflection_trigger_windows w LIMIT 0')
  } catch { throw new Error('Node IM 数据库迁移尚未就绪') }
}
