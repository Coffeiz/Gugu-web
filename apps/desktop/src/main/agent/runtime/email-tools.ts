import { desktopFileReferenceKey, droppedFileReferenceId, readDesktopTurnReferences, workspaceFileReferenceId } from '#core-source/agent/sessions/desktop-references.js'
import { createSendEmailTool, createDurableAgentEmailDelivery } from '#core-source/agent/tools/email/index.js'
import { createListMailTool } from '#core-source/agent/tools/email/list.js'
import { createDesktopAppearanceService } from '#core-source/preferences/desktop-appearance.js'
import { normalizeThemePalette } from '#core-source/preferences/palette.js'
import { renderSmtpDraftMessage, sanitizeEmailHtml, emailComposePresentation } from '#core-source/email/smtp-test.js'
import type { EmailPreviewDraft } from '#core-source/email/preview.js'
import type { Kysely } from 'kysely'
import type { Database } from '#core-source/data/schema.js'
import { createKyselyPreferenceDocumentStore } from '#core-source/preferences/document-store.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { MAX_FRAME } from '#core-source/contracts/desktop.js'
import { CoreError, dataContext } from '#core-source/contracts/index.js'
import type { Json, RunIdentity } from '#core-source/agent/models.js'
import { createSqliteToolConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'

type DesktopMailAccount = { id: string; email: string; version: string; displayName?: string; senderName?: string; receiveOnly: boolean }
function desktopMailAccounts(value: unknown): DesktopMailAccount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && typeof item.email === 'string' && typeof item.version === 'string'
    && /^[a-f0-9]{64}$/u.test(item.version) ? [{ id: item.id, email: item.email, version: item.version,
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
      senderName: typeof item.senderName === 'string' ? item.senderName : undefined,
      receiveOnly: item.receiveOnly === true }] : [])
}
function maskEmailAddress(value: string): string {
  const at = value.indexOf('@')
  if (at < 1) return '***'
  const local = [...value.slice(0, at)]
  return `${local[0]}${local.length > 2 ? '*'.repeat(Math.min(12, local.length - 2)) + local.at(-1) : '*'}${value.slice(at)}`
}

function editedReceipt(raw: unknown) {
  const draft = (raw as { draft?: { senderName?: string; to?: string[]; subject?: string } } | null)?.draft
  return draft && 'senderName' in draft ? { recipients: draft.to, subject: draft.subject } : {}
}

function emailConfirmationBody(input: Record<string, unknown>, sender: string, recipient: string,
  subject: string, attachments: readonly { filename: string; size: number }[], masked: boolean) {
  const address = (value: string) => masked ? maskEmailAddress(value) : value
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const format = input.format ?? (text(input.html) ? 'html' : 'template')
  const label = format === 'html' ? '自定义 HTML + 纯文本' : format === 'plain' ? '纯文本' : '咕咕标准模板'
  const lines = [
    `使用桌面邮箱 ${address(sender)} 发送${label}邮件。`,
    `收件人：${address(recipient)}`, `主题：${subject}`,
  ]
  if (format === 'template') {
    lines.push(`模板：${text(input.template) || 'notification'}`)
    if (text(input.title)) lines.push(`邮件横幅：${text(input.title)}`)
    if (text(input.preheader)) lines.push(`邮件摘要：${text(input.preheader)}`)
  }
  lines.push('', '正文：', text(input.body))
  if (format === 'template') {
    for (const section of Array.isArray(input.sections) ? input.sections : []) {
      lines.push('')
      if (text(section.heading)) lines.push(text(section.heading))
      lines.push(text(section.text))
    }
    for (const action of Array.isArray(input.actions) ? input.actions : [])
      lines.push(`${text(action.label)}：${text(action.url)}`)
  }
  if (attachments.length) {
    const size = attachments.reduce((sum, item) => sum + item.size, 0)
    lines.push(`附件 ${attachments.length} 个（${(size / 1024 / 1024).toFixed(1)}MB）：${attachments.map(item => item.filename).join('、')}`)
  }
  return lines.join('\n')
}

