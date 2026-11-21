import { open, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { EmailAttachment } from '../../../../../packages/core/src/email/attachments.js'
import { mailCommand, mailStoredAccount, type MailAccount } from '@gugu/core/mail/contracts'
import { createMailService, MailError, type MailStore, type MailTransport } from '@gugu/core/mail/service'
import { createMailTransport } from '@gugu/core/mail/transport'
import { createEncryptedDesktopStore } from '../auth/store.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'
import { sanitizeEmailHtml } from '@gugu/core/email/smtp-test'
import { personalSmtpId, type createDesktopPersonalSmtp } from './personal-smtp.js'
import { desktopMailAttachmentDigest } from './attachments.js'

type AgentAttachmentResolver = (references: readonly string[], signal?: AbortSignal) => Promise<EmailAttachment[]>

export function createDesktopMailService(
  directory: string,
  encryption: Parameters<typeof createEncryptedDesktopStore>[2],
  transport: MailTransport = createMailTransport(),
  resolveAgentAttachments?: AgentAttachmentResolver,
  personalSmtp?: ReturnType<typeof createDesktopPersonalSmtp>,
) {
  const accounts = createEncryptedDesktopStore<MailAccount[]>(directory, 'mail-accounts', encryption, value => mailStoredAccount.array().parse(value))
  const versionKey = randomBytes(32)
  const version = (value: unknown) => createHmac('sha256', versionKey).update(JSON.stringify(value)).digest('hex')
  let mutation: Promise<unknown> = Promise.resolve()
  function update(change: (items: MailAccount[]) => MailAccount[]) {
    const write = mutation.then(async () => accounts.write(change(await accounts.read() ?? [])))
    mutation = write.catch(() => {})
    return write
  }
  async function claimAttempt(accountId: string, attemptId: string) {
    const dir = join(directory, 'mail-send-receipts')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      const marker = await open(join(dir, `${accountId}.${attemptId}`), 'wx', 0o600)
      await marker.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }
  const store: MailStore = {
    async list() { return (await accounts.read() ?? []).map(({ password: _password, ...summary }) => summary) },
    async get(_owner, id) { return (await accounts.read() ?? []).find(account => account.id === id) ?? null },
    put(_owner, account) { return update(items => [...items.filter(item => item.id !== account.id), account]) },
    remove(_owner, id) { return update(items => items.filter(item => item.id !== id)) },
    async claimSend(_owner, accountId, attemptId, expectedAccount) {
      const claim = mutation.then(async () => {
        const current = (await accounts.read() ?? []).find(item => item.id === accountId)
        if (!current || expectedAccount && accountVersion(current) !== accountVersion(expectedAccount)) return false
        return claimAttempt(accountId, attemptId)
      })
      mutation = claim.catch(() => {})
      return claim
    },
  }
  const execute = createMailService(store, transport)
  const resolveAttachments: AgentAttachmentResolver = async (references, signal) => {
    if (!references.length) return []
    if (!resolveAgentAttachments) throw new DesktopError('unsupported', '本机邮件附件不可用')
    return resolveAgentAttachments(references, signal)
  }
  const accountVersion = (account: MailAccount) => version(account)
  const handlers: IpcHandlers = { [DESKTOP_CHANNELS.mail]: async input => {
    try { return await execute('desktop', input) }
    catch (error) {
      if (error instanceof DesktopError) throw error
      if (error instanceof MailError) {
        const code = ({ 400: 'invalid_request', 404: 'not_found', 409: 'conflict', 502: 'unsupported' } as const)[error.status]
        throw new DesktopError(code, error.message)
      }
      throw new DesktopError('unsupported', '邮箱服务暂不可用，请稍后重试')
    }
  } }
  return {
    handlers,
    async listAccounts() {
      const stored = await accounts.read() ?? []
      const items = stored.map(account => {
        const { password: _password, ...summary } = account
        return { ...summary, version: accountVersion(account) }
      })
      const smtp = await personalSmtp?.read()
      return smtp?.enabled ? [{ id: personalSmtpId, email: smtp.fromAddr.includes('@') ? smtp.fromAddr : smtp.user, version: version(smtp) }, ...items] : items
    },
    async inspectAgentAttachments(input: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DesktopError('invalid_request', '邮件附件引用无效')
      const request = input as Record<string, unknown>
      if (Object.keys(request).sort().join(',') !== 'references' || !Array.isArray(request.references)
        || request.references.length > 5 || request.references.some(id => typeof id !== 'string' || !/^(?:drop|path)-[A-Za-z0-9_-]{1,24000}$/u.test(id)))
        throw new DesktopError('invalid_request', '邮件附件引用无效')
      try {
        const files = await resolveAttachments(request.references as string[], signal)
        signal?.throwIfAborted()
        return {
          digest: desktopMailAttachmentDigest(files),
          items: files.map(file => ({ filename: file.filename, mimeType: file.mimeType, size: file.content.byteLength })),
        }
      } catch (error) {
        if (error instanceof DesktopError) throw error
        throw new DesktopError('invalid_request', '本机邮件附件无法读取或超过大小限制')
      }
    },
    async sendForAgent(input: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DesktopError('invalid_request', '邮件发送请求无效')
      const request = input as Record<string, unknown>
      if (Object.keys(request).sort().join(',') !== 'accountId,accountVersion,attachmentDigest,attemptId,draft,fileRefs'
        || typeof request.accountId !== 'string' || typeof request.accountVersion !== 'string'
        || typeof request.attachmentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(request.attachmentDigest)
        || !Array.isArray(request.fileRefs) || request.fileRefs.length > 5
        || request.fileRefs.some(id => typeof id !== 'string' || !/^(?:drop|path)-[A-Za-z0-9_-]{1,24000}$/u.test(id))
        || new Set(request.fileRefs).size !== request.fileRefs.length)
        throw new DesktopError('invalid_request', '邮件发送请求无效')
      const personal = request.accountId === personalSmtpId ? await personalSmtp?.read() : null
      const account = personal?.enabled ? personal : await store.get('desktop', request.accountId)
      if (!account || !/^[a-f0-9]{64}$/u.test(request.accountVersion)
        || version(account) !== request.accountVersion)
        throw new DesktopError('conflict', '发件邮箱设置已变化，请重新发起并确认邮件')
      const files = await resolveAttachments(request.fileRefs as string[], signal)
      if (desktopMailAttachmentDigest(files) !== request.attachmentDigest)
        throw new DesktopError('conflict', '本机邮件附件已变化，请重新确认')
      if (!request.draft || typeof request.draft !== 'object' || Array.isArray(request.draft))
        throw new DesktopError('invalid_request', '邮件发送请求无效')
      const draft = request.draft as Record<string, unknown>
      const draftKeys = Object.keys(draft).sort().join(',')
      if ((draftKeys !== 'inlineAttachments,subject,text,to' && draftKeys !== 'html,inlineAttachments,subject,text,to')
        || !Array.isArray(draft.inlineAttachments) || draft.inlineAttachments.length > 2
        || 'html' in draft && typeof draft.html !== 'string'
        || draft.inlineAttachments.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
        throw new DesktopError('invalid_request', '邮件发送请求无效')
      const inlineCids = new Set<string>()
      const inlineAttachments = draft.inlineAttachments.map(value => {
        const item = value as Record<string, unknown>
        if (Object.keys(item).sort().join(',') !== 'base64,cid,filename,mimeType'
          || typeof item.base64 !== 'string' || item.base64.length > 1_400_000
          || typeof item.filename !== 'string' || typeof item.cid !== 'string' || typeof item.mimeType !== 'string'
          || item.mimeType !== 'image/png'
          || !(['gugu-logo-mark', 'gugu-logo-wordmark'] as const).includes(item.cid as 'gugu-logo-mark' | 'gugu-logo-wordmark')
          || item.filename !== (item.cid === 'gugu-logo-mark' ? 'logo-mark.png' : 'logo-wordmark.png')
          || inlineCids.has(item.cid))
          throw new DesktopError('invalid_request', '邮件内嵌图片无效')
        inlineCids.add(item.cid)
        const content = Buffer.from(item.base64, 'base64')
        if (!content.length || content.length > 1_000_000 || content.toString('base64') !== item.base64)
          throw new DesktopError('invalid_request', '邮件内嵌图片无效')
        return { filename: item.filename, cid: item.cid, mimeType: item.mimeType, content }
      })
      const parsed = mailCommand.safeParse({ action: 'send', accountId: request.accountId,
        attemptId: request.attemptId, draft: {
          to: draft.to, subject: draft.subject, text: draft.text,
          ...(typeof draft.html === 'string' ? { html: draft.html } : {}),
          ...(files.length || inlineAttachments.length ? { attachments: [...files, ...inlineAttachments] } : {}),
        } })
      if (!parsed.success || parsed.data.action !== 'send') throw new DesktopError('invalid_request', '邮件发送请求无效')
      signal?.throwIfAborted()
      if (personal?.enabled && personalSmtp) {
        const latest = await personalSmtp.read()
        if (!latest?.enabled || version(latest) !== request.accountVersion)
          throw new DesktopError('conflict', '发件邮箱设置已变化，请重新发起并确认邮件')
        const { to, subject, text, html, attachments } = parsed.data.draft
        if (to.length !== 1) throw new DesktopError('invalid_request', '请填写一个收件人')
        if (!await claimAttempt(personalSmtpId, parsed.data.attemptId))
          throw new DesktopError('conflict', '此发送请求已处理或结果待确认')
        try {
          await personalSmtp.deliver({ host: personal.host, port: personal.port, secure: personal.useSsl,
            user: personal.user, password: personal.password, fromAddress: personal.fromAddr.includes('@') ? personal.fromAddr : personal.user,
            fromName: personal.fromAddr && !personal.fromAddr.includes('@') ? personal.fromAddr : '咕咕',
            toAddress: to[0]!, message: { subject, plain: text, html: html ? sanitizeEmailHtml(html) : '', images: [] }, attachments }, signal)
          return { partial: false }
        } catch {
          throw new DesktopError('unsupported', '发送结果未确认，请核对邮件后再决定是否重试')
        }
      }
      try {
        return await execute('desktop', parsed.data,
          candidate => accountVersion(candidate) === request.accountVersion)
      }
      catch (error) {
        if (error instanceof MailError) {
          const code = ({ 400: 'invalid_request', 404: 'not_found', 409: 'conflict', 502: 'unsupported' } as const)[error.status]
          throw new DesktopError(code, error.message)
        }
        throw error
      }
    },
  }
}

export function mailHandlers(directory: string, encryption: Parameters<typeof createEncryptedDesktopStore>[2]): IpcHandlers {
  return createDesktopMailService(directory, encryption).handlers
}
