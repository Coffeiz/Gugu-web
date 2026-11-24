import { createHash, createHmac } from 'node:crypto'
import type { Pool } from 'pg'
import { normalizeThemePalette } from '@gugu/core'
import { stableJson } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { EmailAttachmentError, renderSmtpDraftMessage, type SmtpTestDelivery } from '@gugu/core/email/smtp-test'
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
  sanitizeHtml?: (value: string) => string
} & ({ confirmation: Confirmation } | { automation: AgentEmailAutomationClaim })) {
  const confirmation = 'confirmation' in options ? options.confirmation : undefined
  const pathFiles = createWorkspaceFileReads(options.pool, options.storageRoot)
  const attachments = createPostgresEmailAttachmentResolver(options.pool, { storageRoot: options.storageRoot,
    async openPath(owner, path, signal) {
      signal.throwIfAborted()
      const opened = await pathFiles.openSandboxPath(owner, path)
      return { ...opened, ext: '' }
    },
  })
  const outbox = createDurableAgentEmailDelivery(options.core, {
    claim: confirmation?.claim,
    async deliver(prepared, signal) {
      const delivery = prepared as SmtpTestDelivery
      // 连接中断后 SMTP 可能已接受。上层持久尝试收据会拦截重发。
      await options.send(delivery, signal)
      return { kind: 'completed', successful: true, mutated: true, value: {
        status: 'sent', delivery: 'smtp_accepted', success: true,
        message: `邮件已提交给 SMTP（收件人：${mask(delivery.toAddress)}），不代表最终送达`,
      } }
    },
  })

  const preparation: Pick<AgentEmailPort, 'supportedFormats' | 'accountEmail' | 'clientEmail' | 'prepare'> = {
    supportedFormats: options.sanitizeHtml ? ['plain', 'template', 'html'] : ['plain', 'template'],
    async accountEmail(identity, signal) {
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
        if (!smtp.host) return { error: 'SMTP 服务器未配置' }
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
        const from = sender(smtp.from, smtp.user)
        const delivery = { host: smtp.host, port: smtp.port, user: smtp.user, password: smtp.password,
          ...from, toAddress: draft.recipient, secure: smtp.secure, message, attachments: files } satisfies SmtpTestDelivery
        const targetRefs = { session: [operation.identity.sessionId] }
        const format = { plain: '纯文本', template: '咕咕标准 HTML + 纯文本', html: '自定义 HTML + 纯文本' }[draft.format]
        const recipient = summaryText(mask(draft.recipient), 120)
        let displaySummary = `将发送${format}邮件至 ${recipient}，主题：${summaryText(draft.subject, 160)}。正文共 ${[...draft.body].length} 个字符。邮件发送不可撤回。`
        if (files.length) {
          const size = files.reduce((sum, file) => sum + file.content.byteLength, 0)
          displaySummary += `附件 ${files.length} 个（${(size / 1024 / 1024).toFixed(1)}MB）：${files.map(file => summaryText(file.filename, 30)).join('、')}。`
        }
        return {
          delivery,
          digest: digest({ recipient: draft.recipient, message, files: files.map(file => ({
            filename: file.filename, mimeType: file.mimeType, digest: createHash('sha256').update(file.content).digest('hex'),
          })) }),
          snapshot: {
            targetRefs,
            displaySummary,
            targetsDigest: digest({ recipient: draft.recipient, files: draft.filePaths }),
            versionsDigest: createHmac('sha256', options.secretKey).update(stableJson(smtp)).digest('hex'),
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
    send: outbox.send, reconcile: outbox.reconcile, attempted: outbox.attempted })
}
