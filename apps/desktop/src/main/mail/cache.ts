import { createEncryptedDesktopStore } from '../auth/store.js'
import { createMailReadCache, type MailCacheEntry } from '@gugu/email/read-cache'

export function createDesktopMailCache(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2]) {
  const store = createEncryptedDesktopStore<MailCacheEntry[]>(directory, 'mail-read-cache', encryption, value => {
    if (!Array.isArray(value)) throw new Error('邮件缓存格式无效')
    return value
  })
  return createMailReadCache({ read: () => store.read(), write: (_owner, entries) => store.write(entries) })
}
