import { createHash } from 'node:crypto'
import { mailCommand, type MailAccount, type MailInbox, type MailLocatedMessage, type MailPage, type MailRead } from './contracts.js'
import { createMailService, MailError, type MailStore, type MailTransport } from './service.js'
import { mailSnippet, type createMailReadCache } from './read-cache.js'

export function createCachedMailService(store: MailStore, transport: MailTransport, cache: ReturnType<typeof createMailReadCache>) {
  const execute = createMailService(store, transport)
  const accountVersion = (account: MailAccount) => JSON.stringify(account.oauth
    ? { ...account, oauth: { ...account.oauth, refreshToken: undefined } } : account)

  function messageCacheKey(account: MailAccount, mailbox: string, validity: string, uid: number) {
    return createHash('sha256').update(JSON.stringify([4, account, mailbox, validity, uid])).digest('hex')
  }

  async function executeCommand(owner: string, input: unknown, canSend?: (account: MailAccount) => boolean) {
    const parsed = mailCommand.safeParse(input)
    if (!parsed.success) return execute(owner, input)
    const command = parsed.data
    if (command.action === 'read') {
      const account = await store.get(owner, command.accountId)
      if (!account) throw new MailError(404, '邮箱账户不存在')
      const key = messageCacheKey(account, command.mailbox, command.validity, command.uid)
      const cached = await cache.get(owner, key)
      if (cached && (!command.remoteImages || cached.unavailableImages === 0)) return cached
      const message = cached && command.remoteImages && transport.loadImages
        ? await transport.loadImages(cached)
        : await execute(owner, command) as MailRead
      const current = await store.get(owner, command.accountId)
      if (current && accountVersion(account) === accountVersion(current)
        && (!cached || command.remoteImages && (message.unavailableImages ?? Infinity) < (cached.unavailableImages ?? Infinity)))
        await cache.put(owner, command.accountId, key, message)
      return cached?.unavailableImages !== undefined && command.remoteImages
        && (message.unavailableImages ?? Infinity) > cached.unavailableImages ? cached : message
    }
    if (command.action === 'messages' || command.action === 'inbox') {
      const [result, snippets] = await Promise.all([execute(owner, command), cache.snippets(owner)])
      if (!snippets.size) return result
      if (command.action === 'messages') {
        const page = result as MailPage
        const account = await store.get(owner, command.accountId)
        if (account) for (const item of page.items) {
          const snippet = snippets.get(messageCacheKey(account, command.mailbox, page.validity, item.uid))
          if (snippet) item.snippet = snippet
        }
      } else {
        const inbox = result as MailInbox
        const ids = [...new Set(inbox.items.map(item => item.accountId))]
        const accounts = new Map(await Promise.all(ids.map(async id => [id, await store.get(owner, id)] as const)))
        for (const item of inbox.items) {
          const account = accounts.get(item.accountId)
          if (!account) continue
          const snippet = snippets.get(messageCacheKey(account, item.mailbox, item.validity, item.uid))
          if (snippet) item.snippet = snippet
        }
      }
      return result
    }
    const result = await execute(owner, command, canSend)
    if (command.action === 'disconnect' || command.action === 'connect' && command.accountId)
      await cache.clearAccount(owner, command.accountId!)
    return result
  }

  return { execute: executeCommand,
    async listForAgent(owner: string, input: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const { account, query, limit = 10 } = input
      if (typeof account !== 'string' || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50
        || (query !== undefined && (typeof query !== 'string' || !query.trim() || query.length > 120)))
        throw new MailError(400, '邮箱查询参数无效')
      const options = { query, limit, subjectOnly: true }
      let items: MailLocatedMessage[]
      let unavailable: string[] = []
      if (account === 'all') {
        const page = await execute(owner, { action: 'inbox', ...options }) as MailInbox
        items = page.items
        unavailable = page.unavailableAccountIds
      } else {
        const page = await execute(owner, { action: 'messages', accountId: account, mailbox: 'INBOX', ...options }) as MailPage
        items = page.items.map(item => ({ ...item, accountId: account, mailbox: 'INBOX', validity: page.validity }))
      }
      const returned = items.slice(0, limit)
      let markedRead = 0
      let markReadFailed = 0
      for (const item of returned) {
        signal?.throwIfAborted()
        const { accountId, mailbox, validity, uid } = item
        const target = { accountId, mailbox, validity, uid }
        if (!item.seen) {
          try {
            await execute(owner, { action: 'seen', ...target, seen: true })
            item.seen = true
            markedRead++
          } catch (error) {
            if (!(error instanceof MailError)) throw error
            markReadFailed++
          }
        }
        signal?.throwIfAborted()
        try {
          const message = await executeCommand(owner, { action: 'read', ...target }) as MailRead
          item.snippet = mailSnippet(message)
        } catch (error) {
          // 正文不可获取时仍保留邮件摘要及真实的已读处理结果。
          if (!(error instanceof MailError)) throw error
        }
      }
      signal?.throwIfAborted()
      return { items: returned.map(item => ({ account: item.accountId, subject: item.subject.slice(0, 240),
        from: item.from.slice(0, 320), from_name: item.fromName?.slice(0, 160) ?? '', date: item.date, seen: item.seen, ...(item.snippet ? { snippet: item.snippet } : {}) })),
        unavailable_accounts: unavailable, marked_read: markedRead, mark_read_failed: markReadFailed }
    },
  }
}
