import { createHash } from 'node:crypto'
import { loadRemoteMailImages, mailImageTypes, type MailImageRequest, type MailImageResize } from './remote-images.js'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import PostalMime from 'postal-mime'
import { MailError, type MailTransport } from './service.js'
import type { MailAccount, MailAttachment, MailDraft, MailFolder, MailInboxWatch, MailMessage, MailPage, MailRead } from './contracts.js'

const timeout = 12_000
const maxSource = 4 * 1024 * 1024
const pageSize = 30
const messageFields = { envelope: true, flags: true, internalDate: true, bodyStructure: true } as const
type Fetched = Exclude<Awaited<ReturnType<ImapFlow['fetchOne']>>, false | undefined>

function hasAttachments(part: NonNullable<Fetched['bodyStructure']>): boolean {
  return part.disposition?.toLowerCase() === 'attachment'
    || Boolean(part.dispositionParameters?.filename || part.parameters?.name)
    || part.childNodes?.some(hasAttachments) === true
}

function summary(item: Fetched): MailMessage {
  const envelope = item.envelope
  const date = envelope?.date ?? item.internalDate
  return {
    ...(item.bodyStructure ? { hasAttachments: hasAttachments(item.bodyStructure) } : {}),
    uid: item.uid, subject: (envelope?.subject ?? '').slice(0, 998),
    from: envelope?.from?.[0]?.address ?? '',
    ...(envelope?.from?.[0]?.name ? { fromName: envelope.from[0].name.slice(0, 200) } : {}),
    replyTo: envelope?.replyTo?.[0]?.address ?? envelope?.from?.[0]?.address ?? '',
    to: (envelope?.to ?? []).flatMap(row => row.address ? [row.address] : []).slice(0, 20),
    date: date instanceof Date ? date.toJSON() : date ?? null, seen: item.flags?.has('\\Seen') ?? false,
  }
}

