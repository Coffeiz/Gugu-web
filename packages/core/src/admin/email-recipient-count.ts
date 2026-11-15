import { strip } from '../shared/values.js'

type RecipientRow = { email: string | null; data_json: string | null }
export type EmailRecipientQuery = (text: string, params: unknown[]) => Promise<{ rows: RecipientRow[] }>
export const validEmail = /^[^@\p{White_Space}\u001c-\u001f]+@[^@\p{White_Space}\u001c-\u001f]+\.[^@\p{White_Space}\u001c-\u001f]+$/u

/** 只返回聚合数量，不暴露收件人地址，不触发邮件投递。 */
export function createEmailRecipientCounter(query: EmailRecipientQuery) {
  return async () => {
    const rows = await query(`SELECT u.email,p.data_json FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id
      WHERE u.is_active IS TRUE AND u.account_status='active' AND u.email_subscribed IS TRUE`, [])
    const locale_counts = { 'zh-CN':0, 'ja-JP':0, 'en-US':0 }
    for (const row of rows.rows) {
      if (!validEmail.test(strip(row.email ?? ''))) continue
      let locale: unknown
      try {
        const data: unknown = JSON.parse(row.data_json || '{}')
        locale = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string,unknown>).locale : undefined
      } catch { /* 对齐 Python：损坏的偏好不影响收件人数，使用默认语言。 */ }
      const key = locale === 'en-US' || locale === 'ja-JP' ? locale : 'zh-CN'
      locale_counts[key]++
    }
    return { count:Object.values(locale_counts).reduce((sum,value)=>sum+value,0), locale_counts }
  }
}
