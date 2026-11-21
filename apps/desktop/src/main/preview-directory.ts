import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopKeyFile } from '../../../../packages/core/src/shared/desktop-key-file.js'

/** 同一检出目录并行运行多个 Vite 预览时，为每个端口保留独立 Core 数据库。 */
export function desktopPreviewDataDirectory(desktopRoot: string, homeDirectory: string, port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new RangeError('桌面预览端口无效')
  const checkout = createHash('sha256').update(desktopRoot).digest('hex').slice(0, 16)
  return join(homeDirectory, '.gugu-desktop-preview', checkout, String(port))
}


// 浏览器预览没有系统钥匙串。密钥仅保存在当前检出目录和端口的本机预览目录。
export function createDesktopPreviewEncryption(directory: string) {
  const keyFile = desktopKeyFile(join(directory, 'preview.key'), '桌面预览密钥无效')
  let key: ReturnType<typeof keyFile.readOrCreate> | undefined
  function readKey() {
    return key ??= keyFile.readOrCreate(async () => { await mkdir(directory, { recursive: true, mode: 0o700 }) })
      .catch(error => { key = undefined; throw error })
  }
  return {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', await readKey(), nonce)
      return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    async decryptStringAsync(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', await (key ?? keyFile.read()), value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(-16))
      const result = Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8')
      return { result, shouldReEncrypt: false }
    },
  }
}
