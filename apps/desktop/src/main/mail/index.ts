import { open, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { EmailAttachment } from '../../../../../packages/core/src/email/attachments.js'
import { mailCommand, mailOAuthCommand, mailStoredAccount, summarizeMailAccount, type MailAccount } from '@gugu/email/contracts'
import { createCachedMailService } from '@gugu/email/cached-service'
import { createMailService, MailError, type MailStore, type MailTransport } from '@gugu/email/service'
import { createMailTransport, type MailTransportPolicy } from '@gugu/email/transport'
import { createNodeProviderTransport, desktopTransportOptions, resolvePinnedTarget, type NodeProviderTransportOptions } from '@gugu/core/providers/node'
import { createEncryptedDesktopStore } from '../auth/store.js'
import { DesktopError } from '../core-host.js'
import type { IpcHandlers } from '../ipc/types.js'
import { emailTemplateImages, sanitizeEmailHtml } from '@gugu/core/email/smtp-test'
import { isThemePalette } from '../../../../../packages/core/src/preferences/palette.js'
import { desktopMailAttachmentDigest } from './attachments.js'
import { createDesktopMailCache } from './cache.js'
import { createDesktopMailOAuth } from './oauth.js'

type AgentAttachmentResolver = (references: readonly string[], signal?: AbortSignal) => Promise<EmailAttachment[]>

export function createDesktopMailService(
  directory: string,
  encryption: Parameters<typeof createEncryptedDesktopStore>[2],
  transport?: MailTransport,
  resolveAgentAttachments?: AgentAttachmentResolver,
  openBrowser?: (url: string) => Promise<void>,
  resolveImageProxy?: NodeProviderTransportOptions['resolveProxy'],
  resizeImage?: MailTransportPolicy['resizeImage'],
) {
  const accounts = createEncryptedDesktopStore<MailAccount[]>(directory, 'mail-accounts', encryption, value => mailStoredAccount.array().parse(value))
  const versionKeys = createEncryptedDesktopStore(directory, 'mail-version-key', encryption, value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('邮箱版本密钥无效')
    return value
  })
  let versionKey: Promise<string> | undefined
  function loadVersionKey() {
    return versionKey ??= (async () => {
      const stored = await versionKeys.read()
      if (stored) return stored
      const key = randomBytes(32).toString('hex')
      await versionKeys.write(key)
      return key
    })().catch(error => { versionKey = undefined; throw error })
  }
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
    async list() { return (await accounts.read() ?? []).map(summarizeMailAccount) },
    async get(_owner, id) { return (await accounts.read() ?? []).find(account => account.id === id) ?? null },
    put(_owner, account) { return update(items => [...items.filter(item => item.id !== account.id), account]) },
    remove(_owner, id) { return update(items => items.filter(item => item.id !== id)) },
    async claimSend(_owner, accountId, attemptId, expectedAccount) {
      const claim = mutation.then(async () => {
        const current = (await accounts.read() ?? []).find(item => item.id === accountId)
        if (!current) return false
        if (expectedAccount) {
          const key = await loadVersionKey()
          if (accountVersion(current, key) !== accountVersion(expectedAccount, key)) return false
        }
        return claimAttempt(accountId, attemptId)
      })
      mutation = claim.catch(() => {})
      return claim
    },
  }
  const outlookId = process.env.GUGU_OUTLOOK_OAUTH_CLIENT_ID?.trim()
  const gmailId = process.env.GUGU_GMAIL_OAUTH_CLIENT_ID?.trim()
  const oauth = openBrowser ? createDesktopMailOAuth({
    openBrowser,
    clients: {
      ...(outlookId ? { outlook: { id: outlookId } } : {}),
      ...(gmailId ? { gmail: { id: gmailId, secret: process.env.GUGU_GMAIL_OAUTH_CLIENT_SECRET?.trim() } } : {}),
    },
    updateCredential: (id, previous, refreshToken) => update(items => items.map(account =>
      account.id === id && account.oauth?.credentialId === previous.credentialId
        && account.oauth.refreshToken === previous.refreshToken
        ? { ...account, oauth: { ...previous, refreshToken } } : account)),
  }) : undefined
  const imageTransport = createNodeProviderTransport(desktopTransportOptions(false, resolveImageProxy))
  transport ??= createMailTransport({
    sanitizeHtml: sanitizeEmailHtml,
    resizeImage,
    requestImage: (url, signal) => imageTransport.request({
      url: url.href, method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif' }, timeoutMs: 8_000,
    }, signal),
    oauthAccessToken: oauth?.accessToken,
    async resolveAddress(host, port) {
      return (await resolvePinnedTarget(`https://${host}:${port}`, { timeoutMs: 5000 })).target.address
    },
  })
  const mailTransport = transport
  const execute = createMailService(store, mailTransport)
  const readCache = createDesktopMailCache(directory, encryption)
  const cachedMail = createCachedMailService(store, mailTransport, readCache)
  async function executeOAuth(command: import('@gugu/email/contracts').MailOAuthCommand) {
    if (command.action === 'oauthProviders') return oauth?.available() ?? []
    if (!oauth) throw new MailError(409, '请在桌面应用中连接 OAuth 邮箱')
    const previous = command.accountId ? await store.get('desktop', command.accountId) : null
    if (command.accountId && (!previous || previous.oauth?.provider !== command.provider
      || previous.email.toLowerCase() !== command.email.toLowerCase()))
      throw new MailError(409, '请使用原邮箱重新授权')
    const account = await oauth.authorize(command.provider, previous?.email ?? command.email, previous?.id)
    try {
      if (previous) {
        account.displayName = previous.displayName
        account.senderName = previous.senderName
        account.receiveOnly = previous.receiveOnly
      }
      await mailTransport.verify(account)
      await update(items => {
        if (previous && !items.some(item => item.id === previous.id && item.oauth?.credentialId === previous.oauth?.credentialId))
          throw new MailError(409, '邮箱连接已变化，请重试')
        if (!previous && items.length >= 12) throw new MailError(409, '最多可连接 12 个邮箱')
        if (!previous && items.some(item => item.email.toLowerCase() === account.email.toLowerCase()))
          throw new MailError(409, '此邮箱已经连接')
        return [...items.filter(item => item.id !== account.id), account]
      })
    } catch (error) {
      oauth.forget(account)
      throw error
    }
    oauth.forget(previous)
    if (previous) await readCache.clearAccount('desktop', previous.id)
    return summarizeMailAccount(account)
  }
  async function executeCommand(input: unknown) {
    const oauthCommand = mailOAuthCommand.safeParse(input)
    if (oauthCommand.success) return executeOAuth(oauthCommand.data)
    const parsed = mailCommand.safeParse(input)
    if (!parsed.success) return cachedMail.execute('desktop', input)
    const command = parsed.data
    const previous = (command.action === 'disconnect' || command.action === 'connect' && command.accountId)
      ? await store.get('desktop', command.accountId!) : null
    if (command.action === 'connect' && previous?.oauth)
      throw new MailError(409, '请通过原服务商重新授权')
    const result = await cachedMail.execute('desktop', command)
    oauth?.forget(previous)
    return result
  }
  const resolveAttachments: AgentAttachmentResolver = async (references, signal) => {
    if (!references.length) return []
    if (!resolveAgentAttachments) throw new DesktopError('unsupported', '本机邮件附件不可用')
    return resolveAgentAttachments(references, signal)
  }
  const accountVersion = (account: MailAccount, key: string) => createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(account.oauth ? { ...account, oauth: { ...account.oauth, refreshToken: undefined } } : account))
    .digest('hex')
  const handlers: IpcHandlers = { [DESKTOP_CHANNELS.mail]: async input => {
    try { return await executeCommand(input) }
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
      if (!stored.length) return []
      const key = await loadVersionKey()
      return stored.map(account => ({ id: account.id, email: account.email, displayName: account.displayName, senderName: account.senderName,
        receiveOnly: account.receiveOnly === true, version: accountVersion(account, key) }))
    },
    listForAgent: (input: Record<string, unknown>, signal?: AbortSignal) => cachedMail.listForAgent('desktop', input, signal),
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
      if (!['accountId,accountVersion,attachmentDigest,attemptId,draft,fileRefs', 'accountId,accountVersion,attachmentDigest,attemptId,draft,fileRefs,saveDraft'].includes(Object.keys(request).sort().join(','))
        || ('saveDraft' in request && request.saveDraft !== true)
        || typeof request.accountId !== 'string' || typeof request.accountVersion !== 'string'
        || typeof request.attachmentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(request.attachmentDigest)
        || !Array.isArray(request.fileRefs) || request.fileRefs.length > 5
        || request.fileRefs.some(id => typeof id !== 'string' || !/^(?:drop|path)-[A-Za-z0-9_-]{1,24000}$/u.test(id))
        || new Set(request.fileRefs).size !== request.fileRefs.length)
        throw new DesktopError('invalid_request', '邮件发送请求无效')
      const account = await store.get('desktop', request.accountId)
      const key = await loadVersionKey()
      if (!account || !/^[a-f0-9]{64}$/u.test(request.accountVersion)
        || accountVersion(account, key) !== request.accountVersion)
        throw new DesktopError('conflict', '发件邮箱设置已变化，请重新发起并确认邮件')
      const files = await resolveAttachments(request.fileRefs as string[], signal)
      if (desktopMailAttachmentDigest(files) !== request.attachmentDigest)
        throw new DesktopError('conflict', '本机邮件附件已变化，请重新确认')
      if (!request.draft || typeof request.draft !== 'object' || Array.isArray(request.draft))
        throw new DesktopError('invalid_request', '邮件发送请求无效')
      const draft = request.draft as Record<string, unknown>
      const draftKeys = Object.keys(draft).filter(key => !['senderName', 'recipientName', 'cc', 'bcc'].includes(key)).sort().join(',')
      if (!['subject,text,to', 'html,subject,text,to', 'html,subject,templateBrand,text,to'].includes(draftKeys)
        || 'html' in draft && typeof draft.html !== 'string')
        throw new DesktopError('invalid_request', '邮件发送请求无效')
      const inlineAttachments: (EmailAttachment & { cid: string })[] = []
      if ('templateBrand' in draft) {
        const brand = draft.templateBrand as Record<string, unknown> | null
        if (!brand || typeof brand !== 'object' || Object.keys(brand).sort().join(',') !== 'palette,theme'
          || !isThemePalette(brand.palette) || (brand.theme !== 'light' && brand.theme !== 'dark'))
          throw new DesktopError('invalid_request', '邮件模板配色无效')
        for (const { filename, cid, base64 } of emailTemplateImages(brand.theme, brand.palette))
          inlineAttachments.push({ filename, cid, mimeType: 'image/png', content: Buffer.from(base64, 'base64') })
      }
      const parsed = mailCommand.safeParse({ ...(request.saveDraft === true ? { action: 'draft' } : { action: 'send', attemptId: request.attemptId }),
        accountId: request.accountId, draft: {
          to: draft.to, subject: draft.subject, text: draft.text, senderName: draft.senderName, recipientName: draft.recipientName, cc: draft.cc, bcc: draft.bcc,
          ...(typeof draft.html === 'string' ? { html: draft.html } : {}),
          ...(files.length || inlineAttachments.length ? { attachments: [...files, ...inlineAttachments] } : {}),
        } })
      if (!parsed.success || (parsed.data.action !== 'send' && parsed.data.action !== 'draft')) throw new DesktopError('invalid_request', '邮件发送请求无效')
      signal?.throwIfAborted()
      try {
        if (parsed.data.action === 'draft') {
          const latest = await store.get('desktop', request.accountId as string)
          signal?.throwIfAborted()
          if (!latest || accountVersion(latest, key) !== request.accountVersion)
            throw new DesktopError('conflict', '草稿邮箱设置已变化')
          return execute('desktop', parsed.data)
        }
        return await execute('desktop', parsed.data,
          candidate => accountVersion(candidate, key) === request.accountVersion)
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
