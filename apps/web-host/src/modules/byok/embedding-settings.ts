import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../adapters/owner-context.js'

export type EmbeddingCredentialEnvelope = { encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number }

/** 只读取当前 owner 启用的 Embedding BYOK；gate 与密钥解密由 Host 注入。 */
export function createPostgresAgentEmbeddingSettingsResolver(pool: Pick<Pool, 'query'>, options: {
  enabled(): boolean | Promise<boolean>
  decrypt(row: EmbeddingCredentialEnvelope): Promise<string>
}) {
  return async (ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null> => {
    signal?.throwIfAborted()
    if (!await options.enabled()) return null
    signal?.throwIfAborted()
    const owner = normalizeOwnerId(ownerId)
    const result = await pool.query(`SELECT provider,base_url,model,dimensions,encrypted_value,nonce,encrypted_data_key,key_version
      FROM user_provider_credentials WHERE user_id=$1 AND capability='embedding' AND enabled IS TRUE ORDER BY id LIMIT 1`, [owner])
    signal?.throwIfAborted()
    const row = result.rows[0] as (EmbeddingCredentialEnvelope & { provider?: unknown; base_url?: unknown; model?: unknown; dimensions?: unknown }) | undefined
    if (!row || typeof row.provider !== 'string' || typeof row.base_url !== 'string' || typeof row.model !== 'string'
      || !row.base_url.trim() || !row.model.trim()) return null
    const dimensions = row.dimensions == null ? 0 : Number(row.dimensions)
    if (!Number.isSafeInteger(dimensions) || dimensions < 0 || dimensions > 65_536) return null
    const apiKey = await options.decrypt(row)
    signal?.throwIfAborted()
    if (!await options.enabled()) return null
    signal?.throwIfAborted()
    const allowLocal = ['local', 'ollama'].includes(row.provider.trim().toLowerCase())
    return { provider: row.provider, baseUrl: row.base_url, model: row.model, apiKey, dimensions, allowLocal }
  }
}
