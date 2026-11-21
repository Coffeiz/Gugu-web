import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mailStoredAccount } from '@gugu/core/mail/contracts'
import type { MailStore } from '@gugu/core/mail/service'
import { createConfiguredByokEnvelope, resolveByokKeyFile, type ByokEnvelope } from '../byok/crypto.js'

export function createWebMailStore(env: NodeJS.ProcessEnv): MailStore {
  const root = join(dirname(resolveByokKeyFile(env)), 'mail-accounts')
  const envelope = createConfiguredByokEnvelope(env)
  const directory = (owner: string) => join(root, createHash('sha256').update(owner).digest('hex'))
  const pathFor = (owner: string, id: string) => join(directory(owner), `${id}.json`)
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  async function get(owner: string, id: string) {
    try {
      const encrypted = JSON.parse(await readFile(pathFor(owner, id), 'utf8')) as ByokEnvelope
      const payload = JSON.parse(await envelope.decrypt(encrypted))
      if (payload.owner !== owner || payload.account?.id !== id) throw new Error('邮箱凭据归属不匹配')
      return mailStoredAccount.parse(payload.account)
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }
  return {
    get,
    async list(owner) {
      let entries: string[]
      try { entries = await readdir(directory(owner)) }
      catch (error) { if (missing(error)) return []; throw error }
      const accounts = await Promise.all(entries.filter(entry => /^[\da-f-]{36}\.json$/i.test(entry))
        .map(entry => get(owner, entry.slice(0, -5))))
      return accounts.flatMap(account => {
        if (!account) return []
        const { password: _password, ...summary } = account
        return [summary]
      })
    },
    async put(owner, account) {
      const target = pathFor(owner, account.id)
      const temporary = target + '.' + randomUUID()
      const encrypted = await envelope.encrypt(JSON.stringify({ owner, account }))
      await mkdir(directory(owner), { recursive: true, mode: 0o700 })
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(JSON.stringify(encrypted)) } finally { await file.close() }
        await rename(temporary, target)
      } finally { await rm(temporary, { force: true }) }
    },
    async remove(owner, id) { await rm(pathFor(owner, id), { force: true }) },
    async claimSend(owner, accountId, attemptId) {
      const dir = join(directory(owner), 'send-receipts')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      try {
        const marker = await open(join(dir, `${accountId}.${attemptId}`), 'wx', 0o600)
        await marker.close()
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    },
  }
}
