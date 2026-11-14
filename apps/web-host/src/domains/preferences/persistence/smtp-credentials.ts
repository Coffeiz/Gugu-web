import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const hkdfInfo = Buffer.from('gugu-user-bot-secret-v1', 'utf8')
const encryptedPrefix = 'gcm1:'

/** 与 Python EncryptedString 共用 HKDF-SHA256 + AES-256-GCM 存储格式。 */
export function encryptSmtpPassword(secretKey: string, password: string): string {
  if (!password) return ''
  if (password.startsWith(encryptedPrefix)) return password
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), hkdfInfo, 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return encryptedPrefix + Buffer.concat([iv, ciphertext]).toString('base64')
}

/** 与 Python EncryptedString 兼容：旧明文和无法解密的值按原样交还调用方。 */
export function decryptSmtpPassword(secretKey: string, value: string): string {
  if (!value || !value.startsWith(encryptedPrefix)) return value
  try {
    const key = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), hkdfInfo, 32))
    const raw = Buffer.from(value.slice(encryptedPrefix.length), 'base64')
    if (raw.length < 28) return value
    const iv = raw.subarray(0, 12)
    const ciphertext = raw.subarray(12, -16)
    const authTag = raw.subarray(-16)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return value
  }
}
