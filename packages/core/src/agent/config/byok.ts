import { dataContext } from '../../contracts/index.js'

export interface ByokEnvelope { readonly encrypted_value: string; readonly nonce: string; readonly encrypted_data_key: string; readonly key_version: number }
export interface ByokListRow {
  id: number; provider: string; api_format: string; capability: string; base_url: string; model: string
  max_tokens: number | null; dimensions: number | null; context_tokens: number | null; thinking: string | null
  reasoning_effort: string | null; reasoning_persistence: string; web_search_enabled: boolean
  image: boolean; video: boolean; audio: boolean; image_detail: string; enabled: boolean
  last_verified_at: Date | string | null; created_at: Date | string; updated_at: Date | string
  encrypted_value: string | null; nonce: string; encrypted_data_key: string; key_version: number
}
export class ByokDisabled extends Error { readonly statusCode = 403; constructor() { super('用户 BYOK 未开放') } }

/** 密文仅传给可信的校验端口；调用方不得返回或记录该端口的解密结果。 */
export function createByokListService(ports: {
  enabled(): boolean | Promise<boolean>
  readOwned(ownerId: string): Promise<readonly ByokListRow[]>
  verifyEnvelope(envelope: ByokEnvelope): void | Promise<void>
}) {
  return async (ownerId: string) => {
    const owner = dataContext(ownerId).ownerId
    if (!await ports.enabled()) throw new ByokDisabled()
    const rows = await ports.readOwned(owner)
    let status: 'ready' | 'needs_reconfigure' = 'ready'
    try {
      for (const row of rows) if (row.encrypted_value !== null) await ports.verifyEnvelope({
        encrypted_value: row.encrypted_value, nonce: row.nonce, encrypted_data_key: row.encrypted_data_key, key_version: row.key_version,
      })
    } catch { status = 'needs_reconfigure' }
    return { enabled: true as const, status, items: rows.map(row => ({
      id: row.id, provider: row.provider, api_format: row.api_format, capability: row.capability,
      base_url: row.base_url, model: row.model, max_tokens: row.max_tokens, dimensions: row.dimensions,
      context_tokens: row.context_tokens, thinking: row.thinking, reasoning_effort: row.reasoning_effort,
      reasoning_persistence: row.reasoning_persistence, web_search_enabled: Boolean(row.web_search_enabled),
      image: row.image, video: row.video, audio: row.audio, image_detail: row.image_detail, enabled: row.enabled,
      has_value: Boolean(row.encrypted_value), last_verified_at: row.last_verified_at, created_at: row.created_at, updated_at: row.updated_at,
    })) }
  }
}
