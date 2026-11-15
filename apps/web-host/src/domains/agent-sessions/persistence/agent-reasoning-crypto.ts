import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const info = 'gugu-byok-envelope-v1'
const limit = 8 * 1024 * 1024

export interface ReasoningCiphertext { encryptedPayload: string; payloadNonce: string; encryptedDataKey: string; keyVersion: number; payloadDigest: string; payloadSize: number }
function masterKey(raw: string): Buffer {
  if (!raw) throw new Error('推理状态主密钥不可用')
  const base64 = Buffer.from(raw, 'base64')
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw) && base64.length === 32) return base64
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  return createHash('sha256').update(raw).digest()
}
function encrypt(key: Buffer, nonce: Buffer, input: Buffer, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  return Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()])
}
function decrypt(key: Buffer, nonce: Buffer, input: Buffer, aad: string): Buffer {
  if (nonce.length !== 12 || input.length < 16) throw new Error('推理状态密文无效')
  const cipher = createDecipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(input.subarray(-16))
  return Buffer.concat([cipher.update(input.subarray(0, -16)), cipher.final()])
}

/** Python BYOK AES-GCM 信封格式；只处理内存值，调用方不得记录返回的明文。 */
export function encryptReasoningPayload(canonicalJson: string, rawKey: string, keyVersion: number): ReasoningCiphertext {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new TypeError('推理状态密钥版本无效')
  const value = Buffer.from(canonicalJson, 'utf8')
  if (!value.length || value.length > limit) throw new TypeError('推理状态大小无效')
  const key = randomBytes(32), nonce = randomBytes(12), wrapNonce = randomBytes(12)
  const wrapped = Buffer.concat([wrapNonce, encrypt(masterKey(rawKey), wrapNonce, key, `b'${info}':${keyVersion}`)])
  return { encryptedPayload: encrypt(key, nonce, value, info).toString('base64'), payloadNonce: nonce.toString('base64'),
    encryptedDataKey: wrapped.toString('base64'), keyVersion, payloadDigest: createHash('sha256').update(value).digest('hex'), payloadSize: value.length }
}

export function decryptReasoningPayload(envelope: ReasoningCiphertext, keyForVersion: (version: number) => string): string {
  try {
    const wrapped = Buffer.from(envelope.encryptedDataKey, 'base64')
    const key = decrypt(masterKey(keyForVersion(envelope.keyVersion)), wrapped.subarray(0, 12), wrapped.subarray(12), `b'${info}':${envelope.keyVersion}`)
    const value = decrypt(key, Buffer.from(envelope.payloadNonce, 'base64'), Buffer.from(envelope.encryptedPayload, 'base64'), info)
    if (value.length > limit || value.length !== envelope.payloadSize || createHash('sha256').update(value).digest('hex') !== envelope.payloadDigest)
      throw new Error('推理状态校验失败')
    return value.toString('utf8')
  } catch { throw new Error('推理状态无法安全解密') }
}
