import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import PostalMime from 'postal-mime'
import { resolvePinnedTarget } from '../agent/providers/transport/network.js'
import { sanitizeEmailHtml } from '../email/html.js'
import { MailError, type MailTransport } from './service.js'
import type { MailAccount, MailAttachment, MailDraft, MailFolder, MailMessage, MailPage, MailRead } from './contracts.js'

const timeout = 12_000
const maxSource = 4 * 1024 * 1024
const pageSize = 30
const messageFields = { envelope: true, flags: true, internalDate: true } as const
type Fetched = Exclude<Awaited<ReturnType<ImapFlow['fetchOne']>>, false | undefined>

function summary(item: Fetched): MailMessage {
  const envelope = item.envelope
  const date = envelope?.date ?? item.internalDate
  return {
    uid: item.uid, subject: (envelope?.subject ?? '').slice(0, 998),
    from: envelope?.from?.[0]?.address ?? '', replyTo: envelope?.replyTo?.[0]?.address ?? envelope?.from?.[0]?.address ?? '',
    to: (envelope?.to ?? []).flatMap(row => row.address ? [row.address] : []).slice(0, 20),
    date: date instanceof Date ? date.toJSON() : date ?? null, seen: item.flags?.has('\\Seen') ?? false,
  }
}

function mailOptions(account: MailAccount, draft: MailDraft) {
  return {
    from: account.email, to: draft.to, subject: draft.subject, text: draft.text,
    ...(draft.html ? { html: sanitizeEmailHtml(draft.html) } : {}),
    ...(draft.attachments?.length ? { attachments: draft.attachments.map(file => ({
      filename: file.filename, content: Buffer.from(file.content), contentType: file.mimeType,
      ...(file.cid ? { cid: file.cid } : {}),
    })) } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  }
}

export function createMailTransport(): MailTransport {
  async function pinned(host: string, port: number) {
    try { return (await resolvePinnedTarget(`https://${host}:${port}`, { timeoutMs: 5000 })).target.address }
    catch { throw new MailError(400, '邮箱服务器地址不可用，请使用可公开访问的邮件服务器') }
  }

  async function imap<T>(account: MailAccount, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: await pinned(account.imapHost, 993), servername: account.imapHost, port: 993, secure: true,
      auth: { user: account.username, pass: account.password }, logger: false, disableAutoIdle: true,
      connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout,
    })
    client.on('error', () => { /* 邮件服务器错误不直接写入日志。 */ })
    const deadline = setTimeout(() => client.close(), 45_000)
    try { await client.connect(); return await work(client) }
    catch (error) {
      if (error instanceof MailError) throw error
      throw new MailError(502, 'IMAP 操作失败，请检查邮箱连接或稍后重试')
    } finally { clearTimeout(deadline); client.close() }
  }

  async function smtp(account: MailAccount) {
    return nodemailer.createTransport({
      host: await pinned(account.smtpHost, account.smtpPort),
      port: account.smtpPort, secure: account.smtpPort === 465, requireTLS: account.smtpPort === 587,
      tls: { servername: account.smtpHost }, auth: { user: account.username, pass: account.password },
      connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout, disableFileAccess: true, disableUrlAccess: true,
    })
  }

  async function folders(client: ImapFlow): Promise<MailFolder[]> {
    const list = await client.list()
    return list.filter(row => !row.flags.has('\\Noselect')).map(row => ({
      path: row.path, name: row.name, specialUse: row.specialUse ?? (row.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null),
    }))
  }

  return {
    async verify(account) {
      await imap(account, folders)
      const sender = await smtp(account)
      try { await sender.verify() }
      catch { throw new MailError(502, 'SMTP 验证失败，请检查服务器或邮箱授权码') }
      finally { sender.close() }
    },
    async execute(account, command) {
      if (command.action === 'send') {
        const source = command.replyTo
        const inReplyTo = source ? await imap(account, async client => {
          const lock = await client.getMailboxLock(source.mailbox)
          try {
            if (!client.mailbox || String(client.mailbox.uidValidity) !== source.validity)
              throw new MailError(409, '原邮件已变更，请重新打开')
            const item = await client.fetchOne(source.uid, { envelope: true }, { uid: true })
            if (!item) throw new MailError(404, '原邮件不存在')
            const id = item.envelope?.messageId
            return id && /^<[^<>\s]{1,998}>$/.test(id) ? id : undefined
          } finally { lock.release() }
        }) : undefined
        const sender = await smtp(account)
        try {
          const receipt = await sender.sendMail({ ...mailOptions(account, command.draft), inReplyTo })
          return { messageId: receipt.messageId, partial: receipt.rejected.length > 0 }
        } catch { throw new MailError(502, '发送结果未确认，请核对已发送邮件后再决定是否重试') }
        finally { sender.close() }
      }
      return imap(account, async client => {
        if (command.action === 'folders') return folders(client)
        if (command.action === 'draft') {
          const target = (await folders(client)).find(row => row.specialUse === '\\Drafts')
          if (!target) throw new MailError(409, '邮箱未提供草稿文件夹')
          const previous = command.replace
          if (previous && (previous.mailbox !== target.path || !client.capabilities.has('UIDPLUS')))
            throw new MailError(409, '该邮箱无法安全替换草稿，可以另存一份')
          const builder = nodemailer.createTransport({ streamTransport: true, buffer: true })
          const result = await builder.sendMail(mailOptions(account, command.draft))
          if (!Buffer.isBuffer(result.message)) throw new MailError(502, '草稿编码失败')
          if (!previous) {
            if (!await client.append(target.path, result.message, ['\\Draft'])) throw new MailError(502, '保存草稿失败')
            return { ok: true }
          }
          const lock = await client.getMailboxLock(target.path)
          try {
            if (!client.mailbox || String(client.mailbox.uidValidity) !== previous.validity
              || !await client.fetchOne(previous.uid, { uid: true }, { uid: true }))
              throw new MailError(409, '草稿已变更，请重新打开')
            if (!await client.append(target.path, result.message, ['\\Draft'])) throw new MailError(502, '保存草稿失败')
            if (!await client.messageDelete(previous.uid, { uid: true }))
              throw new MailError(409, '新草稿已保存，旧草稿未能移除')
            return { ok: true }
          } finally { lock.release() }
        }
        const target = command.action === 'move'
          ? (await folders(client)).find(row => row.specialUse === ({ archive: '\\Archive', trash: '\\Trash', inbox: '\\Inbox' })[command.target])
          : undefined
        const lock = await client.getMailboxLock(command.mailbox)
        try {
          if (!client.mailbox) throw new MailError(404, '邮箱文件夹不存在')
          const validity = String(client.mailbox.uidValidity)
          if (command.action === 'messages') {
            if (!client.mailbox.exists || command.before === 1) return { validity, items: [], next: null } satisfies MailPage
            const range = command.before ? `1:${command.before - 1}` : '1:*'
            const found = await client.search({ uid: range, ...(command.query ? { text: command.query } : {}) }, { uid: true })
            const ids = (found || []).filter(uid => !command.before || uid < command.before).sort((a, b) => b - a)
            const selected = ids.slice(0, pageSize)
            const items = selected.length ? (await client.fetchAll(selected, messageFields, { uid: true })).map(summary).sort((a, b) => b.uid - a.uid) : []
            return { validity, items, next: ids.length > pageSize ? selected.at(-1)! : null } satisfies MailPage
          }
          if (validity !== command.validity) throw new MailError(409, '邮件列表已变化，请刷新后重试')
          if (command.action === 'read' || command.action === 'attachment') {
            const item = await client.fetchOne(command.uid, { ...messageFields, size: true, source: { start: 0, maxLength: maxSource } }, { uid: true })
            if (!item || !item.source) throw new MailError(404, '邮件不存在')
            if ((item.size ?? 0) > maxSource) throw new MailError(409, '邮件过大，请使用原邮箱查看')
            const parsed = await PostalMime.parse(item.source)
            if (command.action === 'attachment') {
              const attachment = parsed.attachments[command.index]
              if (!attachment) throw new MailError(404, '邮件附件不存在')
              const name = attachment.filename ?? '邮件附件'
              const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 160)
              const content = attachment.content
              const bytes = typeof content === 'string' ? Buffer.from(content, 'base64')
                : Buffer.from(content instanceof ArrayBuffer ? new Uint8Array(content) : content)
              return { name: safeName || '邮件附件', data: bytes.toString('base64') } satisfies MailAttachment
            }
            return { ...summary(item), text: (parsed.text ?? '').slice(0, 100_000),
              attachments: parsed.attachments.map(row => row.filename ?? '附件').slice(0, 50) } satisfies MailRead
          }
          if (command.action === 'seen') {
            const flags = ['\\Seen']
            const changed = command.seen ? await client.messageFlagsAdd(command.uid, flags, { uid: true }) : await client.messageFlagsRemove(command.uid, flags, { uid: true })
            if (!changed) throw new MailError(404, '邮件不存在或标记失败')
          } else {
            if (!target || !(client.capabilities.has('MOVE') || client.capabilities.has('UIDPLUS'))) throw new MailError(409, '该邮箱不支持安全移动到所选文件夹')
            if (target.path === command.mailbox) throw new MailError(409, '邮件已经在目标文件夹中')
            if (!await client.messageMove(command.uid, target.path, { uid: true })) throw new MailError(502, '邮件移动失败，请刷新列表核对')
          }
          return { ok: true }
        } finally { lock.release() }
      })
    },
  }
}
