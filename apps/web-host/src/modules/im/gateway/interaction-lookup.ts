import type { Pool, PoolClient } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { selectImTextChoice, type ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import type { AgentInteractionRespondService } from '../../agent-sessions/agent-interaction-respond.js'
import { projectInteractionPromptLocked } from '../../agent-sessions/persistence/agent-interaction-projection-postgres.js'
import { imInteractionScopeSql as scopeSql, imInteractionScopeParameters as params, imOrdinaryInteractionReplayed } from '../../agent-sessions/persistence/agent-im-interaction-replay-postgres.js'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { createImTextChoiceConsumer, type ScopedImTextPrompt } from './preflight-interactions.js'

export interface ImInteractionTarget { readonly identity: RunIdentity; readonly promptId: number; readonly toolCallId: string }
interface PromptRow {
  id: number; session_id: number; kind: string; schema_json: unknown; run_id: string; interaction_id: string; tool_call_id: string
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export class ImInteractionLookupError extends Error {
  constructor() { super('IM 交互暂时无法处理'); this.name = 'ImInteractionLookupError' }
}
const columns = 'SELECT p.id,p.session_id,p.kind,p.schema_json,b.run_id,b.interaction_id,b.tool_call_id '
// 仅来自可信准入收据的DB时刻；SQL比较保留微秒，不经JS Date降精度。
const phaseBefore = (parameter: '$7' | '$9') => `AND (${parameter}::timestamptz IS NULL OR (p.created_at<=${parameter}::timestamptz
  AND (COALESCE(p.schema_json::jsonb->>'custom_input_active','false')<>'true' OR EXISTS (
    SELECT 1 FROM interaction_actions phase WHERE phase.prompt_id=p.id AND phase.option_id='__custom_reply__'
      AND phase.status='consumed' AND phase.consumed_at<=${parameter}::timestamptz))))`
function cutoff(scope: ImPreflightScope): string | null {
  const value = scope.admissionCutoff
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value)) throw new ImInteractionLookupError()
  return value
}
function validate(scope: ImPreflightScope): void {
  cutoff(scope)
  if (!scope.ownerId || !/^[1-9]\d*$/u.test(scope.botId) || !['feishu', 'qq', 'wechat', 'telegram'].includes(scope.platform) ||
    !scope.platformUserId || typeof scope.eventId !== 'string' || !scope.eventId || scope.eventId.length > 8192 ||
    (scope.chatType === 'c2c' ? scope.chatId !== null : scope.chatType !== 'group' || !scope.chatId)) throw new ImInteractionLookupError()
}
function target(scope: ImPreflightScope, row: PromptRow): ImInteractionTarget {
  return { identity: { ownerId: scope.ownerId, sessionId: String(row.session_id), runId: row.run_id }, promptId: row.id, toolCallId: row.tool_call_id }
}
function shape(scope: ImPreflightScope, row: PromptRow): ScopedImTextPrompt {
  const schema = record(row.schema_json), secretTarget = record(record(schema.context).secret_target)
  return { scope, promptId: row.id, sessionId: row.session_id, kind: row.kind,
    secret: Array.isArray(schema.secret_fields) && schema.secret_fields.length > 0 && secretTarget.kind === 'mcp_credentials',
    allowTextInput: schema.source === 'agent' && schema.allow_text_input === true, customInputActive: schema.custom_input_active === true,
    options: (Array.isArray(schema.options) ? schema.options : []).map(record).map(option => ({
      id: String(option.id || ''), label: String(option.label || option.id || ''), token: null,
    })) }
}

