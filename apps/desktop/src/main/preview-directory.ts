import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopKeyFile } from '../../../../packages/core/src/shared/desktop-key-file.js'

/** 数据归检出目录所有，开发服务换端口后继续使用同一份库。 */
export function desktopPreviewDataDirectory(desktopRoot: string, homeDirectory: string): string {
  const checkout = createHash('sha256').update(desktopRoot).digest('hex').slice(0, 16)
  const directory = join(homeDirectory, '.gugu-desktop-preview', checkout)
  if (existsSync(join(directory, 'core.db'))) return directory
  const previousDefault = join(directory, '5176')
  return existsSync(join(previousDefault, 'core.db')) ? previousDefault : directory
}

// 浏览器预览没有系统钥匙串，密钥随预览数据目录保存。
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
