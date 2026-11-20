import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { stableJson, type RunIdentity } from '@gugu/core/agent'
import type { AgentUsageConfig } from '../../../agent/run/usage.js'

type Binding = { v: 1; modelIdentity: string; accessVersion: string; usage: AgentUsageConfig }
const failure = () => new Error('IM 持久模型绑定不可用')
/** 只冻结真实选模产生的记账元数据，不含API密钥；控制收尾无需在持锁事务里重新选模。 */
export function createImRuntimeBindingStore(pool: Pick<Pool, 'query'>, secretKey: string) {
  if (!secretKey) throw failure()
  const key = Buffer.from(hkdfSync('sha256', secretKey, '', 'gugu-im-runtime-bindings-v1', 32))
  const aad = (identity: RunIdentity) => Buffer.from(JSON.stringify([identity.ownerId, identity.sessionId, identity.runId]))
  function validate(value: unknown): asserts value is Binding {
    const binding = value as Binding, usage = binding?.usage
    if (binding?.v !== 1 || !binding.modelIdentity || !/^[a-f0-9]{64}$/.test(binding.accessVersion) || !usage
      || typeof usage.byokEnabled !== 'boolean' || typeof usage.localDeployment !== 'boolean' || typeof usage.isByok !== 'boolean'
      || !usage.model || !usage.provider || usage.defaultLimit6h !== null && (!Number.isSafeInteger(usage.defaultLimit6h) || usage.defaultLimit6h < 0)) throw failure()
  }
  async function readOptional(identity: RunIdentity, query: Pick<PoolClient, 'query'> | Pick<Pool, 'query'> = pool): Promise<Binding | null> {
    try {
      const result = await query.query(`SELECT b.nonce,b.payload FROM gugu_im_runtime_bindings b
        JOIN conversation_sessions s ON s.user_id=b.user_id AND s.id=b.session_id
        WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3`, [identity.ownerId, identity.sessionId, identity.runId])
      if (result.rows.length === 0) return null
      const row = result.rows[0]
      if (result.rows.length !== 1 || !row || row.nonce.length !== 12 || row.payload.length < 16) throw failure()
      const cipher = createDecipheriv('aes-256-gcm', key, row.nonce)
      cipher.setAAD(aad(identity)); cipher.setAuthTag(row.payload.subarray(-16))
      const value: unknown = JSON.parse(Buffer.concat([cipher.update(row.payload.subarray(0, -16)), cipher.final()]).toString('utf8'))
      validate(value)
      return value
    } catch { throw failure() }
  }
  async function read(identity: RunIdentity, query?: Pick<PoolClient, 'query'>) {
    const binding = await readOptional(identity, query)
    if (!binding) throw failure()
    return binding
  }
  return { read, readOptional, async freeze(identity: RunIdentity, input: Omit<Binding, 'v'>) {
    const value: Binding = { v: 1, ...input }; validate(value)
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(identity))
    const payload = Buffer.concat([cipher.update(stableJson(value)), cipher.final(), cipher.getAuthTag()])
    await pool.query(`INSERT INTO gugu_im_runtime_bindings(user_id,session_id,run_id,nonce,payload)
      SELECT user_id,id,$3,$4,$5 FROM conversation_sessions WHERE user_id=$1 AND id=$2
      ON CONFLICT(user_id,session_id,run_id) DO NOTHING`, [identity.ownerId, identity.sessionId, identity.runId, nonce, payload])
    if (stableJson(await read(identity)) !== stableJson(value)) throw failure()
  } }
}
