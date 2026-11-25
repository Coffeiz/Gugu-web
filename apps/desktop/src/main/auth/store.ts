import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { safeStorage } from 'electron'
import { remoteServerOrigin } from '@gugu/auth/client'
import { remoteSessionSchema, type RemoteSession } from '@gugu/auth/contracts'
import { DesktopError } from '../core-host.js'

type Encryption = Pick<typeof safeStorage, 'isAsyncEncryptionAvailable' | 'decryptStringAsync' | 'encryptStringAsync'>

export function createEncryptedDesktopStore<T>(directory: string, filename: string, encryption: Encryption, parse: (value: unknown) => T) {
  const path = join(directory, filename)
  const storageError = () => new DesktopError('credential_store', '无法访问系统凭据存储，请重试')

  async function write(value: T) {
    const pending = path + '.' + randomUUID()
    let created = false
    try {
      if (!await encryption.isAsyncEncryptionAvailable()) throw storageError()
      const encrypted = await encryption.encryptStringAsync(JSON.stringify(value))
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

  // 读取可能触发系统密钥轮换，轮换写入和显式保存共享同一队列。
  let pending: Promise<unknown> = Promise.resolve()
  function enqueue<R>(task: () => Promise<R>): Promise<R> {
    const result = pending.then(task)
    pending = result.catch(() => {})
    return result
  }

  return {
    read: () => enqueue(async (): Promise<T | null> => {
      let encrypted: Buffer
      try { encrypted = await readFile(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw storageError()
      }
      try {
        if (!await encryption.isAsyncEncryptionAvailable()) throw storageError()
        const { result, shouldReEncrypt } = await encryption.decryptStringAsync(encrypted)
        const value = parse(JSON.parse(result))
        if (shouldReEncrypt) await write(value)
        return value
      } catch {
        throw storageError()
      }
    }),
    write: (value: T) => enqueue(() => write(value)),
    clear: () => enqueue(async () => {
      try { await rm(path, { force: true }) } catch { throw storageError() }
    }),
  }
}

export function createRemoteSessionStore(directory: string, encryption: Encryption) {
  return createEncryptedDesktopStore<RemoteSession>(directory, 'remote-session', encryption, value => {
    const session = remoteSessionSchema.parse(value)
    if (remoteServerOrigin(session.origin) !== session.origin) throw new Error('远程账号地址无效')
    return session
  })
}