function mailOptions(account: MailAccount, draft: MailDraft, sanitizeHtml: (html: string) => string) {
  const senderName = draft.senderName ?? account.senderName
  const to = draft.recipientName && draft.to.length ? [{ name: draft.recipientName, address: draft.to[0]! }, ...draft.to.slice(1)] : draft.to
  return {
    from: senderName ? { name: senderName, address: account.email } : account.email, to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, text: draft.text,
    ...(draft.html ? { html: sanitizeHtml(draft.html) } : {}),
    ...(draft.attachments?.length ? { attachments: draft.attachments.map(file => ({
      filename: file.filename, content: Buffer.from(file.content), contentType: file.mimeType,
      ...(file.cid ? { cid: file.cid } : {}),
    })) } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  }
}

export interface MailTransportPolicy {
  resolveAddress(host: string, port: number): Promise<string>
  sanitizeHtml(html: string, preserveRemoteImages?: boolean): string
  requestImage?: MailImageRequest
  resizeImage?: MailImageResize
  oauthAccessToken?(account: MailAccount): Promise<string>
}

export function createMailTransport(policy: MailTransportPolicy): MailTransport {
  async function pinned(host: string, port: number) {
    try { return await policy.resolveAddress(host, port) }
    catch { throw new MailError(400, '邮箱服务器地址不可用，请使用可公开访问的邮件服务器') }
  }

  async function accessToken(account: MailAccount) {
    if (!policy.oauthAccessToken) throw new MailError(409, '当前环境不支持邮箱授权')
    return policy.oauthAccessToken(account)
  }

  const idleConnections = new Map<string, {
    key: string; client: ImapFlow; connectedAt: number; expiry: ReturnType<typeof setTimeout>
  }>()

  function forgetImap(accountId: string) {
    const idle = idleConnections.get(accountId)
    if (!idle) return
    idleConnections.delete(accountId)
    clearTimeout(idle.expiry)
    idle.client.close()
  }

  async function newImap(account: MailAccount, watching = false) {
    const client = new ImapFlow({
      host: await pinned(account.imapHost, 993), servername: account.imapHost, port: 993, secure: true,
      auth: account.oauth ? { user: account.username, accessToken: await accessToken(account) } : { user: account.username, pass: account.password }, logger: false, disableAutoIdle: true,
      connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: watching ? 45_000 : timeout,
    })
    client.on('error', () => { /* 邮件服务器错误不直接写入日志。 */ })
    return client
  }

  async function imap<T>(account: MailAccount, work: (client: ImapFlow) => Promise<T>, reuse = false): Promise<T> {
    const key = reuse ? createHash('sha256').update(JSON.stringify(account)).digest('hex') : ''
    const idle = reuse ? idleConnections.get(account.id) : undefined
    if (idle) {
      idleConnections.delete(account.id)
      clearTimeout(idle.expiry)
    }
    let client: ImapFlow | undefined
    let connectedAt = Date.now()
    let healthy = false
    if (idle && idle.key === key && idle.client.usable && connectedAt - idle.connectedAt < 60_000) {
      try {
        await idle.client.noop()
        client = idle.client
        connectedAt = idle.connectedAt
      } catch { idle.client.close() }
    } else idle?.client.close()
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      if (!client) {
        client = await newImap(account)
        deadline = setTimeout(() => client?.close(), 45_000)
        await client.connect()
      } else deadline = setTimeout(() => client?.close(), 45_000)
      const result = await work(client)
      healthy = true
      return result
    } catch (error) {
      if (error instanceof MailError) throw error
      throw new MailError(502, 'IMAP 操作失败，请检查邮箱连接或稍后重试')
    } finally {
      clearTimeout(deadline)
      if (reuse && healthy && client?.usable && !idleConnections.has(account.id) && idleConnections.size < 12) {
        const expiry = setTimeout(() => forgetImap(account.id), 12_000)
        expiry.unref()
        idleConnections.set(account.id, { key, client, connectedAt, expiry })
      } else client?.close()
    }
  }

  // 收件箱监听使用独立连接，避免阻塞正文、列表及发送操作。
  const inboxWatches = new Map<string, { id: string; controller: AbortController }>()
  async function watchInbox(account: MailAccount, id: string, cursor?: string): Promise<MailInboxWatch> {
    if (inboxWatches.has(account.id) || inboxWatches.size >= 96)
      throw new MailError(409, '收件箱监听繁忙，请稍后重试')
    const controller = new AbortController()
    inboxWatches.set(account.id, { id, controller })
    let client: ImapFlow | undefined
    const close = () => client?.close()
    controller.signal.addEventListener('abort', close, { once: true })
    const deadline = setTimeout(() => controller.abort(), 40_000)
    try {
      client = await newImap(account, true)
      controller.signal.throwIfAborted()
      await client.connect()
      const status = await client.status('INBOX', { uidValidity: true, uidNext: true, messages: true, unseen: true })
      if (!status) throw new MailError(502, '无法读取收件箱状态')
      const next = [status.uidValidity, status.uidNext, status.messages, status.unseen].join(':')
      const idle = client.capabilities.has('IDLE')
      const unreadCount = status.unseen
      if (!idle || cursor !== next) return { cursor: next, changed: cursor !== next, idle, unreadCount }
      await client.mailboxOpen('INBOX', { readOnly: true })
      const mailbox = client.mailbox
      if (mailbox && ((status.messages !== undefined && mailbox.exists !== status.messages)
        || (mailbox.uidNext !== undefined && status.uidNext !== undefined && mailbox.uidNext !== status.uidNext)
        || (status.uidValidity !== undefined && mailbox.uidValidity !== status.uidValidity)))
        return { cursor: next, changed: true, idle, unreadCount }
      const connection = client
      return await new Promise<MailInboxWatch>((resolve, reject) => {
        const finish = (changed: boolean) => { clearTimeout(lease); resolve({ cursor: next, changed, idle, unreadCount }) }
        const fail = (error: unknown) => { clearTimeout(lease); reject(error) }
        const lease = setTimeout(() => finish(false), 25_000)
        connection.once('exists', () => finish(true))
        connection.once('expunge', () => finish(true))
        connection.once('flags', () => finish(true))
        connection.once('close', () => fail(new MailError(502, '收件箱监听连接已断开')))
        void connection.idle().catch(fail)
      })
    } catch (error) {
      if (error instanceof MailError) throw error
      throw new MailError(502, '收件箱监听失败，请稍后重试')
    } finally {
      clearTimeout(deadline)
      client?.close()
      if (inboxWatches.get(account.id)?.controller === controller) inboxWatches.delete(account.id)
    }
  }

  async function smtp(account: MailAccount) {
    return nodemailer.createTransport({
      host: await pinned(account.smtpHost, account.smtpPort),
      port: account.smtpPort, secure: account.smtpPort === 465, requireTLS: account.smtpPort === 587,
      tls: { servername: account.smtpHost },
      auth: account.oauth
        ? { type: 'OAuth2', user: account.username, accessToken: await accessToken(account) }
        : { user: account.smtpUsername ?? account.username, pass: account.smtpPassword ?? account.password },
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
    forgetImap(accountId) {
      forgetImap(accountId)
      inboxWatches.get(accountId)?.controller.abort()
    },
    async loadImages(message) {
      return message.html ? { ...message, ...await loadRemoteMailImages(message.html, policy.resolveAddress, policy.requestImage, policy.resizeImage) } : message
    },
    async verify(account) {
      await imap(account, folders)
      if (account.receiveOnly) return
      const sender = await smtp(account)
      try { await sender.verify() }
      catch { throw new MailError(502, 'SMTP 验证失败，请检查服务器或邮箱授权码') }
      finally { sender.close() }
    },
    async execute(account, command) {
      if (command.action === 'watchInbox') return watchInbox(account, command.watchId, command.cursor)
      if (command.action === 'stopInboxWatch') {
        const watch = inboxWatches.get(account.id)
        if (watch?.id === command.watchId) {
          inboxWatches.delete(account.id)
          watch.controller.abort()
        }
        return { ok: true }
      }
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
          const receipt = await sender.sendMail({ ...mailOptions(account, command.draft, policy.sanitizeHtml), inReplyTo })
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
          const result = await builder.sendMail(mailOptions(account, command.draft, policy.sanitizeHtml))
          if (!Buffer.isBuffer(result.message)) throw new MailError(502, '草稿编码失败')
          if (!previous) {
            const appended = await client.append(target.path, result.message, ['\\Draft'])
            if (!appended) throw new MailError(502, '保存草稿失败')
            return { ok: true, draftRef: {
              accountId: account.id, mailbox: target.path,
              ...(appended.uid && appended.uidValidity ? { uid: appended.uid, validity: String(appended.uidValidity) } : {}),
            } }
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
            const limit = command.limit ?? pageSize
            if (!command.before && !command.query && !command.unreadOnly) {
              const last = client.mailbox.exists
              const range = `${Math.max(1, last - limit)}:${last}`
              const rows = (await client.fetchAll(range, messageFields)).map(summary).sort((a, b) => b.uid - a.uid)
              const items = rows.slice(0, limit)
              return { validity, items, next: rows.length > limit ? items.at(-1)!.uid : null } satisfies MailPage
            }
            const range = command.before ? `1:${command.before - 1}` : '1:*'
            const found = await client.search({ uid: range, ...(command.unreadOnly ? { seen: false } : {}), ...(command.query ? command.subjectOnly ? { subject: command.query } : { text: command.query } : {}) }, { uid: true })
            const ids = (found || []).filter(uid => !command.before || uid < command.before).sort((a, b) => b - a)
            const selected = ids.slice(0, limit)
            const items = selected.length ? (await client.fetchAll(selected, messageFields, { uid: true })).map(summary).sort((a, b) => b.uid - a.uid) : []
            return { validity, items, next: ids.length > limit ? selected.at(-1)! : null } satisfies MailPage
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
            let html = parsed.html && parsed.html.length <= 160_000 ? policy.sanitizeHtml(parsed.html, true) : ''
            let inlineBudget = 512 * 1024
            const inline = new Map(parsed.attachments.filter(part => part.contentId).map(part =>
              [part.contentId!.replace(/^<|>$/g, ''), part]))
            html = html.replace(/(<img\b[^>]*?\s)src="cid:([A-Za-z0-9._-]+)"/gi, (_attribute, start: string, cid: string) => {
              const part = inline.get(cid)
              const mime = part?.mimeType.toLowerCase() ?? ''
              if (!part || !mailImageTypes.has(mime) || typeof part.content === 'string') return start
              const content = Buffer.from(new Uint8Array(part.content))
              if (content.length > inlineBudget) return start
              inlineBudget -= content.length
              return `${start}src="data:${mime};base64,${content.toString('base64')}"`
            })
            const rich = html && command.remoteImages ? await loadRemoteMailImages(html, policy.resolveAddress, policy.requestImage, policy.resizeImage)
              : html ? { html } : {}
            return { ...summary(item), text: (parsed.text ?? '').slice(0, 100_000), ...rich,
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
      }, command.action === 'folders' || command.action === 'messages' || command.action === 'read' && !command.remoteImages)
    },
  }
}
