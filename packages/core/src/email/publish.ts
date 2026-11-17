import type { EmailRecipientGroups } from '../admin/email-recipient-list.js'
import { strip } from '../shared/values.js'
import { renderSmtpDraftMessage, SmtpDeliveryFailure, type SmtpTestDelivery, type SmtpTestSettings } from './smtp-test.js'
import type { EmailPreviewDraft } from './preview.js'

export interface AdminEmailPublishDraft extends EmailPreviewDraft {
  translations?: Partial<Record<'ja-JP' | 'en-US', EmailPreviewDraft>>
}
export interface AdminEmailPublishSettings extends SmtpTestSettings { use_ssl: boolean }
export interface AdminEmailPublishSummary {
  recipient_count: number
  sent: number
  failed: number
  locale_counts: Record<keyof EmailRecipientGroups, number>
}
export interface AdminEmailDeliveryMetric { status: 'sent' | 'failed'; elapsed_ms: number; error_code?: string }

/** 按收件人语言发送；单封失败不阻断其他收件人，调用方只记录聚合结果。 */
export async function deliverAdminEmailBulk(
  recipients: EmailRecipientGroups,
  draft: AdminEmailPublishDraft,
  settings: AdminEmailPublishSettings,
  send: (delivery: SmtpTestDelivery) => Promise<void>,
  concurrency = 8,
  recordMetric?: (metric: AdminEmailDeliveryMetric) => void,
): Promise<AdminEmailPublishSummary> {
  const localeCounts = {
    'zh-CN': recipients['zh-CN'].length, 'ja-JP': recipients['ja-JP'].length, 'en-US': recipients['en-US'].length,
  }
  const jobs = (Object.entries(recipients) as [keyof EmailRecipientGroups, string[]][])
    .flatMap(([locale, emails]) => emails.map(toAddress => ({ locale, toAddress })))
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('邮件并发数配置无效')
  let next = 0
  let sent = 0
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const started = Date.now()
      let errorCode: string | undefined
      try {
        if (!settings.host) { errorCode = 'smtp_not_configured'; throw new Error('SMTP 未配置') }
        const localized = job.locale === 'zh-CN' ? draft : draft.translations?.[job.locale] ?? draft
        const content = { ...localized, template: draft.template, theme: draft.theme, palette: draft.palette }
        let message
        try { message = renderSmtpDraftMessage(content) }
        catch (error) { errorCode = 'email_template_invalid'; throw error }
        const from = settings.from_addr || ''
        if (/[\r\n]/.test(`${message.subject}${from}${job.toAddress}`)) throw new Error('邮件头含换行')
        await send({
          host: settings.host, port: settings.port, user: settings.user,
          password: settings.password, fromName: from && !from.includes('@') ? from : '咕咕',
          fromAddress: from.includes('@') ? from : settings.user, toAddress: strip(job.toAddress),
          secure: settings.use_ssl, message,
        })
        sent++
      } catch (error) {
        if (!errorCode) errorCode = error instanceof SmtpDeliveryFailure
          ? error.reason === 'tls_mismatch' ? 'smtp_tls_mismatch' : error.reason === 'tls' ? 'smtp_tls_error' : 'smtp_delivery_error'
          : 'smtp_delivery_error'
      } finally {
        try { recordMetric?.({ status: errorCode ? 'failed' : 'sent', elapsed_ms: Math.max(0, Date.now() - started), ...(errorCode ? { error_code: errorCode } : {}) }) }
        catch { /* 运维统计旁路不得影响邮件投递。 */ }
      }
    }
  })
  await Promise.all(workers)
  const recipient_count = jobs.length
  return { recipient_count, sent, failed: recipient_count - sent, locale_counts: localeCounts }
}
