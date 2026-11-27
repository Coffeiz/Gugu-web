import { watch } from 'vue'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import type { MailFolder, MailInbox, MailLocatedMessage, MailPage, MailRead } from '@gugu/email/contracts'

const foldersByAccount = new Map<string, MailFolder[]>()
const listPages = new Map<string, MailPage | MailInbox>()
const readMessages = new Map<string, MailRead>()

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value!)
}

export function getMailFolders(account: string) { return foldersByAccount.get(account) }
export function rememberMailFolders(account: string, folders: MailFolder[]) { remember(foldersByAccount, account, folders, 24) }

export function getMailList(key: string) { return listPages.get(key) }
export function rememberMailList(key: string, page: MailPage | MailInbox) { remember(listPages, key, page, 24) }
export function getReadMail(key: string) { return readMessages.get(key) }
export function rememberReadMail(key: string, message: MailRead) { remember(readMessages, key, message, 32) }

export function rememberMailSeen(reference: MailLocatedMessage, seen: boolean) {
  const { accountId, mailbox, validity, uid } = reference
  const cached = readMessages.get(JSON.stringify([accountId, mailbox, validity, uid]))
  if (cached) cached.seen = seen
  for (const [key, page] of listPages) {
    if ('unavailableAccountIds' in page) {
      const item = page.items.find(item =>
        item.accountId === accountId && item.mailbox === mailbox && item.validity === validity && item.uid === uid)
      if (item) item.seen = seen
    } else {
      // 单邮箱列表的账号和文件夹在缓存键中，UID 只在该范围内有效。
      const [, cachedAccount, cachedMailbox] = JSON.parse(key)
      if (cachedAccount !== accountId || cachedMailbox !== mailbox || page.validity !== validity) continue
      const item = page.items.find(item => item.uid === uid)
      if (item) item.seen = seen
    }
  }
}

export function clearMailViewCache() {
  foldersByAccount.clear()
  listPages.clear()
  readMessages.clear()
}

watch(accountBoundaryEpoch, clearMailViewCache, { flush: 'sync' })
