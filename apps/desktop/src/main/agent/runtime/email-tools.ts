import { desktopFileReferenceKey, droppedFileReferenceId, readDesktopTurnReferences, workspaceFileReferenceId } from '#core-source/agent/sessions/desktop-references.js'
import { createSendEmailTool, createDurableAgentEmailDelivery } from '#core-source/agent/tools/email.js'
import { createDesktopAppearanceService } from '#core-source/preferences/desktop-appearance.js'
import { normalizeThemePalette } from '#core-source/preferences/palette.js'
import { renderSmtpDraftMessage, sanitizeEmailHtml } from '#core-source/email/smtp-test.js'
import { createKyselyPreferenceDocumentStore } from '#core-source/preferences/document-store.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { CoreError, dataContext } from '#core-source/contracts/index.js'
import type { RunIdentity } from '#core-source/agent/models.js'
import { createSqliteToolConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'

type DesktopMailAccount = { id: string; email: string; version: string }
function desktopMailAccounts(value: unknown): DesktopMailAccount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && typeof item.email === 'string' && typeof item.version === 'string'
    && /^[a-f0-9]{64}$/u.test(item.version) ? [{ id: item.id, email: item.email, version: item.version }] : [])
}
function maskEmailAddress(value: string): string {
  const at = value.indexOf('@')
  if (at < 1) return '***'
  const local = [...value.slice(0, at)]
  return `${local[0]}${local.length > 2 ? '*'.repeat(Math.min(12, local.length - 2)) + local.at(-1) : '*'}${value.slice(at)}`
}