export function createDesktopEmailTool(options: {
  core: SqlDataRuntime
  ownerId: string
  enabled: boolean
  imConfirmation?: boolean
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  authorize: (identity: RunIdentity) => Promise<boolean>
  authorizeWrite: Parameters<typeof createSqliteToolConfirmation>[1]
  digest: (value: unknown) => string
}) {
  const { core, ownerId, enabled, hostRequest, authorize, authorizeWrite, digest } = options
  const { db } = core
  const listMailAccounts = async (signal?: AbortSignal) => desktopMailAccounts(
    await hostRequest('agent.email.accounts', {}, signal))
  const selectSender = async (account: string | undefined, signal?: AbortSignal) => {
    const senders = (await listMailAccounts(signal)).filter(item => !item.receiveOnly)
    return account ? senders.find(item => item.id === account) : senders.length === 1 ? senders[0] : undefined
  }
  const listMail = enabled ? createListMailTool(async (query, identity, signal) => {
    if (!await authorize(identity)) throw new CoreError('not_found', '当前会话无权读取邮箱')
    if (!await authorizeWrite(db, identity, signal)) throw new CoreError('not_found', '当前会话无权更新邮件状态')
    return await hostRequest('agent.email.list', query, signal) as Record<string, Json> & { marked_read: number }
  }) : undefined
  async function availableMailPrompt(signal?: AbortSignal) {
    if (!enabled) return ''
    const accounts = await listMailAccounts(signal)
    if (!accounts.length) return ''
    return '[可用邮箱]\n' + JSON.stringify(accounts.map(({ id, email, displayName, receiveOnly }) => ({
      account: id, email, ...(displayName ? { name: displayName } : {}), can_send: !receiveOnly,
    }))) + '\n[/可用邮箱]\n多个可发件邮箱时请指定 account，未明确发件账户时先询问。'
  }
  const resolveMailReferences = async (connection: typeof db, identity: RunIdentity, keys: readonly string[], signal?: AbortSignal) => {
    if (keys.length > 5 || new Set(keys).size !== keys.length) throw new CoreError('invalid_request', '邮件附件引用无效')
    const { references } = keys.length ? await readDesktopTurnReferences(connection, identity) : { references: [] }
    const available = new Map(references.flatMap(reference => reference?.type === 'file' && typeof reference.id === 'string'
      && (droppedFileReferenceId.test(reference.id) || workspaceFileReferenceId.test(reference.id))
      ? [[desktopFileReferenceKey(reference.id), reference.id] as const] : []))
    const ids = keys.map(key => available.get(key))
    if (ids.some(id => !id)) throw new CoreError('invalid_request', '邮件附件必须来自当前消息引用的本机文件')
    const resolvedIds = ids as string[]
    const result = await hostRequest('agent.email.attachments', { references: resolvedIds }, signal)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CoreError('storage_error', '本机邮件附件信息无效')
    const manifest = result as Record<string, unknown>
    if (typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.digest)
      || !Array.isArray(manifest.items) || manifest.items.length !== ids.length
      || manifest.items.some(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return true
        const row = item as Record<string, unknown>, size = row.size
        return typeof row.filename !== 'string' || typeof row.mimeType !== 'string'
          || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
      }))
      throw new CoreError('storage_error', '本机邮件附件信息无效')
    return { ids: resolvedIds, digest: manifest.digest, items: manifest.items as { filename: string; mimeType: string; size: number }[] }
  }
  async function templateAppearance(connection: Kysely<Database>, draft: { theme?: unknown; palette?: unknown }) {
    const appearance = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(connection, 'sqlite')).get(ownerId)
    const theme = draft.theme === 'dark' || draft.theme === 'light' ? draft.theme : appearance.theme === 'dark' ? 'dark' : 'light'
    const palette = draft.palette === undefined || draft.palette === 'auto'
      ? normalizeThemePalette(appearance.palette) : normalizeThemePalette(draft.palette)
    return { theme, palette }
  }

  const emailConfirmation = core.receipts && enabled
    ? createSqliteToolConfirmation(db, authorizeWrite, 'send_email', async (tx, identity, rawInput, snapshot) => {
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput))
        throw new CoreError('invalid_request', '邮件发送参数无效')
      const input = rawInput as Record<string, unknown>
      const accounts = (await listMailAccounts(AbortSignal.timeout(5000))).filter(candidate => !candidate.receiveOnly)
      const account = accounts.find(candidate => candidate.version === snapshot.versionsDigest)
      if (!account) throw new CoreError('conflict', '发件邮箱设置已变化，请重新发起并确认邮件')
      let recipient = typeof input.to === 'string' ? input.to.trim() : ''
      if (!recipient && typeof input.client_id === 'number' && Number.isSafeInteger(input.client_id)) {
        const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
        const { rows } = await sql<{ email: string | null }>`SELECT email FROM clients
          WHERE id=${input.client_id} AND user_id=${owner} LIMIT 1`.execute(tx)
        recipient = rows[0]?.email?.trim() ?? ''
      }
      recipient ||= account.email
      const subject = typeof input.subject === 'string'
        ? input.subject.trim().replace(/[\p{Cc}\p{Cf}]/gu, ' ') : ''
      const fileRefs = Array.isArray(input.file_refs) && input.file_refs.every(value => typeof value === 'string')
        ? input.file_refs as string[] : []
      // 确认提示在事务内创建，引用查询必须复用事务连接。
      const attachments = await resolveMailReferences(tx, identity, fileRefs, AbortSignal.timeout(5_000))
      if (digest({ accountId: account.id, recipient, attachments: attachments.digest }) !== snapshot.targetsDigest)
        throw new CoreError('conflict', '邮件附件或收件人已变化，请重新发起确认')
      const body = emailConfirmationBody(input, account.email, recipient, subject, attachments.items, Boolean(options.imConfirmation))
      if (options.imConfirmation) return body
      const text = typeof input.body === 'string' ? input.body : ''
      const format = input.format === 'plain' || input.format === 'html' ? input.format : input.html && input.format === undefined ? 'html' : 'template'
      const message = format === 'template' ? renderSmtpDraftMessage({
        ...(input as unknown as EmailPreviewDraft), subject, body: text, title: typeof input.title === 'string' ? input.title : '',
        ...await templateAppearance(tx, input),
      }) : { subject, plain: text, html: format === 'html' && typeof input.html === 'string' ? sanitizeEmailHtml(input.html) : '', images: [] }
      return { body, context: { email_compose: {
        enabled: true, canDraft: true, account: account.id, sender: account.email,
        senderName: account.senderName ?? '', recipient, subject, text, ...emailComposePresentation(format, message),
        accounts: accounts.map(item => ({ id: item.id, email: item.email, name: item.senderName ?? '' })),
        attachments: attachments.items.map(item => item.filename),
      } } }
    }) : undefined
  const emailDelivery = emailConfirmation ? createDurableAgentEmailDelivery(core, {
    claim: emailConfirmation.claim,
    async deliver(raw, signal) {
      const result = await hostRequest('agent.email.send', raw as Record<string, unknown>, signal)
      if (raw && typeof raw === 'object' && 'saveDraft' in raw && raw.saveDraft === true)
        return result && typeof result === 'object' && 'ok' in result && result.ok === true
          ? { kind: 'completed', successful: true, mutated: true, value: { status: 'draft_saved', message: '草稿已保存', ...editedReceipt(raw), ...('draftRef' in result ? { draftRef: result.draftRef } : {}) } }
          : { kind: 'unknown' }
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || typeof (result as Record<string, unknown>).partial !== 'boolean') return { kind: 'unknown' }
      const partial = (result as { partial: boolean }).partial
      return { kind: 'completed', successful: !partial, mutated: true,
        value: { status: partial ? 'partial' : 'sent', message: partial ? '邮件已部分提交，请检查已发送邮件' : '邮件已提交给 SMTP', ...editedReceipt(raw) } }
    },
  }) : undefined
  const sendEmail = emailConfirmation && emailDelivery ? createSendEmailTool({
    confirmation: emailConfirmation.gate,
    editableConfirmation: !options.imConfirmation,
    async accountEmail(identity, signal, account) {
      if (!await authorize(identity)) return null
      return (await selectSender(account, signal))?.email ?? null
    },
    async clientEmail(identity, clientId, signal) {
      signal.throwIfAborted()
      if (!await authorize(identity)) return null
      const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
      const { rows } = await sql<{ email: string | null }>`SELECT email FROM clients
        WHERE id=${clientId} AND user_id=${owner} LIMIT 1`.execute(db)
      signal.throwIfAborted()
      return rows[0] ?? null
    },
    async prepare(operation, draft, signal) {
      signal.throwIfAborted()
      if (!await authorize(operation.identity)) return { error: '当前运行无权发送邮件' }
      if (draft.filePaths.length) return { error: '桌面邮件只支持添加当前消息引用的本机文件' }
      const account = await selectSender(draft.account, signal)
      if (!account) return { error: '请指定可发件的邮箱账户，或先在邮箱页面连接账户' }
      let attachmentManifest: Awaited<ReturnType<typeof resolveMailReferences>>
      try { attachmentManifest = await resolveMailReferences(db, operation.identity, draft.fileRefs, signal) }
      catch (error) {
        signal.throwIfAborted()
        return { error: error instanceof CoreError ? error.message : '本机邮件附件无法读取或已变化' }
      }
      const subject = draft.subject.replace(/[\r\n]/gu, ' ')
      const displaySubject = subject.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      const { theme, palette } = await templateAppearance(db, draft)
      const plain = { subject, plain: draft.body, html: '', images: [] }
      const message = draft.format === 'template'
        ? renderSmtpDraftMessage({ ...draft, subject, title: draft.title ?? '', theme, palette })
        : draft.format === 'html'
          ? { ...plain, html: sanitizeEmailHtml(draft.html ?? '') }
          : plain
      const delivery = {
        accountId: account.id, accountVersion: account.version, attemptId: randomUUID(),
        ...(draft.draft ? { saveDraft: true } : {}),
        attachmentDigest: attachmentManifest.digest, fileRefs: attachmentManifest.ids,
        draft: { to: [draft.recipient, ...draft.emailEdit?.additionalRecipients ?? []].filter(Boolean), subject, text: message.plain,
          ...(draft.emailEdit ? { senderName: draft.emailEdit.senderName, recipientName: draft.emailEdit.recipientName, cc: draft.emailEdit.cc, bcc: draft.emailEdit.bcc } : {}),
          ...(message.html ? { html: message.html } : {}),
          ...(draft.format === 'template' ? { templateBrand: { theme, palette } } : {}) },
      }
      const frame = { v: 2, event: 'host_request', requestId: Number.MAX_SAFE_INTEGER,
        method: 'agent.email.send', params: delivery }
      if (Buffer.byteLength(JSON.stringify(frame)) + 1 > MAX_FRAME)
        return { error: '邮件内容超出桌面传输限制，请缩短正文或从邮箱页面发送' }
      const displaySummary = emailConfirmationBody(draft, account.email, draft.recipient, displaySubject, attachmentManifest.items, Boolean(options.imConfirmation))
      if (options.imConfirmation && !draft.draft && (draft.format === 'html' || displaySummary.length > 900))
        return { error: '这封邮件无法在 IM 中完整展示，请在桌面应用中确认发送，或先保存草稿' }
      return {
        digest: digest({ accountId: account.id, recipient: draft.recipient, message, attachmentDigest: attachmentManifest.digest }),
        snapshot: { targetsDigest: digest({ accountId: account.id, recipient: draft.recipient, attachments: attachmentManifest.digest }),
          versionsDigest: account.version },
        delivery, displaySummary, attachmentsDigest: attachmentManifest.digest, senderAccount: account.id, senderAddress: account.email,
      }
    },
    send: emailDelivery.send,
    saveDraft: emailDelivery.saveDraft,
    supportsAccounts: true,
    reconcile: emailDelivery.reconcile,
    attempted: emailDelivery.attempted,
    supportedFormats: ['plain', 'template', 'html'],
    supportedAttachmentInputs: ['file_refs'],
  }) : undefined
  return { sendEmail, listMail, availableMailPrompt, emailConfirmation }
}
