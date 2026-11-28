import type { MailCommand, MailDraft } from '@gugu/email/contracts'
import type { createWebMailRuntime } from '../../mail/runtime.js'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { CoreError, normalizeThemePalette } from '@gugu/core'
import { stableJson } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { EmailAttachmentError, renderSmtpDraftMessage, emailComposePresentation, type SmtpTestDelivery } from '@gugu/core/email/smtp-test'
import { createDurableAgentEmailDelivery, createSendEmailTool, type AgentEmailAutomationClaim, type AgentEmailPort } from '@gugu/core/tools'
import { createWorkspaceFileReads } from '../../workspaces/files.js'
import {
  createPostgresEmailAttachmentResolver, preferences, readEmailProfile, sender, smtpSettings,
  type SmtpFallback,
} from '../../scheduled-tasks/delivery/email.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type Confirmation = Pick<Parameters<typeof createDurableAgentEmailDelivery>[1], 'claim'> & {
  gate: AgentEmailPort['confirmation']
}

function mask(address: string) {
  const at = address.indexOf('@')
  const local = [...address.slice(0, at)]
  return (local.length <= 2 ? local.join('') : local[0] + '*'.repeat(local.length - 2) + local.at(-1)) + address.slice(at)
}

function summaryText(value: string, limit: number) {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, limit).join('')
}

