import type { Pool, PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { normalizeSecretFields, stableJson, validateSecretValues, type RunIdentity } from '@gugu/core/agent'
import type { ImPreflightScope, ImSecretAction, ImSecretResult, ImSecretStage } from '@gugu/core/im/inbound-preflight'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { consumeSecretInteractionLocked, SecretInteractionError, type SecretEnvelope, type SecretInteractionPorts } from './agent-secret-interaction-postgres.js'
import { imOrdinaryInteractionReplayed } from './agent-im-interaction-replay-postgres.js'

const platforms = ['feishu', 'qq', 'wechat', 'telegram']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function privateScope(scope: ImPreflightScope): boolean {
  return platforms.includes(scope.platform) && !!scope.ownerId && /^[1-9]\d*$/u.test(scope.botId) &&
    scope.chatType === 'c2c' && scope.chatId === null && !!scope.platformUserId
}
export class ImSecretInputError extends Error {
  constructor() { super('IM 凭据输入已结束或暂时无法处理'); this.name = 'ImSecretInputError' }
}

/** 已持有会话锁；只用真实持久 session 建立私聊暂存，群/Web 不生成 stage。 */
export async function stageImSecretPromptLocked(client: PoolClient, identity: RunIdentity, promptId: number, serverId: string): Promise<boolean> {
  const session = (await client.query<{ source: string; bot_id: string | null; chat_type: string | null; chat_id: string | null; platform_user_id: string | null }>(
    'SELECT source,bot_id,chat_type,chat_id,platform_user_id FROM conversation_sessions WHERE id=$1 AND user_id=$2', [identity.sessionId, identity.ownerId])).rows[0]
  if (!session || !platforms.includes(session.source) || session.chat_type !== 'c2c' || session.chat_id || !session.bot_id || !session.platform_user_id) return false
  if (!uuid.test(serverId)) throw new ImSecretInputError()
  const inserted = await client.query(`INSERT INTO mcp_secret_inputs
    (prompt_id,user_id,server_id,session_id,platform,bot_id,chat_id,chat_type,platform_user_id,status,next_field_index,consumed_event_ids,encrypted_payload,payload_nonce,encrypted_data_key,key_version,expires_at,created_at,updated_at)
    SELECT p.id,p.user_id,m.id,p.session_id,s.source,s.bot_id,NULL,'c2c',s.platform_user_id,'pending_choice',0,'[]'::json,'','','',1,p.expires_at,clock_timestamp(),clock_timestamp()
    FROM interaction_prompts p JOIN conversation_sessions s ON s.id=p.session_id AND s.user_id=p.user_id
    JOIN user_mcp_servers m ON m.id=$4 AND m.user_id=p.user_id AND m.scope='user'
    JOIN user_bots b ON b.id::text=s.bot_id AND b.user_id=p.user_id AND b.platform=s.source AND b.enabled IS TRUE
    JOIN users u ON u.id=p.user_id AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
    WHERE p.id=$1 AND p.user_id=$2 AND p.session_id=$3 AND p.status='active' AND p.expires_at>clock_timestamp()
      AND s.chat_type='c2c' AND s.chat_id IS NULL AND s.platform_user_id IS NOT NULL AND s.platform_user_id<>''
    ON CONFLICT (prompt_id) DO NOTHING`, [promptId, identity.ownerId, identity.sessionId, serverId])
  if (inserted.rowCount !== 1) throw new ImSecretInputError()
  return true
}

interface StageRow {
  id: number; prompt_id: number; session_id: number; server_id: string; status: string
  next_field_index: number; consumed_event_ids: unknown; encrypted_payload: string; payload_nonce: string
  encrypted_data_key: string; key_version: number; schema_json: unknown; live: boolean; ended: boolean
  revision: string; admitted: boolean
  run_id: string; interaction_id: string; tool_call_id: string
}
const stageSql = `SELECT i.id,i.prompt_id,i.session_id,i.server_id,i.status,i.next_field_index,i.consumed_event_ids,
  i.encrypted_payload,i.payload_nonce,i.encrypted_data_key,i.key_version,p.schema_json,
  owned.run_id,owned.interaction_id,owned.tool_call_id,
  to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision,
  ($5::timestamptz IS NULL OR (i.updated_at<=$5::timestamptz AND p.created_at<=$5::timestamptz)) AS admitted,
  (p.status='active' AND p.expires_at>clock_timestamp() AND i.expires_at>clock_timestamp()) AS live,
  (EXISTS (SELECT 1 FROM agent_interaction_bindings b JOIN agent_run_checkpoints c
    ON c.user_id=b.user_id AND c.session_id=b.session_id AND c.run_id=b.run_id
    WHERE b.prompt_id=p.id AND b.user_id=p.user_id AND c.status IN ('completed','cancelled','failed','unknown'))
    OR EXISTS (SELECT 1 FROM agent_interaction_bindings b JOIN agent_run_dispatch d
      ON d.user_id=b.user_id AND d.session_id=b.session_id AND d.run_id=b.run_id
      WHERE b.prompt_id=p.id AND b.user_id=p.user_id AND d.cancel_requested IS TRUE)) AS ended
  FROM mcp_secret_inputs i JOIN interaction_prompts p ON p.id=i.prompt_id AND p.user_id=i.user_id AND p.session_id=i.session_id
  JOIN agent_interaction_bindings owned ON owned.prompt_id=p.id AND owned.user_id=p.user_id AND owned.session_id=p.session_id
  JOIN conversation_sessions s ON s.id=i.session_id AND s.user_id=i.user_id AND s.source=i.platform
    AND s.bot_id=i.bot_id AND s.chat_type='c2c' AND s.chat_id IS NULL AND s.platform_user_id=i.platform_user_id
  JOIN user_bots bot ON bot.id::text=i.bot_id AND bot.user_id=i.user_id AND bot.platform=i.platform AND bot.enabled IS TRUE
  JOIN users u ON u.id=p.user_id AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
  WHERE i.user_id=$1 AND i.platform=$2 AND i.bot_id=$3 AND i.chat_type='c2c' AND i.chat_id IS NULL AND i.platform_user_id=$4`
const parameters = (scope: ImPreflightScope) => [scope.ownerId, scope.platform, scope.botId, scope.platformUserId, scope.admissionCutoff ?? null]
function seen(row: StageRow): string[] {
  if (!Array.isArray(row.consumed_event_ids) || row.consumed_event_ids.some(id => typeof id !== 'string')) throw new ImSecretInputError()
  return row.consumed_event_ids as string[]
}
function choose(rows: StageRow[], eventId: string): StageRow | null {
  // 必须先看同scope所有旧prompt的去重记录，不能把旧事件交给新prompt。
  return rows.find(row => !!eventId && seen(row).includes(eventId))
    ?? rows.find(row => ['pending_choice', 'awaiting_secret'].includes(row.status)) ?? null
}
export interface ImSecretInputPorts extends SecretInteractionPorts {
  decrypt(envelope: SecretEnvelope): string | Promise<string>
  /** durable恢复与缓存失效已提交后的非权威唤醒。 */
  wake(): Promise<void>
  diagnose(): void
  /** Gateway组合在stage锁内复核真实Run/pending/当前权限；旧直接服务契约保持兼容。 */
  authorizeLocked?(client:PoolClient,scope:ImPreflightScope,target:{identity:RunIdentity;promptId:number;toolCallId:string}):Promise<void>
}

/** IM逐字段状态与既有凭据业务写入共用事务；只在Host保存envelope，不写聊天/日志。 */
export function createPostgresImSecretInput(pool: Pick<Pool, 'connect'>, ports: ImSecretInputPorts) {
  for (const name of ['encrypt', 'decrypt', 'enqueue', 'invalidate', 'wake', 'diagnose'] as const)
    if (typeof ports[name] !== 'function') throw new TypeError('IM 凭据服务未完整配置')
  function context(scope: ImPreflightScope) {
    if (scope.admissionCutoff !== undefined && (typeof scope.admissionCutoff !== 'string' || !scope.admissionCutoff
      || scope.admissionCutoff.length > 80 || /[\x00-\x1f\x7f]/.test(scope.admissionCutoff))) throw new ImSecretInputError()
    return { owner: scope.ownerId, platform: scope.platform, bot: scope.botId, chatType: scope.chatType, chat: scope.chatId,
      sender: scope.platformUserId, event: scope.eventId, cutoff: scope.admissionCutoff ?? null }
  }
  function stateDigest(row: StageRow) {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.prompt_id) || row.prompt_id < 1
      || !Number.isSafeInteger(row.session_id) || row.session_id < 1 || typeof row.revision !== 'string' || !row.revision
      || typeof row.admitted !== 'boolean' || [row.run_id, row.interaction_id, row.tool_call_id].some(value => typeof value !== 'string' || !value)) throw new ImSecretInputError()
    return createHash('sha256').update(stableJson({ id: row.id, prompt: row.prompt_id, session: row.session_id,
      server: row.server_id, phase: row.status, index: row.next_field_index, events: seen(row), revision: row.revision,
      run: row.run_id, interaction: row.interaction_id, toolCall: row.tool_call_id,
      schema: row.schema_json, ciphertext: row.encrypted_payload, nonce: row.payload_nonce,
      encryptedKey: row.encrypted_data_key, keyVersion: row.key_version })).digest('hex')
  }
  async function reference(scope: ImPreflightScope, row: StageRow): Promise<string> {
    const state = { kind: 'im-stage-reference-v1', scope: context(scope), id: row.id, prompt: row.prompt_id, session: row.session_id, digest: stateDigest(row) }
    const envelope = await ports.encrypt({ __im_stage_reference: JSON.stringify(state) })
    const value = `ims1:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`
    if (value.length > 16_384) throw new ImSecretInputError()
    return value
  }
  async function readReference(scope: ImPreflightScope, value: string) {
    if (typeof value !== 'string' || value.length > 16_384 || !/^ims1:[A-Za-z0-9_-]+$/.test(value)) throw new ImSecretInputError()
    const bytes = Buffer.from(value.slice(5), 'base64url')
    if (bytes.toString('base64url') !== value.slice(5)) throw new ImSecretInputError()
    const envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (typeof envelope.ciphertext !== 'string' || !envelope.ciphertext || typeof envelope.nonce !== 'string'
      || typeof envelope.encryptedDataKey !== 'string' || typeof envelope.keyVersion !== 'number' || !Number.isSafeInteger(envelope.keyVersion) || envelope.keyVersion < 1) throw new ImSecretInputError()
    const clear = object(JSON.parse(await ports.decrypt(envelope as unknown as SecretEnvelope)))
    if (Object.keys(clear).length !== 1 || typeof clear.__im_stage_reference !== 'string') throw new ImSecretInputError()
    const state = object(JSON.parse(clear.__im_stage_reference))
    if (state.kind !== 'im-stage-reference-v1' || stableJson(state.scope) !== stableJson(context(scope))
      || !Number.isSafeInteger(state.id) || Number(state.id) < 1 || !Number.isSafeInteger(state.prompt) || Number(state.prompt) < 1
      || !Number.isSafeInteger(state.session) || Number(state.session) < 1 || typeof state.digest !== 'string' || !/^[a-f0-9]{64}$/.test(state.digest)) throw new ImSecretInputError()
    return { id: Number(state.id), prompt: Number(state.prompt), session: Number(state.session), digest: state.digest }
  }
  async function inspectSecret(scope: ImPreflightScope, signal: AbortSignal): Promise<ImSecretStage> {
    if (!privateScope(scope)) return { status: 'none' }
    try {
      signal.throwIfAborted()
      context(scope)
      return await withPostgresTransaction(pool, async client => {
        if (await imOrdinaryInteractionReplayed(client, scope)) return { status: 'replay' }
        const rows = (await client.query<StageRow>(`${stageSql} ORDER BY i.prompt_id DESC`, parameters(scope))).rows
        const row = choose(rows, scope.eventId)
        if (!row) return { status: 'none' }
        if (scope.eventId && seen(row).includes(scope.eventId)) return { status: 'replay' }
        if (!row.live || row.ended || !row.admitted) return { status: 'ended' }
        const token = await reference(scope, row)
        signal.throwIfAborted()
        return { status: row.status as 'pending_choice' | 'awaiting_secret', reference: token }
      })
    } catch { signal.throwIfAborted(); throw new ImSecretInputError() }
  }
  async function applySecret(scope: ImPreflightScope, inspectedReference: string, action: ImSecretAction, signal: AbortSignal,
    native?: { promptId: number; token: string }): Promise<ImSecretResult> {
    if (!privateScope(scope) || !scope.eventId || Array.from(scope.eventId).length > 200
      || typeof inspectedReference !== 'string' || !inspectedReference) throw new ImSecretInputError()
    try {
      signal.throwIfAborted()
      const result = await withPostgresTransaction(pool, async client => {
        // 原生按钮不能先在另一事务耗token；同scope/stage事务持有真实动作行后再推进。
        let nativeAction: { id: number; option_id: string; status: string; consumed_event_id: string | null; live: boolean } | undefined
        if (native) {
          if (!Number.isSafeInteger(native.promptId) || native.promptId < 1 || typeof native.token !== 'string' || !native.token || native.token.length > 256 || action.action === 'value') throw new ImSecretInputError()
          const ownedStage = (await client.query<StageRow>(`${stageSql} AND i.prompt_id=$6`, [...parameters(scope), native.promptId])).rows[0]
          if (!ownedStage) throw new ImSecretInputError()
          nativeAction = (await client.query<{ id: number; option_id: string; status: string; consumed_event_id: string | null; live: boolean }>(`SELECT id,option_id,status,consumed_event_id,expires_at>clock_timestamp() AS live
            FROM interaction_actions WHERE prompt_id=$1 AND token_hash=$2`,[native.promptId,createHash('sha256').update(native.token).digest('hex')])).rows[0]
          if (!nativeAction || !nativeAction.live || !['input_credentials','cancel'].includes(nativeAction.option_id)) throw new ImSecretInputError()
          if (nativeAction.status === 'consumed' && nativeAction.consumed_event_id === scope.eventId) return { status:'replay' } as const
          if (nativeAction.status !== 'pending' || (nativeAction.option_id === 'input_credentials' ? action.action !== 'start' : action.action !== 'cancel')) throw new ImSecretInputError()
        }
        if (await imOrdinaryInteractionReplayed(client, scope)) return { status: 'replay' } as const
        const previous = choose((await client.query<StageRow>(`${stageSql} ORDER BY i.prompt_id DESC`, parameters(scope))).rows, scope.eventId)
        if (previous && seen(previous).includes(scope.eventId)) return { status: 'replay' } as const
        const expected = await readReference(scope, inspectedReference)
        if (native && expected.prompt !== native.promptId) throw new ImSecretInputError()
        // 与激活/替换及Web完成保持会话→prompt→stage锁顺序，防旧prompt被新输入复活。
        await client.query('SELECT id FROM conversation_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [expected.session, scope.ownerId])
        await client.query('SELECT id FROM interaction_prompts WHERE id=$1 AND user_id=$2 FOR UPDATE', [expected.prompt, scope.ownerId])
        const row = (await client.query<StageRow>(`${stageSql} AND i.id=$6 FOR UPDATE OF i`, [...parameters(scope), expected.id])).rows[0]
        if (!row) throw new ImSecretInputError()
        if (native) {
          nativeAction = (await client.query<NonNullable<typeof nativeAction>>(`SELECT id,option_id,status,consumed_event_id,expires_at>clock_timestamp() AS live
            FROM interaction_actions WHERE prompt_id=$1 AND token_hash=$2 FOR UPDATE`,[native.promptId,createHash('sha256').update(native.token).digest('hex')])).rows[0]
          if (!nativeAction || !nativeAction.live || nativeAction.status !== 'pending'
            || (action.action === 'start' ? nativeAction.option_id !== 'input_credentials' : nativeAction.option_id !== 'cancel')) throw new ImSecretInputError()
        }
        const events = seen(row)
        if (events.includes(scope.eventId)) return { status: 'replay' } as const
        if (row.id !== expected.id || row.prompt_id !== expected.prompt || row.session_id !== expected.session
          || stateDigest(row) !== expected.digest || !row.live || row.ended || !row.admitted
          || !['pending_choice', 'awaiting_secret'].includes(row.status) || events.length >= 32) throw new ImSecretInputError()
        await ports.authorizeLocked?.(client,scope,{identity:{ownerId:scope.ownerId,sessionId:String(row.session_id),runId:row.run_id},promptId:row.prompt_id,toolCallId:row.tool_call_id})
        const schema = object(row.schema_json), target = object(object(schema.context).secret_target)
        const fields = normalizeSecretFields(schema.secret_fields)
        if (!fields || target.kind !== 'mcp_credentials' || typeof target.server_id !== 'string' ||
          !uuid.test(target.server_id) || target.server_id.toLowerCase() !== row.server_id.toLowerCase()) throw new ImSecretInputError()
        signal.throwIfAborted()
        const recorded = [...events, scope.eventId]
        if (nativeAction) {
          if (action.action === 'start' && row.status !== 'pending_choice') return { status:'awaiting_secret',fieldLabel:fields[0]!.label } as const
          await client.query(`UPDATE interaction_actions SET status='consumed',consumed_at=clock_timestamp(),consumed_event_id=$2 WHERE id=$1 AND status='pending'`,[nativeAction.id,scope.eventId])
        }
        if (action.action === 'cancel') {
          await consumeSecretInteractionLocked(client, ports, scope.ownerId, row.prompt_id, null)
          await client.query('UPDATE mcp_secret_inputs SET consumed_event_ids=$2,updated_at=clock_timestamp() WHERE id=$1', [row.id, JSON.stringify(recorded)])
          return { status: 'cancelled' } as const
        }
        if (action.action === 'start') {
          if (row.status !== 'pending_choice') throw new ImSecretInputError()
          await client.query("UPDATE mcp_secret_inputs SET status='awaiting_secret',consumed_event_ids=$2,updated_at=clock_timestamp() WHERE id=$1", [row.id, JSON.stringify(recorded)])
          return { status: 'awaiting_secret', fieldLabel: fields[0]!.label } as const
        }
        if (row.status !== 'awaiting_secret' || !Number.isSafeInteger(row.next_field_index) || row.next_field_index < 0 || row.next_field_index >= fields.length) throw new ImSecretInputError()
        let values: Record<string, string>
        try {
          const field = fields[row.next_field_index]!
          const previous = row.encrypted_payload ? JSON.parse(await ports.decrypt({ ciphertext: row.encrypted_payload, nonce: row.payload_nonce,
            encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version })) : {}
          if (!previous || typeof previous !== 'object' || Array.isArray(previous) || Object.values(previous).some(value => typeof value !== 'string') ||
            Object.keys(previous).length !== row.next_field_index || fields.slice(0, row.next_field_index).some(field => !Object.hasOwn(previous, field.name))) throw new ImSecretInputError()
          values = { ...previous, ...validateSecretValues([field], { [field.name]: action.value }) }
        } catch {
          signal.throwIfAborted()
          await failStage(client, row, recorded)
          return { status: 'failed' } as const
        }
        if (row.next_field_index + 1 < fields.length) {
          const envelope = await ports.encrypt(values)
          signal.throwIfAborted()
          await client.query(`UPDATE mcp_secret_inputs SET next_field_index=next_field_index+1,consumed_event_ids=$2,
            encrypted_payload=$3,payload_nonce=$4,encrypted_data_key=$5,key_version=$6,updated_at=clock_timestamp() WHERE id=$1`,
          [row.id, JSON.stringify(recorded), envelope.ciphertext, envelope.nonce, envelope.encryptedDataKey, envelope.keyVersion])
          return { status: 'awaiting_secret', fieldLabel: fields[row.next_field_index + 1]!.label } as const
        }
        // 正式业务校验（包括header/slot）失败须回滚；未确认的数据库错误不能伪装成功。
        await client.query('SAVEPOINT im_secret_finish')
        try {
          await consumeSecretInteractionLocked(client, ports, scope.ownerId, row.prompt_id, values)
          await client.query('RELEASE SAVEPOINT im_secret_finish')
        } catch (error) {
          if (!(error instanceof SecretInteractionError)) throw error
          await client.query('ROLLBACK TO SAVEPOINT im_secret_finish')
          await failStage(client, row, recorded)
          return { status: 'failed' } as const
        }
        await client.query('UPDATE mcp_secret_inputs SET next_field_index=$2,consumed_event_ids=$3,updated_at=clock_timestamp() WHERE id=$1', [row.id, fields.length, JSON.stringify(recorded)])
        return { status: 'completed' } as const
      })
      if (result.status === 'completed' || result.status === 'cancelled') {
        try { await ports.wake() } catch { try { ports.diagnose() } catch { /* 已提交事实不因唤醒失败回滚。 */ } }
      }
      return result
    } catch { signal.throwIfAborted(); throw new ImSecretInputError() }
  }
  /** 仅清理有Node交互绑定的到期stage，不清理Python消费者的运行状态。 */
  async function cleanupExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('凭据清理批量无效')
    try {
      return await withPostgresTransaction(pool, async client => {
        const rows = (await client.query<{ id: number; prompt_id: number; user_id: string }>(`SELECT i.id,i.prompt_id,i.user_id
          FROM mcp_secret_inputs i JOIN interaction_prompts p ON p.id=i.prompt_id AND p.user_id=i.user_id
          JOIN agent_interaction_bindings owned ON owned.prompt_id=p.id AND owned.user_id=p.user_id AND owned.session_id=p.session_id
          WHERE i.expires_at<=clock_timestamp() AND (i.status IN ('pending_choice','awaiting_secret') OR i.encrypted_payload<>'')
          ORDER BY i.id LIMIT $1 FOR UPDATE OF i,p SKIP LOCKED`, [limit])).rows
        for (const row of rows) {
          await client.query("UPDATE mcp_secret_inputs SET status='expired',encrypted_payload='',payload_nonce='',encrypted_data_key='',updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2", [row.id, row.user_id])
          await client.query("UPDATE interaction_prompts SET status='expired',resolved_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND status='active'", [row.prompt_id, row.user_id])
        }
        return rows.length
      })
    } catch { throw new ImSecretInputError() }
  }
  return { inspectSecret, applySecret: (scope: ImPreflightScope, reference: string, action: ImSecretAction, signal: AbortSignal) => applySecret(scope,reference,action,signal),
    applyNativeSecret: (scope: ImPreflightScope, reference: string, action: Exclude<ImSecretAction,{action:'value'}>, native: {promptId:number;token:string},signal:AbortSignal) => applySecret(scope,reference,action,signal,native), cleanupExpired }
}
async function failStage(client: PoolClient, row: StageRow, events: string[]): Promise<void> {
  await client.query("UPDATE mcp_secret_inputs SET status='failed',encrypted_payload='',payload_nonce='',encrypted_data_key='',consumed_event_ids=$2,updated_at=clock_timestamp() WHERE id=$1", [row.id, JSON.stringify(events)])
  const schema = { ...object(row.schema_json), resolved_result: { status: 'failed', prompt_id: row.prompt_id, option_id: null, value: null, text: '凭据字段无效，请重新发起' } }
  await client.query("UPDATE interaction_prompts SET status='resolved',resolved_at=clock_timestamp(),schema_json=$3 WHERE id=$1 AND user_id=(SELECT user_id FROM mcp_secret_inputs WHERE id=$2)", [row.prompt_id, row.id, JSON.stringify(schema)])
}
