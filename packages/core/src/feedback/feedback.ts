import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { strip } from '../shared/values.js'

export const normalizeFeedbackContent = strip

export class FeedbackValidationError extends Error {}

export interface FeedbackStore {
  submit(ownerId: string, username: string, category: string, content: string): Promise<void>
  list(page: number, pageSize: number, category: string): Promise<{ total: number; items: unknown[] }>
}

function feedbackTime(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`).toISOString()
}

export function createFeedbackService(store: FeedbackStore) {
  return {
    ...store,
    async submit(ownerId: string, username: string, category: string, content: string): Promise<void> {
      if (!['bug', 'suggestion', 'other'].includes(category)) throw new FeedbackValidationError('无效分类')
      const normalized = normalizeFeedbackContent(content)
      if (!normalized) throw new FeedbackValidationError('反馈内容不能为空')
      await store.submit(ownerId, username, category, normalized)
    },
  }
}

/** 反馈持久化；桌面仅能枚举其本地 owner，服务端管理员由 Host 完成授权。 */
export function createKyselyFeedbackOperations<DB>(db: Kysely<DB>, backend: 'postgres' | 'sqlite', localOwner?: string) {
  const ownerKey = (ownerId: string) => {
    const id = dataContext(ownerId).ownerId
    if (backend === 'sqlite' && (!localOwner || dataContext(localOwner).ownerId !== id)) throw new CoreError('invalid_request', 'owner 不匹配')
    return backend === 'sqlite' ? id.replaceAll('-', '') : id
  }
  return {
    async submit(ownerId: string, username: string, category: string, content: string): Promise<void> {
      const owner = ownerKey(ownerId)
      await sql`INSERT INTO feedbacks(user_id,username,category,content,created_at)
        VALUES(${owner},${username},${category},${content},CURRENT_TIMESTAMP)`.execute(db)
    },
    async list(page: number, pageSize: number, category: string) {
      const whereCategory = category ? sql` AND category=${category}` : sql``
      const owner = backend === 'sqlite' ? ownerKey(localOwner ?? '') : null
      const scope = owner ? sql` AND user_id=${owner}` : sql``
      const count = await sql<{ total: number | string }>`SELECT COUNT(*) AS total FROM feedbacks WHERE 1=1 ${scope} ${whereCategory}`.execute(db)
      const rows = await sql<{ id: number; username: string; category: string; content: string; created_at: Date | string }>`
        SELECT id,username,category,content,created_at FROM feedbacks WHERE 1=1 ${scope} ${whereCategory}
        ORDER BY created_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`.execute(db)
      return { total: Number(count.rows[0]?.total ?? 0), items: rows.rows.map((row) => ({
        id: Number(row.id), username: row.username, category: row.category, content: row.content,
        createdAt: feedbackTime(row.created_at),
      })) }
    },
  }
}

export { createFeedbackSubmission, type FeedbackNotice } from './submission.js'
export { createFeedbackNotifier, type FeedbackNotificationSettings, type FeedbackMail, type FeedbackMailTransport } from './notification.js'
