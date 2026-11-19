import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { safeStorage } from 'electron'
import { remoteServerOrigin } from '@gugu/core/auth/client'
import { remoteSessionSchema, type RemoteSession } from '@gugu/core/auth/contracts'
import { DesktopError } from '../core-host.js'

type Encryption = Pick<typeof safeStorage, 'isAsyncEncryptionAvailable' | 'decryptStringAsync' | 'encryptStringAsync'>

export function createRemoteSessionStore(directory: string, encryption: Encryption) {
  const path = join(directory, 'remote-session')
  const storageError = () => new DesktopError('credential_store', '无法访问系统凭据存储，请重试')

  async function write(session: RemoteSession) {
    const pending = path + '.' + randomUUID()
    let created = false
    try {
      if (!await encryption.isAsyncEncryptionAvailable()) throw storageError()
      const encrypted = await encryption.encryptStringAsync(JSON.stringify(session))
      const file = await open(pending, 'wx', 0o600)
      created = true
      try { await file.writeFile(encrypted) } finally { await file.close() }
      await rename(pending, path)
    } catch {
      throw storageError()
    } finally {
      if (created) await rm(pending, { force: true }).catch(() => {})
    }
  }

  return {
    async read(): Promise<RemoteSession | null> {
      let encrypted: Buffer
      try { encrypted = await readFile(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw storageError()
      }
      try {
        if (!await encryption.isAsyncEncryptionAvailable()) throw storageError()
        const { result, shouldReEncrypt } = await encryption.decryptStringAsync(encrypted)
        const session = remoteSessionSchema.parse(JSON.parse(result))
        if (remoteServerOrigin(session.origin) !== session.origin) throw storageError()
        if (shouldReEncrypt) await write(session)
        return session
      } catch {
        throw storageError()
      }
    },
    write,
    async clear(): Promise<void> {
      try { await rm(path, { force: true }) } catch { throw storageError() }
    },
  }
}
