import type { Pool } from 'pg'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { createVoiceAvailabilityReader, type VoiceAvailabilitySettings } from '@gugu/core/agent/config/voice-availability'
import { adapterFor, dashscopeAsrServiceForModel } from '@gugu/core/providers'

type Envelope = { encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number }
type Credential = Envelope & { provider: string; api_format: string; base_url: string; model: string }

export function createPostgresVoiceAvailabilityReader(pool: Pick<Pool, 'query'>, options: {
  enabled(): boolean | Promise<boolean>
  readBaseSettings(): VoiceAvailabilitySettings
  decrypt(envelope: Envelope): Promise<string>
}) {
  const available = createVoiceAvailabilityReader(async ownerId => {
    const base = options.readBaseSettings()
    if (!await options.enabled()) return base
    const result = await pool.query<Credential>(`SELECT provider,api_format,base_url,model,encrypted_value,nonce,encrypted_data_key,key_version
      FROM user_provider_credentials WHERE user_id=$1 AND capability='speech_to_text' AND enabled IS TRUE ORDER BY id LIMIT 1`, [ownerId])
    const row = result.rows[0]
    if (!row) return base
    // Python resolves/decrypts the active credential before checking whether its model is supported.
    await options.decrypt(row)
    let baseUrl = row.base_url.trim()
    if (!baseUrl) {
      try {
        const config = { provider: row.provider, api_format: row.api_format || undefined, model: row.model || '' }
        baseUrl = adapterFor(config).baseUrl(config).trim()
      } catch { baseUrl = '' }
    }
    if (!baseUrl) return base
    const model = row.model.trim() || base.model || ''
    const apiFormat = row.api_format.trim().toLowerCase() || base.api_format || 'openai'
    return {
      model,
      api_format: apiFormat,
      ...(apiFormat === 'dashscope' ? { dashscope_service: dashscopeAsrServiceForModel(model) } : {}),
    }
  })
  return { available }
}

export interface VoiceAvailabilityOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  available(ownerId: string): Promise<boolean>
}

export function registerVoiceAvailabilityRoute(app: FastifyInstance, options: VoiceAvailabilityOptions): void {
  app.get('/api/v1/agent/voice-availability', { preHandler: options.requireUser }, async request => ({
    available: await options.available(options.ownerIdFromRequest(request)),
  }))
}