/** 使用现有确认/文本恢复服务；仅匹配后颁发单个动作token，无匹配绝不轮换平台按钮。 */
export function createPostgresImTextChoiceConsumer(options: {
  pool: Pick<Pool, 'connect'>
  service: AgentInteractionRespondService
  /** scope预检及每次投影/消费前实时复核；有target时还须复核原Run的权限和工具确认归属。 */
  authorize(scope: ImPreflightScope, signal: AbortSignal, target?: ImInteractionTarget): Promise<boolean>
}) {
  if (typeof options.authorize !== 'function') throw new TypeError('IM 交互授权服务未配置')
  async function authorized(scope: ImPreflightScope, signal: AbortSignal, row?: PromptRow): Promise<void> {
    signal.throwIfAborted()
    if (!await options.authorize(scope, signal, row ? target(scope, row) : undefined)) throw new ImInteractionLookupError()
    signal.throwIfAborted()
  }
  async function find(scope: ImPreflightScope, signal: AbortSignal, text = ''): Promise<readonly ScopedImTextPrompt[] | { readonly replayed: true }> {
    validate(scope)
    try {
      await authorized(scope, signal)
      return await withPostgresTransaction(options.pool, async client => {
        // 私密输入由秘密stage自己的完整scope收据处理，普通文本lookup不可吞掉secret事件。
        if (await imOrdinaryInteractionReplayed(client, scope)) return { replayed: true }
        const candidates = await client.query<PromptRow>(`${columns}${scopeSql}
          AND p.status='active' AND p.expires_at>clock_timestamp()
          AND EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=b.user_id AND c.session_id=b.session_id AND c.run_id=b.run_id AND c.status='waiting')
          AND NOT EXISTS (SELECT 1 FROM agent_run_dispatch d WHERE d.user_id=b.user_id AND d.session_id=b.session_id AND d.run_id=b.run_id AND d.cancel_requested IS TRUE)
          ${phaseBefore('$7')}
          ORDER BY s.updated_at DESC,CASE WHEN p.kind IN ('choice','confirm') THEN 0 ELSE 1 END,p.created_at DESC,p.id DESC FOR UPDATE OF p`, [...params(scope), cutoff(scope)])
        for (const row of candidates.rows) {
          const prompt = shape(scope, row)
          if (prompt.secret) continue
          // schema完整顺序保持不变；仅给真实可用动作临时标记以进行纯规则匹配。
          const actions = await client.query<{ option_id: string }>("SELECT option_id FROM interaction_actions WHERE prompt_id=$1 AND status='pending' AND expires_at>clock_timestamp()", [row.id])
          const available = new Set(actions.rows.map(action => action.option_id))
          const pending = { ...prompt, options: prompt.options.map(option => ({ ...option, token: available.has(option.id) ? option.id : null })) }
          const selected = selectImTextChoice(pending, text)
          if (!selected) continue
          await authorized(scope, signal, row)
          if (selected.action === 'text') return [prompt]
          const projection = await projectInteractionPromptLocked(client, target(scope, row).identity, row.interaction_id, selected.token)
          if (projection.resolved) throw new ImInteractionLookupError()
          const optionsById = new Map(projection.options.map(option => [option.id, option.token]))
          const issued = { ...prompt, options: prompt.options.map(option => ({ ...option, token: optionsById.get(option.id) ?? null })) }
          if (selectImTextChoice(issued, text)?.action !== 'option') throw new ImInteractionLookupError()
          return [issued]
        }
        return []
      })
    } catch { signal.throwIfAborted(); throw new ImInteractionLookupError() }
  }
  async function authorize(scope: ImPreflightScope, promptId: number, sessionId: number, signal: AbortSignal): Promise<boolean> {
    try {
      return await withPostgresTransaction(options.pool, async (client: PoolClient) => {
        const found = await client.query<PromptRow>(`${columns}${scopeSql} AND p.id=$7 AND p.session_id=$8 AND p.status='active' AND p.expires_at>clock_timestamp()
          AND EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=b.user_id AND c.session_id=b.session_id AND c.run_id=b.run_id AND c.status='waiting')
          AND NOT EXISTS (SELECT 1 FROM agent_run_dispatch d WHERE d.user_id=b.user_id AND d.session_id=b.session_id AND d.run_id=b.run_id AND d.cancel_requested IS TRUE)
          ${phaseBefore('$9')}`, [...params(scope), promptId, sessionId, cutoff(scope)])
        const current = found.rows[0]
        // 同一批次可有该speaker的多个真实锚点，不能把JOIN的重复证明误认为越权。
        if (!current || found.rows.some(row => row.id !== current.id || row.session_id !== current.session_id
          || row.run_id !== current.run_id || row.interaction_id !== current.interaction_id || row.tool_call_id !== current.tool_call_id)
          || shape(scope, current).secret) return false
        await authorized(scope, signal, current)
        return true
      })
    } catch { signal.throwIfAborted(); throw new ImInteractionLookupError() }
  }
  const consume = createImTextChoiceConsumer({ service: options.service, find, authorize })
  return (scope: ImPreflightScope, text: string, signal: AbortSignal) => consume(Object.freeze({ ...scope }), text, signal)
}
