import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { desktopKeyFile } from '../shared/desktop-key-file.js'
import type { McpEnvelopeCrypto } from './server-mutations.js'

/** 桌面侧的数据库与加密密钥分别存放，运行收据只保留资源 ID。 */
export function createDesktopMcpCrypto(database: string): McpEnvelopeCrypto {
  const key = desktopKeyFile(database + '.mcp-key', 'MCP 密钥无效')
  return {
    async encrypt(text) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', await key.readOrCreate(), nonce)
      const ciphertext = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()])
      return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), encryptedDataKey: '', keyVersion: 1 }
    },
    async decrypt({ ciphertext, nonce, keyVersion, encryptedDataKey }) {
      if (keyVersion !== 1 || encryptedDataKey) throw new Error('MCP 加密格式无效')
      const sealed = Buffer.from(ciphertext, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', await key.read(), Buffer.from(nonce, 'base64'))
      cipher.setAuthTag(sealed.subarray(-16))
      return Buffer.concat([cipher.update(sealed.subarray(0, -16)), cipher.final()]).toString('utf8')
    },
  }
}
