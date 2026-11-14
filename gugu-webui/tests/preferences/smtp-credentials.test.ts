import assert from 'node:assert/strict'
import { createDecipheriv, hkdfSync } from 'node:crypto'
import test from 'node:test'
import { decryptSmtpPassword, encryptSmtpPassword } from '../../src/domains/preferences/persistence/smtp-credentials.js'

test('SMTP password storage uses Python-compatible authenticated encryption and never stores plaintext', () => {
  const secretKey = 'synthetic-smtp-test-secret'
  const password = 'synthetic-mail-password'
  const token = encryptSmtpPassword(secretKey, password)
  assert.match(token, /^gcm1:/)
  assert.equal(token.includes(password), false)
  assert.equal(encryptSmtpPassword(secretKey, ''), '')

  const raw = Buffer.from(token.slice('gcm1:'.length), 'base64')
  const iv = raw.subarray(0, 12)
  const ciphertext = raw.subarray(12, -16)
  const authTag = raw.subarray(-16)
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.alloc(0), Buffer.from('gugu-user-bot-secret-v1'), 32))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'), password)
  assert.equal(decryptSmtpPassword(secretKey, token), password)
  assert.equal(decryptSmtpPassword(secretKey, 'legacy-plaintext-password'), 'legacy-plaintext-password')
  assert.equal(decryptSmtpPassword(secretKey, 'gcm1:invalid'), 'gcm1:invalid')
})
