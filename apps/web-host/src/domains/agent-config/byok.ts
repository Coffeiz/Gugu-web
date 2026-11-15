import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export interface ByokCredential {
  provider: string; api_format: string; base_url: string; model: string
  encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number
  max_tokens: number | null; context_tokens: number | null; thinking: string | null
  reasoning_effort: string | null; reasoning_persistence: string
  image: boolean; video: boolean; audio: boolean; image_detail: string
  web_search_enabled: boolean
}

function masterKey(raw: string): Buffer {
  const base64 = Buffer.from(raw, 'base64')
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw) && base64.length === 32) return base64
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  return createHash('sha256').update(raw).digest()
}
function decrypt(key: Buffer, nonce: Buffer, value: Buffer, aad: string): Buffer {
  if (value.length < 16) throw new Error('凭据信封无效')
  const cipher = createDecipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(value.subarray(-16))
  return Buffer.concat([cipher.update(value.subarray(0, -16)), cipher.final()])
}
function encrypt(key: Buffer, nonce: Buffer, value: Buffer, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()])
}
/** 与 Python 信封兼容；调用方负责从安全存储提供主密钥。 */
export function encryptByokEnvelope(plaintext: string, rawKey: string, keyVersion: number) {
  if (!plaintext || !rawKey || !Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new TypeError('凭据加密参数无效')
  const key = randomBytes(32), nonce = randomBytes(12), wrapNonce = randomBytes(12)
  return { ciphertext: encrypt(key, nonce, Buffer.from(plaintext), 'gugu-byok-envelope-v1').toString('base64'), nonce: nonce.toString('base64'),
    encryptedDataKey: Buffer.concat([wrapNonce, encrypt(masterKey(rawKey), wrapNonce, key, `b'gugu-byok-envelope-v1':${keyVersion}`)]).toString('base64'), keyVersion }
}
/** 兼容 Python BYOK 信封；密钥由宿主显式提供，不读取或生成用户配置。 */
export function decryptByokCredential(row: Pick<ByokCredential, 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>, keyForVersion: (version: number) => string): string {
  const raw = keyForVersion(row.key_version)
  if (!raw) throw new Error('凭据主密钥不可用')
  const wrapped = Buffer.from(row.encrypted_data_key, 'base64')
  const key = decrypt(masterKey(raw), wrapped.subarray(0, 12), wrapped.subarray(12), `b'gugu-byok-envelope-v1':${row.key_version}`)
  return decrypt(key, Buffer.from(row.nonce, 'base64'), Buffer.from(row.encrypted_value, 'base64'), 'gugu-byok-envelope-v1').toString('utf8')
}

/** 按用户查询启用的 LLM 凭据；不接受调用方提供的凭据 ID。 */
export async function readActiveLlmCredential(pool: Pick<Pool, 'query'>, ownerId: string): Promise<ByokCredential | null> {
  const result = await pool.query('SELECT provider, api_format, base_url, model, encrypted_value, nonce, encrypted_data_key, key_version, max_tokens, context_tokens, thinking, reasoning_effort, reasoning_persistence, image, video, audio, image_detail, web_search_enabled FROM user_provider_credentials WHERE user_id = $1 AND capability = $2 AND enabled IS TRUE ORDER BY id LIMIT 1', [ownerId, 'llm'])
  return (result.rows[0] as ByokCredential | undefined) ?? null
}

/** 缺少用户目的地时沿用平台配置，但绝不把用户密钥与平台地址拼接。 */
export function resolveByokLlm<T extends Record<string, unknown>>(base: T, row: ByokCredential | null, decryptValue: (row: ByokCredential) => string, defaultBaseUrl: (provider: string, format: string) => string): T {
  if (!row) return base
  const url = (row.base_url.trim() || defaultBaseUrl(row.provider, row.api_format).trim()).replace(/\/+$/, '')
  if (!url) return base
  const apiKey = decryptValue(row)
  return { ...base, provider: row.provider, api_format: row.api_format, api_key: apiKey, base_url: url,
    model: row.model || base.model, image: row.image, video: row.video, audio: row.audio, image_detail: row.image_detail, is_byok: true, web_search_enabled: row.web_search_enabled,
    ollama_api_mode: row.provider === 'ollama' && ['', 'native'].includes(row.api_format) ? 'native' : 'openai',
    ...(row.max_tokens == null ? {} : { max_tokens: row.max_tokens }), ...(row.context_tokens == null ? {} : { context_tokens: row.context_tokens }),
    thinking: row.thinking, reasoning_effort: row.reasoning_effort || '', reasoning_persistence: row.reasoning_persistence }
}