/** Web 邮件准备复用现有账号 SMTP、附件限定与模板渲染。 */
export function createWebAgentEmailTool(options: {
  core: SqlDataRuntime
  pool: Pick<Pool, 'query'>
  secretKey: string
  globalSmtp: SmtpFallback
  storageRoot: string
  send(delivery: SmtpTestDelivery, signal: AbortSignal): Promise<void>
  showConfirmationAddresses?: boolean
  mail?: ReturnType<typeof createWebMailRuntime>
  sanitizeHtml?: (value: string) => string
} & ({ confirmation: Confirmation } | { automation: AgentEmailAutomationClaim })) {
  const confirmation = 'confirmation' in options ? options.confirmation : undefined
  const pathFiles = createWorkspaceFileReads(options.pool, options.storageRoot)
  const attachments = createPostgresEmailAttachmentResolver(options.pool, { storageRoot: options.storageRoot,
    async openPath(owner, path, signal) {
      signal.throwIfAborted()
      try {
        const opened = await pathFiles.openSandboxPath(owner, path)
        return { ...opened, ext: '' }
      } catch (error) {
        if (error instanceof CoreError && error.code === 'not_found') return null
        throw error
      }
    },
  })
  type MailboxDelivery = { kind: 'mailbox'; owner: string; version: string; command: Extract<MailCommand, { action: 'send' | 'draft' }> }
  const version = (account: unknown) => createHmac('sha256', options.secretKey).update(stableJson(account)).digest('hex')
  const outbox = createDurableAgentEmailDelivery(options.core, {
    claim: confirmation?.claim,
    async deliver(prepared, signal) {
      const mailbox = prepared as MailboxDelivery
      if (mailbox.kind === 'mailbox' && options.mail) {
        signal.throwIfAborted()
        const outcome = await options.mail.execute(mailbox.owner, mailbox.command, account => version(account) === mailbox.version)
        const saved = mailbox.command.action === 'draft'
        const result = outcome as { ok?: boolean; partial?: boolean; draftRef?: unknown }
        if (saved ? result?.ok !== true : typeof result?.partial !== 'boolean') return { kind: 'unknown' }
        return { kind: 'completed', successful: !result.partial, mutated: true, value: {
          status: saved ? 'draft_saved' : result.partial ? 'partial' : 'sent',
          message: saved ? '草稿已保存' : result.partial ? '邮件已部分提交' : '邮件已提交给 SMTP',
          recipients: mailbox.command.draft.to, subject: mailbox.command.draft.subject,
          ...(saved && result.draftRef ? { draftRef: result.draftRef } : {}),
        } }
      }
      const delivery = prepared as SmtpTestDelivery
      // 连接中断后 SMTP 可能已接受。上层持久尝试收据会拦截重发。
      await options.send(delivery, signal)
      return { kind: 'completed', successful: true, mutated: true, value: {
        status: 'sent', delivery: 'smtp_accepted', success: true,
        ...(delivery.toName !== undefined ? { recipients: [delivery.toAddress, ...delivery.additionalRecipients ?? []], subject: delivery.message.subject } : {}),
        message: `邮件已提交给 SMTP（收件人：${mask(delivery.toAddress)}），不代表最终送达`,
      } }
    },
  })

  const preparation: Pick<AgentEmailPort, 'supportedFormats' | 'accountEmail' | 'clientEmail' | 'prepare'> = {
    supportedFormats: options.sanitizeHtml ? ['plain', 'template', 'html'] : ['plain', 'template'],
    async accountEmail(identity, signal, id) {
      if (id) return (await options.mail?.store.get(identity.ownerId, id))?.email ?? null
      const profile = await readEmailProfile(options.pool, identity.ownerId)
      signal.throwIfAborted()
      return profile?.ownerEmail ?? null
    },
    async clientEmail(identity, id, signal) {
      const result = await options.pool.query<{ email: string | null }>(
        'SELECT email FROM clients WHERE id=$1 AND user_id=$2', [id, identity.ownerId],
      )
      signal.throwIfAborted()
      return result.rows[0] ?? null
    },
    async prepare(operation, draft, signal) {
      const profile = await readEmailProfile(options.pool, operation.identity.ownerId)
      signal.throwIfAborted()
      if (!profile) return { error: '当前用户不存在' }
      if (draft.format === 'html' && !options.sanitizeHtml) return { error: '当前邮件端口不支持自定义 HTML' }

      try {
        const files = await attachments(operation.identity.ownerId, { filePaths: draft.filePaths, generated: [] })
        signal.throwIfAborted()
        const smtp = smtpSettings(profile, options.globalSmtp, options.secretKey)
        const mailStore = options.mail?.store
        const accounts = (await mailStore?.list(operation.identity.ownerId) ?? []).filter(item => !item.receiveOnly)
        const from = sender(smtp.from, smtp.user)
        const accountId = draft.account ?? accounts.find(item => item.email === from.fromAddress)?.id ?? (!smtp.host ? accounts[0]?.id : undefined)
        const account = accountId ? await mailStore?.get(operation.identity.ownerId, accountId) : null
        if (accountId && (!account || account.receiveOnly)) return { error: '发件邮箱不可用' }
        if (!smtp.host && !account) return { error: '请连接发件邮箱或配置 SMTP' }
        if (draft.draft && !account) return { error: '保存草稿需要选择已连接的邮箱' }
        const prefs = preferences(profile.preferences)
        const theme = draft.theme === undefined || draft.theme === 'auto'
          ? prefs.theme === 'dark' ? 'dark' : 'light' : draft.theme
        const palette = draft.palette === undefined || draft.palette === 'auto'
          ? normalizeThemePalette(prefs.palette) : draft.palette
        const plain = { subject: draft.subject, plain: draft.body, html: '', images: [] }
        const message = draft.format === 'template'
          ? renderSmtpDraftMessage({ ...draft, title: draft.title ?? '', theme, palette })
          : draft.format === 'html'
            ? { ...plain, html: options.sanitizeHtml!(draft.html ?? '') }
            : plain
        const smtpDelivery = { host: smtp.host, port: smtp.port, user: smtp.user, password: smtp.password,
          ...from, ...(draft.emailEdit ? { fromName: draft.emailEdit.senderName, toName: draft.emailEdit.recipientName, additionalRecipients: draft.emailEdit.additionalRecipients,
            cc: draft.emailEdit.cc, bcc: draft.emailEdit.bcc } : {}), toAddress: draft.recipient, secure: smtp.secure, message, attachments: files } satisfies SmtpTestDelivery
        const accountVersion = account ? version(account) : version(smtp)
        const mailDraft: MailDraft = {
          to: [draft.recipient, ...draft.emailEdit?.additionalRecipients ?? []].filter(Boolean), subject: message.subject, text: message.plain,
          ...(message.html ? { html: message.html } : {}),
          ...(draft.emailEdit ? { senderName: draft.emailEdit.senderName, recipientName: draft.emailEdit.recipientName, cc: draft.emailEdit.cc, bcc: draft.emailEdit.bcc } : {}),
          attachments: [...files, ...message.images.map(image => ({
            filename: image.filename, cid: image.cid, mimeType: 'image/png', content: Buffer.from(image.base64, 'base64'),
          }))],
        }
        const delivery = account ? {
          kind: 'mailbox', owner: operation.identity.ownerId, version: accountVersion,
          command: draft.draft ? { action: 'draft', accountId: account.id, draft: mailDraft }
            : { action: 'send', accountId: account.id, draft: mailDraft, attemptId: randomUUID() },
        } satisfies MailboxDelivery : smtpDelivery
        const targetRefs = { session: [operation.identity.sessionId] }
        const format = { plain: '纯文本', template: '咕咕标准 HTML + 纯文本', html: '自定义 HTML + 纯文本' }[draft.format]
        const recipient = options.showConfirmationAddresses ? draft.recipient : summaryText(mask(draft.recipient), 120)
        const senderLine = options.showConfirmationAddresses ? `发件人：${account?.email ?? from.fromAddress}。\n` : ''
        let displaySummary = `${senderLine}将发送${format}邮件至 ${recipient}，主题：${summaryText(draft.subject, 160)}。正文共 ${[...draft.body].length} 个字符。邮件发送不可撤回。`
        if (files.length) {
          const size = files.reduce((sum, file) => sum + file.content.byteLength, 0)
          displaySummary += `附件 ${files.length} 个（${(size / 1024 / 1024).toFixed(1)}MB）：${files.map(file => summaryText(file.filename, 30)).join('、')}。`
        }
        return {
          delivery, senderAccount: account?.id, senderAddress: account?.email ?? from.fromAddress, attachmentsDigest: digest(files.map(file => ({
            filename: file.filename, mimeType: file.mimeType, digest: createHash('sha256').update(file.content).digest('hex'),
          }))),
          digest: digest({ ...(account ? { accountId: account.id } : {}), recipient: draft.recipient, message, files: files.map(file => ({
            filename: file.filename, mimeType: file.mimeType, digest: createHash('sha256').update(file.content).digest('hex'),
          })) }),
          snapshot: {
            targetRefs,
            displaySummary,
            ...(options.showConfirmationAddresses ? { emailCompose: {
              enabled: true, canDraft: accounts.length > 0, account: account?.id,
              sender: account?.email ?? from.fromAddress, senderName: account?.senderName ?? from.fromName,
              accounts: accounts.map(item => ({ id: item.id, email: item.email, name: item.senderName ?? '' })), recipient: draft.recipient, subject: draft.subject, text: draft.format === 'template' ? draft.body : message.plain,
              ...emailComposePresentation(draft.format, message),
              attachments: files.map(file => file.filename),
            } } : {}),
            targetsDigest: digest({ recipient: draft.recipient, files: draft.filePaths }),
            versionsDigest: accountVersion,
          },
        }
      } catch (error) {
        signal.throwIfAborted()
        return { error: error instanceof EmailAttachmentError ? error.message : '邮件内容或 SMTP 配置无效' }
      }
    },
  }
  if ('automation' in options) {
    const claim = options.automation
    return createSendEmailTool({ ...preparation, reconcile: outbox.reconcile,
      sendAutomated: (operation, prepared, signal) => outbox.sendAutomated(operation, prepared, signal, claim) })
  }
  return createSendEmailTool({ ...preparation, confirmation: options.confirmation.gate,
    editableConfirmation: options.showConfirmationAddresses, supportsAccounts: Boolean(options.mail),
    ...(options.mail ? { saveDraft: outbox.saveDraft } : {}), send: outbox.send, reconcile: outbox.reconcile, attempted: outbox.attempted })
}
