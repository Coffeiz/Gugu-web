import { createHmac } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { ByokCredential } from './byok.js'

/** 在调用方的 repeatable-read 事务读取所有启用 LLM 凭据，兼容 Python 按 id 选择第一条。 */
export async function readPostgresLlmCredentialSnapshot(client: PoolClient, ownerId: string, versionSecret: string): Promise<{ credential: ByokCredential | null; credentialVersion: string }> {
  if (!ownerId || !versionSecret) throw new Error('凭据快照身份无效')
  const result = await client.query(`SELECT id,provider,api_format,base_url,model,encrypted_value,nonce,encrypted_data_key,key_version,
      max_tokens,context_tokens,thinking,reasoning_effort,reasoning_persistence,image,video,audio,image_detail,web_search_enabled
    FROM user_provider_credentials WHERE user_id=$1 AND capability='llm' AND enabled IS TRUE ORDER BY id`, [ownerId])
  // 使用密钥化摘要检测数据库记录的任意变化，不依赖可被写入方遗漏的 updated_at；不暴露密文或服务地址。
  const credentialVersion = createHmac('sha256', versionSecret).update(JSON.stringify(['agent-credential-v1', ownerId, result.rows])).digest('hex')
  return { credential: (result.rows[0] as ByokCredential | undefined) ?? null, credentialVersion }
}
