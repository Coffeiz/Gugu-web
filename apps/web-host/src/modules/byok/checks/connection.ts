import { readOwnedCredential, type OwnedCredential } from '../store.js'
import type { Kysely } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { canReuseByokKeyForDestination, BYOK_DESTINATION_MISMATCH_MESSAGE } from '@gugu/core/byok/policy'

import type { CredentialProbeInput } from '@gugu/core/byok/credential-probe'
export { createByokCredentialTestProbe } from '@gugu/core/byok/credential-probe'

export interface CredentialTestPreviewInput {
  provider: string
  capability: 'deep_research' | 'similar_image_search' | 'embedding' | 'llm' | 'speech_to_text'
  value?: string
  api_format?: string
  base_url?: string
  model?: string
  dimensions?: number | null
  credential_id?: number | null
}

export interface CredentialTestPreviewOptions {
  enabled: () => boolean
  decrypt: (row: Pick<OwnedCredential, 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>) => Promise<string>
  probe: (input: CredentialProbeInput) => Promise<{ ok: boolean; status?: number; detail: string; message?: string }>
}

function probeResponse(capability: CredentialTestPreviewInput['capability'], result: Awaited<ReturnType<CredentialTestPreviewOptions['probe']>>) {
  const genericModel = capability === 'llm' || capability === 'speech_to_text'
  const message = result.message ?? (genericModel
    ? result.ok ? '模型连接正常' : result.status ? `模型连接失败（HTTP ${result.status}）` : result.detail
    : result.detail)
  return { ok: result.ok, ...(result.status === undefined ? {} : { status: result.status }), message }
}

const canUseKeylessEmbedding = (input: CredentialTestPreviewInput): boolean =>
  input.capability === 'embedding' && (input.provider === 'local' ||
    (input.provider === 'ollama' && !((input.base_url ?? '').includes('ollama.com'))))

/** 按 Python test-preview 契约验证草稿，所有读取按认证 owner 限定且不写入。 */
export function createCredentialTestPreview<DB>(db: Kysely<DB>, options: CredentialTestPreviewOptions) {
  return async (ownerId: string, input: CredentialTestPreviewInput) => {
    if (!options.enabled()) throw Object.assign(new Error('用户 BYOK 未开放'), { statusCode: 403 })
    if (input.provider === '__server_default__')
      return { ok: false, status: 0, message: '服务器默认配置不支持用户侧测试' }

    const apiFormat = input.api_format ?? ''
    const baseUrl = input.base_url ?? ''
    const model = input.model ?? ''
    const suppliedKey = input.value ?? ''
    const owner = dataContext(ownerId).ownerId
    let row: OwnedCredential | undefined
    if (!suppliedKey && input.credential_id != null) {
      row = await readOwnedCredential(db, owner, input.credential_id)
    }

    let apiKey = suppliedKey
    if (!apiKey && canUseKeylessEmbedding(input)) {
      apiKey = ''
    } else if (!apiKey) {
      if (!row) return { ok: false, status: 0, message: '请填写 API Key 后再测试' }
      const target = { provider: input.provider, api_format: apiFormat, base_url: baseUrl, model,
        capability: row.capability }
      if (!canReuseByokKeyForDestination(row, target))
        return { ok: false, status: 0, message: BYOK_DESTINATION_MISMATCH_MESSAGE }
      try { apiKey = await options.decrypt(row) }
      catch { throw Object.assign(new Error('凭据无法解密，请重新保存'), { statusCode: 422 }) }
    }

    if (input.capability === 'embedding' && (!baseUrl || !model))
      return { ok: false, status: 0, message: 'Embedding 测试需要填写 Base URL 和模型名' }

    const result = await options.probe({ provider: input.provider, capability: input.capability,
      apiFormat, baseUrl, model, ...(input.dimensions == null ? {} : { dimensions: input.dimensions }), apiKey })
    return probeResponse(input.capability, result)
  }
}

/** 测试已保存凭据：先 owner 限定读取并解密，再进行一次不写库的能力探测。 */
export function createCredentialSavedTest<DB>(db: Kysely<DB>, options: CredentialTestPreviewOptions) {
  return async (ownerId: string, credentialId: number) => {
    if (!options.enabled()) throw Object.assign(new Error('用户 BYOK 未开放'), { statusCode: 403 })
    const owner = dataContext(ownerId).ownerId
    const row = await readOwnedCredential(db, owner, credentialId, true)
    let apiKey: string
    try { apiKey = await options.decrypt(row) }
    catch { throw Object.assign(new Error('凭据无法解密，请重新保存'), { statusCode: 422 }) }

    if (row.capability === 'embedding' && (!row.base_url || !row.model))
      return { ok: false, status: 0, message: '请先填写 Base URL 和模型名再测试' }
    if (row.capability !== 'llm' && row.capability !== 'speech_to_text' && row.capability !== 'embedding'
        && row.capability !== 'deep_research' && row.capability !== 'similar_image_search')
      return { ok: true, status: 'stored', message: '凭据已保存且可正常解密' }

    const probe = await options.probe({ provider: row.provider, capability: row.capability,
      apiFormat: row.api_format ?? '', baseUrl: row.base_url ?? '', model: row.model ?? '',
      ...(row.dimensions == null ? {} : { dimensions: row.dimensions }), apiKey })
    return probeResponse(row.capability, probe)
  }
}
