import { stableJson } from '@gugu/core/agent'
import type { PoolClient } from 'pg'
import { decryptReasoningPayload, encryptReasoningPayload } from './crypto.js'

/** 模型信息及指纹由可信配置服务生成，禁止使用请求体或凭据原文。 */
export interface ReasoningIdentity {
  ownerId: string; sessionId: string; provider: string; apiFormat: string; model: string
  configDigest: string; reasoningConfigDigest: string
}
interface Row {
  version: number; state_version: number; status: string; provider: string; api_format: string; model_id: string
  reasoning_persistence: string; config_digest: string; reasoning_config_digest: string; expires_at: Date
  encrypted_payload: string; payload_nonce: string; encrypted_data_key: string; key_version: number
  payload_digest: string; payload_size: number; state_kind: string
}
function valid(identity: ReasoningIdentity): void {
  if (!identity.ownerId || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId))
    || !identity.provider || !identity.apiFormat || !identity.model
    || !/^[a-f0-9]{64}$/.test(identity.configDigest) || !/^[a-f0-9]{64}$/.test(identity.reasoningConfigDigest))
    throw new TypeError('推理状态身份无效')
}
async function owned(client: PoolClient, identity: ReasoningIdentity): Promise<void> {
  const result = await client.query('SELECT 1 FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE', [identity.ownerId, identity.sessionId])
  if (!result.rows.length) throw new Error('Agent 会话不存在')
}
async function read(client: PoolClient, identity: ReasoningIdentity): Promise<Row | undefined> {
  const result = await client.query<Row>('SELECT * FROM provider_reasoning_states WHERE user_id=$1 AND session_id=$2 FOR UPDATE', [identity.ownerId, identity.sessionId])
  return result.rows[0]
}
async function invalidate(client: PoolClient, identity: ReasoningIdentity, version: number, reason: string): Promise<void> {
  const result = await client.query(`UPDATE provider_reasoning_states SET status='invalidated', invalidated_reason=$4,
    invalidated_at=clock_timestamp(), encrypted_payload='', payload_nonce='', encrypted_data_key='', payload_size=0,
    version=version+1, updated_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2 AND version=$3`,
  [identity.ownerId, identity.sessionId, version, reason])
  if (result.rowCount !== 1) throw new Error('推理状态版本已变化')
}

/** 必须处于调用方事务；失效时清空密文并递增版本，绝不返回私有内容到日志。 */
export async function loadReasoningState(client: PoolClient, identity: ReasoningIdentity,
  keyForVersion: (version: number) => string): Promise<{
    version: number; value: unknown | null; stateKind: string | null; unavailableReason: string | null
  }> {
  valid(identity)
  await owned(client, identity)
  const row = await read(client, identity)
  if (!row) return { version: 0, value: null, stateKind: null, unavailableReason: null }
  if (row.status !== 'active') return { version: row.version, value: null, stateKind: null, unavailableReason: 'state_invalidated' }
  const expiresAt = new Date(row.expires_at).getTime()
  let reason = !Number.isFinite(expiresAt) ? 'state_corrupt' : expiresAt <= Date.now() ? 'expired'
    : row.provider !== identity.provider ? 'provider_changed' : row.api_format !== identity.apiFormat ? 'api_format_changed'
      : row.model_id !== identity.model ? 'model_changed' : row.config_digest !== identity.configDigest ? 'config_changed'
        : row.reasoning_config_digest !== identity.reasoningConfigDigest ? 'reasoning_config_changed'
          : row.reasoning_persistence !== 'continuation' ? 'mode_changed' : row.state_version !== 1 ? 'state_corrupt' : null
  let value: unknown = null
  if (!reason) {
    try {
      value = JSON.parse(decryptReasoningPayload({ encryptedPayload: row.encrypted_payload, payloadNonce: row.payload_nonce,
        encryptedDataKey: row.encrypted_data_key, keyVersion: row.key_version, payloadDigest: row.payload_digest, payloadSize: row.payload_size }, keyForVersion))
    } catch { reason = 'state_corrupt' }
  }
  if (reason) {
    await invalidate(client, identity, row.version, reason)
    return { version: row.version + 1, value: null, stateKind: null, unavailableReason: reason }
  }
  await client.query('UPDATE provider_reasoning_states SET last_used_at=clock_timestamp(), updated_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2 AND version=$3', [identity.ownerId, identity.sessionId, row.version])
  return { version: row.version, value, stateKind: row.state_kind, unavailableReason: null }
}