export function createDesktopEmailTool(options: {
  core: SqlDataRuntime
  ownerId: string
  enabled: boolean
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  authorize: (identity: RunIdentity) => Promise<boolean>
  authorizeWrite: Parameters<typeof createSqliteToolConfirmation>[1]
  digest: (value: unknown) => string
}) {
  const { core, ownerId, enabled, hostRequest, authorize, authorizeWrite, digest } = options
  const { db } = core
  const listMailAccounts = async (signal?: AbortSignal) => desktopMailAccounts(
    await hostRequest('agent.email.accounts', {}, signal))
  const resolveMailReferences = async (identity: RunIdentity, keys: readonly string[], signal?: AbortSignal) => {
    if (keys.length > 5 || new Set(keys).size !== keys.length) throw new CoreError('invalid_request', '邮件附件引用无效')
    const { references } = await readDesktopTurnReferences(db, identity)
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
  const emailConfirmation = core.receipts && enabled
    ? createSqliteToolConfirmation(db, authorizeWrite, 'send_email', async (tx, identity, rawInput, snapshot) => {
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput))
        throw new CoreError('invalid_request', '邮件发送参数无效')
      const input = rawInput as Record<string, unknown>
      const account = (await listMailAccounts(AbortSignal.timeout(5000)))
        .find(candidate => candidate.version === snapshot.versionsDigest)
      if (!account) throw new CoreError('conflict', '发件邮箱设置已变化，请重新发起并确认邮件')
      let recipient = typeof input.to === 'string' ? input.to.trim() : ''
      if (!recipient && typeof input.client_id === 'number' && Number.isSafeInteger(input.client_id)) {
        const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
        const { rows } = await sql<{ email: string | null }>`SELECT email FROM clients
          WHERE id=${input.client_id} AND user_id=${owner} LIMIT 1`.execute(tx)
        recipient = rows[0]?.email?.trim() ?? ''
      }
      recipient ||= account.email
      if (digest({ accountId: account.id, recipient }) !== snapshot.targetsDigest)
        throw new CoreError('conflict', '邮件收件人或发件邮箱已变化，请重新确认')
      const subject = typeof input.subject === 'string'
        ? [...input.subject.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 160).join('') : ''
      const fileRefs = Array.isArray(input.file_refs) && input.file_refs.every(value => typeof value === 'string')
        ? input.file_refs as string[] : []
      const attachments = await resolveMailReferences(identity, fileRefs)
      if (digest({ accountId: account.id, recipient, attachments: attachments.digest }) !== snapshot.targetsDigest)
        throw new CoreError('conflict', '邮件附件或收件人已变化，请重新发起确认')
      const format = input.format === 'html' ? '自定义 HTML + 纯文本'
        : input.format === 'plain' ? '纯文本' : '咕咕标准 HTML + 纯文本'
      const summary = `使用桌面邮箱 ${maskEmailAddress(account.email)} 发送${format}邮件。\n收件人：${maskEmailAddress(recipient)}\n主题：${subject}`
      if (!attachments.items.length) return summary
      const size = attachments.items.reduce((sum, item) => sum + item.size, 0)
      return `${summary}\n附件 ${attachments.items.length} 个（${(size / 1024 / 1024).toFixed(1)}MB）：${attachments.items.map(item => item.filename).join('、')}`
    }) : undefined
  const emailDelivery = emailConfirmation ? createDurableAgentEmailDelivery(core, {
    claim: emailConfirmation.claim,
    async deliver(raw, signal) {
      const result = await hostRequest('agent.email.send', raw as Record<string, unknown>, signal)
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || typeof (result as Record<string, unknown>).partial !== 'boolean') return { kind: 'unknown' }
      const partial = (result as { partial: boolean }).partial
      return { kind: 'completed', successful: !partial, mutated: true,
        value: { status: partial ? 'partial' : 'sent', message: partial ? '邮件已部分提交，请检查已发送邮件' : '邮件已提交给 SMTP' } }
    },
  }) : undefined
  const sendEmail = emailConfirmation && emailDelivery ? createSendEmailTool({
    confirmation: emailConfirmation.gate,
    async accountEmail(identity, signal) {
      if (!await authorize(identity)) return null
      return (await listMailAccounts(signal))[0]?.email ?? null
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
      const account = (await listMailAccounts(signal))[0]
      if (!account) return { error: '请先在桌面邮件页面连接邮箱账户' }
      let attachmentManifest: Awaited<ReturnType<typeof resolveMailReferences>>
      try { attachmentManifest = await resolveMailReferences(operation.identity, draft.fileRefs, signal) }
      catch (error) {
        signal.throwIfAborted()
        return { error: error instanceof CoreError ? error.message : '本机邮件附件无法读取或已变化' }
      }
      const subject = draft.subject.replace(/[\r\n]/gu, ' ')
      const displaySubject = [...subject.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 160).join('')
      const appearance = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
      const theme = draft.theme === undefined || draft.theme === 'auto'
        ? appearance.theme === 'dark' ? 'dark' : 'light' : draft.theme
      const palette = draft.palette === undefined || draft.palette === 'auto'
        ? normalizeThemePalette(appearance.palette) : draft.palette
      const plain = { subject, plain: draft.body, html: '', images: [] }
      const message = draft.format === 'template'
        ? renderSmtpDraftMessage({ ...draft, subject, title: draft.title ?? '', theme, palette })
        : draft.format === 'html'
          ? { ...plain, html: sanitizeEmailHtml(draft.html ?? '') }
          : plain
      const attachmentNames = attachmentManifest.items.map(item => item.filename)
      const attachmentSize = attachmentManifest.items.reduce((sum, item) => sum + item.size, 0)
      const delivery = {
        accountId: account.id, accountVersion: account.version, attemptId: randomUUID(),
        attachmentDigest: attachmentManifest.digest, fileRefs: attachmentManifest.ids,
        draft: { to: [draft.recipient], subject, text: message.plain,
          ...(message.html ? { html: message.html } : {}),
          inlineAttachments: message.images.map(image => ({ ...image, mimeType: 'image/png' })) },
      }
      const formatLabel = draft.format === 'html' ? '自定义 HTML + 纯文本'
        : draft.format === 'template' ? '咕咕标准 HTML + 纯文本' : '纯文本'
      let displaySummary = `使用桌面邮箱 ${maskEmailAddress(account.email)} 发送${formatLabel}邮件至 ${maskEmailAddress(draft.recipient)}，主题：${displaySubject}。正文共 ${[...draft.body].length} 个字符。`
      if (attachmentNames.length) displaySummary += `附件 ${attachmentNames.length} 个（${(attachmentSize / 1024 / 1024).toFixed(1)}MB）：${attachmentNames.join('、')}。`
      return {
        digest: digest({ accountId: account.id, recipient: draft.recipient, message, attachmentDigest: attachmentManifest.digest }),
        snapshot: { targetsDigest: digest({ accountId: account.id, recipient: draft.recipient, attachments: attachmentManifest.digest }),
          versionsDigest: account.version },
        delivery, displaySummary,
      }
    },
    send: emailDelivery.send,
    reconcile: emailDelivery.reconcile,
    attempted: emailDelivery.attempted,
    supportedFormats: ['plain', 'template', 'html'],
    supportedAttachmentInputs: ['file_refs'],
  }) : undefined
  return sendEmail
}
