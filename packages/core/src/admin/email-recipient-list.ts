import { strip } from '../shared/values.js'
import { validEmail, type EmailRecipientQuery } from './email-recipient-count.js'

export type EmailRecipientGroups = Record<'zh-CN' | 'ja-JP' | 'en-US', string[]>

/** 管理员批量邮件的发送快照；只从活跃且订阅的账户读取有效地址。 */
export function createEmailRecipientLister(query: EmailRecipientQuery) {
  return async (): Promise<EmailRecipientGroups> => {
    const rows = await query(`SELECT u.email,p.data_json FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
      WHERE u.is_active IS TRUE AND u.account_status='active' AND u.email_subscribed IS TRUE`, [])
    const result: EmailRecipientGroups = { 'zh-CN': [], 'ja-JP': [], 'en-US': [] }
    for (const row of rows.rows) {
      const email = strip(row.email ?? '')
      if (!validEmail.test(email)) continue
      let locale: unknown
      try {
        const value: unknown = JSON.parse(row.data_json || '{}')
        locale = value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>).locale : undefined
      } catch { /* 损坏的偏好按 Python 行为使用中文。 */ }
      result[locale === 'ja-JP' || locale === 'en-US' ? locale : 'zh-CN'].push(email)
    }
    return result
  }
}
