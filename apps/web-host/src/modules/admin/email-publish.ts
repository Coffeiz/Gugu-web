import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { createEmailRecipientLister } from '@gugu/core/admin/email-recipient-list'
import type { EmailRecipientQuery } from '@gugu/core/admin/email-recipient-count'
import { deliverAdminEmailBulk, type AdminEmailDeliveryMetric, type AdminEmailPublishSettings, type AdminEmailPublishSummary } from '@gugu/core/email/publish'
import type { SmtpTestDelivery } from '@gugu/core/email/smtp-test'
import type { AdminEmailPublishDraft } from '@gugu/core/email/publish'
import type { EmailRecipientGroups } from '@gugu/core/admin/email-recipient-list'
import { draft as validDraft } from './email-preview.js'

export interface AdminEmailPublishOperations {
  recipients(): Promise<EmailRecipientGroups>
  enqueue(recipients: EmailRecipientGroups, draft: AdminEmailPublishDraft): void
  close(): Promise<void>
}

export function createEmailPublishTaskLifecycle(reportFailure: () => void = () => {}) {
  const running = new Set<Promise<void>>()
  let closing = false
  return {
    enqueue(task: () => Promise<void>): void {
      if (closing) throw new Error('邮件发布任务已停止接收')
      let pending!: Promise<void>
      pending = Promise.resolve().then(task).catch(() => { reportFailure() }).finally(() => { running.delete(pending) })
      running.add(pending)
    },
    async close(): Promise<void> {
      closing = true
      while (running.size) await Promise.all([...running])
    },
  }
}

export function createAdminEmailPublishOperations(options: {
  query: EmailRecipientQuery
  readSettings(): AdminEmailPublishSettings
  send(delivery: SmtpTestDelivery): Promise<void>
  reportResult(result: AdminEmailPublishSummary): void
  recordMetric?(metric: AdminEmailDeliveryMetric): void
  reportFailure(): void
}): AdminEmailPublishOperations {
  const lifecycle = createEmailPublishTaskLifecycle(options.reportFailure)
  return {
    recipients: createEmailRecipientLister(options.query),
    enqueue(recipients, draft) {
      lifecycle.enqueue(async () => {
        const result = await deliverAdminEmailBulk(recipients, draft, options.readSettings(), options.send, 8, options.recordMetric)
        options.reportResult(result)
      })
    },
    close: () => lifecycle.close(),
  }
}

export function registerAdminEmailPublishRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  operations: AdminEmailPublishOperations
}): void {
  app.post('/api/v1/admin/email/publish', { preHandler: options.requireAdmin }, async (request, reply) => {
    const value = request.body
    if (!validDraft(value) || !value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as unknown as Record<string, unknown>).confirm !== 'boolean')
      return reply.code(422).send({ detail: '邮件发布参数无效' })
    const body = value as unknown as AdminEmailPublishDraft & { confirm: boolean }
    if (!body.confirm) return reply.code(400).send({ detail: '正式发布必须显式确认' })
    let recipients: EmailRecipientGroups
    try { recipients = await options.operations.recipients() }
    catch { return reply.code(503).send({ detail: '暂时无法读取邮件收件人' }) }
    const locale_counts = {
      'zh-CN': recipients['zh-CN'].length, 'ja-JP': recipients['ja-JP'].length, 'en-US': recipients['en-US'].length,
    }
    const recipient_count = Object.values(locale_counts).reduce((sum, count) => sum + count, 0)
    if (!recipient_count) return reply.code(400).send({ detail: '没有可发送的有效注册邮箱' })
    const { confirm: _confirm, ...draft } = body
    options.operations.enqueue(recipients, draft)
    return { ok: true, status: 'queued', recipient_count, locale_counts }
  })
  app.addHook('onClose', async () => options.operations.close())
}