/** 仅接受可与 Python canonical JSON 无歧义互通的子集，其他状态明确拒绝。 */
function portable(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isSafeInteger(value)) return
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('推理状态不支持此数据类型')
  seen.add(value)
  if (Array.isArray(value)) for (const item of value) portable(item, seen)
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('推理状态不支持此数据类型')
    for (const [key, item] of Object.entries(value)) {
      if (!/^[\x20-\x7e]*$/.test(key)) throw new TypeError('推理状态字段不能跨运行时编码')
      portable(item, seen)
    }
  }
  seen.delete(value)
}

/** 只在成功历史事务中调用；expectedVersion 从对应 run 开始时读取，不从客户端获取。 */
export async function commitReasoningState(client: PoolClient, identity: ReasoningIdentity, input: {
  expectedVersion: number; runId: string; roundId: string | null; sequence: number; stateKind: string; value: unknown
}, key: string, keyVersion: number): Promise<number> {
  valid(identity)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !input.runId || input.runId.length > 128
    || !input.stateKind || input.stateKind.length > 80 || !Number.isSafeInteger(input.sequence) || input.sequence < 0
    || (input.roundId !== null && input.roundId.length > 128)) throw new TypeError('推理状态版本或元数据无效')
  await owned(client, identity)
  const previous = await read(client, identity)
  if ((previous?.version ?? 0) !== input.expectedVersion) throw new Error('推理状态版本已变化')
  portable(input.value)
  let json: string
  try { json = stableJson(input.value) } catch { throw new TypeError('推理状态内容无效') }
  if (typeof json !== 'string') throw new TypeError('推理状态内容无效')
  const sealed = encryptReasoningPayload(json, key, keyVersion)
  const values = [identity.ownerId, identity.sessionId, input.expectedVersion + 1, identity.provider, identity.apiFormat,
    identity.model, identity.configDigest, identity.reasoningConfigDigest, input.runId, input.roundId, input.sequence,
    input.stateKind, sealed.encryptedPayload, sealed.payloadNonce, sealed.encryptedDataKey, keyVersion, sealed.payloadDigest, sealed.payloadSize]
  if (!previous) {
    await client.query(`INSERT INTO provider_reasoning_states (user_id,session_id,version,state_version,status,provider,api_format,
      model_id,reasoning_persistence,config_digest,reasoning_config_digest,source_run_id,source_round_id,sequence,state_kind,
      encrypted_payload,payload_nonce,encrypted_data_key,key_version,payload_digest,payload_size,state_summary,created_at,last_used_at,expires_at,updated_at)
      VALUES ($1,$2,$3,1,'active',$4,$5,$6,'continuation',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NULL,
        clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '24 hours',clock_timestamp())`, values)
  } else {
    const result = await client.query(`UPDATE provider_reasoning_states SET version=$3,state_version=1,status='active',provider=$4,api_format=$5,
      model_id=$6,reasoning_persistence='continuation',config_digest=$7,reasoning_config_digest=$8,source_run_id=$9,source_round_id=$10,
      sequence=$11,state_kind=$12,encrypted_payload=$13,payload_nonce=$14,encrypted_data_key=$15,key_version=$16,payload_digest=$17,
      payload_size=$18,state_summary=NULL,invalidated_reason=NULL,invalidated_at=NULL,created_at=clock_timestamp(),last_used_at=clock_timestamp(),
      expires_at=clock_timestamp()+interval '24 hours',updated_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2 AND version=$19`,
    [...values, input.expectedVersion])
    if (result.rowCount !== 1) throw new Error('推理状态版本已变化')
  }
  return input.expectedVersion + 1
}

/** 显式失效受版本保护；调用方须在同一事务中提交并决定是否保留先前成功状态。 */
export async function invalidateReasoningState(client: PoolClient, identity: ReasoningIdentity, expectedVersion: number,
  reason: 'manual' | 'branch_changed' | 'provider_rejected' | 'responses_incompatible'): Promise<boolean> {
  valid(identity)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0
    || !['manual', 'branch_changed', 'provider_rejected', 'responses_incompatible'].includes(reason)) throw new TypeError('推理状态失效参数无效')
  await owned(client, identity)
  const row = await read(client, identity)
  if (!row) {
    if (expectedVersion !== 0) throw new Error('推理状态版本已变化')
    return false
  }
  if (row.version !== expectedVersion) throw new Error('推理状态版本已变化')
  if (row.status !== 'active') return false
  await invalidate(client, identity, row.version, reason)
  return true
}
