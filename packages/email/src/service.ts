import { randomUUID } from 'node:crypto'
import { mailCommand, summarizeMailAccount, type MailRead, type MailPage, type MailInbox, type MailLocatedMessage, type MailAccount, type MailAccountSummary, type MailCommand } from './contracts.js'

export class MailError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) { super(message) }
}

export interface MailStore {
  list(owner: string): Promise<MailAccountSummary[]>
  get(owner: string, id: string): Promise<MailAccount | null>
  put(owner: string, account: MailAccount): Promise<void>
  remove(owner: string, id: string): Promise<void>
  claimSend(owner: string, accountId: string, attemptId: string, expectedAccount?: MailAccount): Promise<boolean>
}

export type MailOperation = Exclude<MailCommand, { action: 'accounts' | 'inbox' | 'connect' | 'disconnect' }>
export interface MailTransport {
  forgetImap?(accountId: string): void
  loadImages?(message: MailRead): Promise<MailRead>
  verify(account: MailAccount): Promise<void>
  execute(account: MailAccount, command: MailOperation): Promise<unknown>
}

export function createMailService(store: MailStore, transport: MailTransport) {
  return async (owner: string, input: unknown, canSend?: (account: MailAccount) => boolean) => {
    const parsed = mailCommand.safeParse(input)
    if (!parsed.success) throw new MailError(400, '邮箱操作参数无效')
    const command = parsed.data
    if (command.action === 'accounts') return store.list(owner)
    if (command.action === 'inbox') {
      const accounts = (await store.list(owner)).filter(({ id }) => !command.before || Object.hasOwn(command.before, id))
      const result: MailInbox = { items: [], unavailableAccountIds: [], next: {} }
      for (let offset = 0; offset < accounts.length; offset += 4) {
        const batch = accounts.slice(offset, offset + 4)
        const pages = await Promise.allSettled(batch.map(async ({ id }) => {
          const account = await store.get(owner, id)
          if (!account) throw new MailError(404, '邮箱账户不存在')
          const page = await transport.execute(account, {
            action: 'messages', accountId: id, mailbox: 'INBOX', query: command.query, before: command.before?.[id], subjectOnly: command.subjectOnly, unreadOnly: command.unreadOnly, limit: command.limit,
          }) as MailPage
          if (page.next != null) result.next[id] = page.next
          return page.items.map((item): MailLocatedMessage => ({
            ...item, accountId: id, mailbox: 'INBOX', validity: page.validity,
          }))
        }))
        for (const [index, page] of pages.entries()) {
          if (page.status === 'fulfilled') result.items.push(...page.value)
          else result.unavailableAccountIds.push(batch[index]!.id)
        }
      }
      result.items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')
        || a.accountId.localeCompare(b.accountId) || b.uid - a.uid)
      return result
    }
    if (command.action === 'connect') {
      const accounts = await store.list(owner)
      if (command.accountId && !accounts.some(account => account.id === command.accountId))
        throw new MailError(404, '邮箱账户不存在')
      if (!command.accountId && accounts.length >= 12) throw new MailError(409, '最多可连接 12 个邮箱')
      const previous = command.accountId ? await store.get(owner, command.accountId) : null
      if (command.accountId && !previous) throw new MailError(404, '邮箱账户不存在')
      const account = { ...command.account, id: command.accountId ?? randomUUID() }
      if (!account.password) {
        if (!previous || previous.oauth || previous.email !== account.email || previous.username !== account.username || previous.imapHost !== account.imapHost)
          throw new MailError(400, '请填写邮箱授权码')
        account.password = previous.password
      }
      if (account.smtpUsername && !account.smtpPassword && previous?.smtpPassword
        && previous.email === account.email && previous.smtpUsername === account.smtpUsername && previous.smtpHost === account.smtpHost)
        account.smtpPassword = previous.smtpPassword
      if (account.smtpUsername && !account.smtpPassword) throw new MailError(400, '请填写 SMTP 授权码')
      if (!account.receiveOnly && !account.smtpHost) throw new MailError(400, '请填写 SMTP 服务器')
      if (account.receiveOnly) {
        delete account.smtpUsername
        delete account.smtpPassword
        delete account.senderName
        account.smtpHost = ''
      }
      await transport.verify(account)
      await store.put(owner, account)
      transport.forgetImap?.(account.id)
      return summarizeMailAccount(account)
    }
    const account = await store.get(owner, command.accountId)
    if (!account) throw new MailError(404, '邮箱账户不存在')
    if (command.action === 'disconnect') { await store.remove(owner, account.id); transport.forgetImap?.(account.id); return { ok: true } }
    if ((command.action === 'send' || command.action === 'draft') && canSend && !canSend(account))
      throw new MailError(409, '发件邮箱设置已变化，请重新发起并确认邮件')
    if (command.action === 'send') {
      if (account.receiveOnly) throw new MailError(409, '该邮箱仅接收邮件')
      if (!command.draft.to.length) throw new MailError(400, '请填写收件人')
      if (!await store.claimSend(owner, account.id, command.attemptId, account))
        throw new MailError(409, '此发送请求已处理或结果待确认，请先查看已发送邮件')
    }
    return transport.execute(account, command)
  }
}
