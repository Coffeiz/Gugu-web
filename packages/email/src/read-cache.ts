import type { MailRead } from './contracts.js'

export interface MailCacheEntry { accountId: string; key: string; expiresAt: number; message: MailRead }
const lifetime = 7 * 24 * 60 * 60 * 1000

export function mailSnippet(message: MailRead): string {
  return message.text.replace(/&(?:zwnj|zwj|nbsp);|[\u200B-\u200D\uFEFF]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function createMailReadCache(store: {
  read(owner: string): Promise<MailCacheEntry[] | null>
  write(owner: string, entries: MailCacheEntry[]): Promise<void>
}) {
  let queue = Promise.resolve()
  function update(owner: string, change: (entries: MailCacheEntry[]) => MailCacheEntry[]) {
    const job = queue.then(async () => {
      const entries = await store.read(owner) ?? []
      const next = change(entries.filter(entry => entry.expiresAt > Date.now()))
      let remaining = 20_000_000
      await store.write(owner, next.filter(entry => {
        const size = Buffer.byteLength(JSON.stringify(entry))
        if (size > remaining) return false
        remaining -= size
        return true
      }))
    })
    queue = job.catch(() => {})
    return queue
  }
  async function entries(owner: string) {
    await queue
    const now = Date.now()
    return (await store.read(owner).catch(() => null) ?? []).filter(entry => entry.expiresAt > now)
  }
  return {
    async get(owner: string, key: string) {
      return (await entries(owner)).find(entry => entry.key === key)?.message
    },
    async snippets(owner: string) {
      return new Map((await entries(owner)).map(({ key, message }) => [
        key, mailSnippet(message),
      ]))
    },
    put(owner: string, accountId: string, key: string, message: MailRead) {
      return update(owner, entries => [{ accountId, key, message, expiresAt: Date.now() + lifetime },
        ...entries.filter(entry => entry.key !== key)].slice(0, 32))
    },
    clearAccount(owner: string, accountId: string) {
      return update(owner, entries => entries.filter(entry => entry.accountId !== accountId))
    },
  }
}
