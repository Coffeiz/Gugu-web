import type { Pool, PoolClient } from 'pg'
import type { InteractionActionRecord, InteractionCommandActionInput, InteractionCommandActionResult, InteractionConsumeStore,
  InteractionConsumeTransaction, InteractionPromptRecord } from '@gugu/core/agent/interactions/consume-action'
import type { InteractionTextPrompt, InteractionTextStore } from '@gugu/core/agent'
export interface InteractionSideEffects {
  applyCommandAction(client: PoolClient, input: InteractionCommandActionInput): Promise<InteractionCommandActionResult>
  redeemConfirmation(client: PoolClient, ownerId: string, code: string): Promise<boolean>
  beforeCommit?(client: PoolClient, prompt: InteractionPromptRecord, action: InteractionActionRecord): Promise<void>
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** 行锁与用户归属验证、状态写入、命令副作用处于同一 PostgreSQL 事务。 */
export function createPostgresInteractionConsumeStore(pool: Pick<Pool, 'connect'>, effects: InteractionSideEffects): InteractionConsumeStore {
  return { async transaction(run) {
    const client = await pool.connect()
    let prompt: InteractionPromptRecord | null = null, action: InteractionActionRecord | null = null, committed = false, discard = false
    try {
      await client.query('BEGIN')
      const tx: InteractionConsumeTransaction = {
        async getOwnedPrompt(ownerId, promptId) {
          const result = await client.query('SELECT id, user_id, session_id, kind, status, expires_at, resolved_at, schema_json FROM interaction_prompts WHERE id = $1 AND user_id = $2 FOR UPDATE', [promptId, ownerId])
          const row = result.rows[0]
          prompt = row ? { id: row.id, ownerId: row.user_id, sessionId: row.session_id, kind: row.kind, status: row.status, expiresAt: new Date(row.expires_at), resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null, schema: object(row.schema_json) } : null
          return prompt
        },
        async lockAction(promptId, tokenHash) {
          const result = await client.query('SELECT id, prompt_id, token_hash, action_type, option_id, context_json, status, expires_at, consumed_at, consumed_event_id FROM interaction_actions WHERE prompt_id = $1 AND token_hash = $2 FOR UPDATE', [promptId, tokenHash])
          const row = result.rows[0]
          action = row ? { id: row.id, promptId: row.prompt_id, tokenHash: row.token_hash, actionType: row.action_type, optionId: row.option_id, context: object(row.context_json), status: row.status, expiresAt: new Date(row.expires_at), consumedAt: row.consumed_at ? new Date(row.consumed_at) : null, consumedEventId: row.consumed_event_id } : null
          return action
        },
        applyCommandAction: input => effects.applyCommandAction(client, input),
        redeemConfirmation: (ownerId, code) => effects.redeemConfirmation(client, ownerId, code),
        async commit() {
          if (committed) throw new Error('交互事务已提交')
          if (prompt && action && prompt.status === 'resolved' && action.status === 'consumed') await effects.beforeCommit?.(client, prompt, action)
          if (prompt) await client.query('UPDATE interaction_prompts SET status = $3, resolved_at = $4, schema_json = $5 WHERE id = $1 AND user_id = $2', [prompt.id, prompt.ownerId, prompt.status, prompt.resolvedAt, JSON.stringify(prompt.schema)])
          // 自定义输入阶段与Gateway准入使用同一DB时钟，不能以Node时钟偏差让旧文本跨阶段。
          if (action) await client.query(`UPDATE interaction_actions SET status = $3,
            consumed_at = CASE WHEN (option_id='__custom_reply__' OR action_type='custom_reply') AND status='pending' AND $3='consumed'
              THEN clock_timestamp() ELSE $4 END, consumed_event_id = $5 WHERE id = $1 AND prompt_id = $2`, [action.id, action.promptId, action.status, action.consumedAt, action.consumedEventId])
          await client.query('COMMIT'); committed = true
        },
      }
      const result = await run(tx)
      if (!committed) await client.query('ROLLBACK')
      return result
    } catch (error) {
      if (!committed) try { await client.query('ROLLBACK') } catch { discard = true }
      throw error
    } finally { client.release(discard) }
  } }
}

/** 文本回答与恢复队列使用同一事务；过期用例允许显式提交后再返回 409。 */
export function createPostgresInteractionTextStore(
  pool: Pick<Pool, 'connect'>,
  enqueue: (client: PoolClient, prompt: InteractionTextPrompt, eventId?: string) => Promise<void>,
): InteractionTextStore {
  return { async transaction(run) {
    const client = await pool.connect()
    let prompt: InteractionTextPrompt | null = null, committed = false, discard = false
    try {
      await client.query('BEGIN')
      const tx = {
        async getOwnedPrompt(ownerId: string, promptId: number) {
          const result = await client.query('SELECT id,user_id,session_id,kind,status,expires_at,resolved_at,schema_json FROM interaction_prompts WHERE id=$1 AND user_id=$2 FOR UPDATE', [promptId, ownerId])
          const row = result.rows[0]
          prompt = row ? { id: row.id, ownerId: row.user_id, sessionId: row.session_id, kind: row.kind, status: row.status,
            expiresAt: new Date(row.expires_at), resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null, schema: object(row.schema_json) } : null
          return prompt
        },
        async enqueueResume(current: InteractionTextPrompt, eventId?: string) {
          if (!prompt || current.id !== prompt.id || current.ownerId !== prompt.ownerId) throw new Error('交互恢复绑定无效')
          // 与文本结果及恢复引用同事务保存事件收据；不包含正文，公开result保持原契约。
          if (eventId) prompt.schema = { ...prompt.schema, node_text_consumed_event_id: eventId }
          await enqueue(client, prompt, eventId)
        },
        async commit() {
          if (committed) throw new Error('交互事务已提交')
          if (prompt) await client.query('UPDATE interaction_prompts SET status=$3,resolved_at=$4,schema_json=$5 WHERE id=$1 AND user_id=$2',
            [prompt.id, prompt.ownerId, prompt.status, prompt.resolvedAt, JSON.stringify(prompt.schema)])
          await client.query('COMMIT')
          committed = true
        },
      }
      const result = await run(tx)
      if (!committed) await client.query('ROLLBACK')
      return result
    } catch (error) {
      if (!committed) try { await client.query('ROLLBACK') } catch { discard = true }
      throw error
    } finally { client.release(discard) }
  } }
}
