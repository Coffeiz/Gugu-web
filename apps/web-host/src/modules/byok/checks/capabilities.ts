import { readOwnedCredential, type OwnedCredential } from '../store.js'
import type { Kysely } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { canReuseByokKeyForDestination, BYOK_DESTINATION_MISMATCH_MESSAGE } from '@gugu/core/byok/policy'
import type { ByokMediaDimension, ByokMediaProbeTarget, ByokMediaProbeResult } from '@gugu/core/providers/media-probe'
export { createByokMediaCapabilityProbeRunner } from '@gugu/core/providers/media-probe'
export type { ByokMediaDimension, ByokMediaProbeResult } from '@gugu/core/providers/media-probe'

export interface ByokMediaProbeInput {
  provider: string; api_format: string; base_url: string; model: string; api_key: string
  credential_id?: number | null; dim: ByokMediaDimension
}

/** 复用旧凭据前验证 owner 与有效 origin；草稿探测不产生持久化副作用。 */
export function createByokMediaCapabilityProbe<DB>(db: Kysely<DB>, options: {
  enabled(): boolean
  decrypt(row: Pick<OwnedCredential, 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>): Promise<string>
  probe(target: ByokMediaProbeTarget, dim: ByokMediaDimension): Promise<Omit<ByokMediaProbeResult, 'dim'>>
}) {
  return async (rawOwner: string, input: ByokMediaProbeInput): Promise<ByokMediaProbeResult> => {
    if (!options.enabled()) throw Object.assign(new Error('用户 BYOK 未开放'), { statusCode: 403 })
    const owner = dataContext(rawOwner).ownerId
    let row: OwnedCredential | undefined
    if (input.credential_id != null) {
      row = await readOwnedCredential(db, owner, input.credential_id)
    }
    let apiKey = input.api_key
    if (!apiKey) {
      if (!row) throw Object.assign(new Error('请填写 API Key 后再检测'), { statusCode: 422 })
      const target = { provider: input.provider, api_format: input.api_format, base_url: input.base_url, model: input.model, capability: row.capability }
      if (!canReuseByokKeyForDestination(row, target))
        throw Object.assign(new Error(BYOK_DESTINATION_MISMATCH_MESSAGE), { statusCode: 422 })
      try { apiKey = await options.decrypt(row) }
      catch { throw Object.assign(new Error('凭据无法解密，请重新保存'), { statusCode: 422 }) }
    }
    if (!apiKey) throw Object.assign(new Error('请先填写 API Key 或保存后再检测'), { statusCode: 422 })
    const result = await options.probe({ provider: input.provider, apiFormat: input.api_format, baseUrl: input.base_url, model: input.model, apiKey }, input.dim)
    return { dim: input.dim, ...result }
  }
}
