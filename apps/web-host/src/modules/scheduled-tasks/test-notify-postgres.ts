import type { Pool } from 'pg'
import type { ScheduledTaskTestNotificationPlan } from '@gugu/core/scheduled-task-test-notify'

type NotificationRow = {
  id: number
  title: string
  content: string
  color: string
  bubble: boolean
  persist: boolean
}

export function createPostgresScheduledTaskTestDelivery(
  pool: Pick<Pool, 'query'>,
  publish: (target: string, notification: NotificationRow) => Promise<boolean>,
) {
  return async (plan: ScheduledTaskTestNotificationPlan): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    const selected = new Set(plan.channels)
    if (selected.has('email')) result['邮件'] = 'Node 服务暂未接入该投递渠道'
    if (selected.has('web') || selected.has('chat')) {
      try {
        const inserted = await pool.query<NotificationRow>(
          `INSERT INTO site_notifications(title,content,color,target,bubble,persist,bubble_expire_at,created_by,created_at)
           VALUES($1,$2,$3,$4,TRUE,TRUE,NULL,'scheduled_task',NOW())
           RETURNING id,title,content,color,bubble,persist`,
          [plan.title, plan.text, '#7b7fb2', plan.ownerId],
        )
        const notification = inserted.rows[0]
        if (!notification) throw new Error('通知记录未返回')
        let published = false
        try { published = await publish(plan.ownerId, notification) } catch { /* 持久通知仍可在通知中心读取。 */ }
        result['web 通知'] = published ? '已发送' : '已保存（实时提示失败）'
      } catch {
        result['web 通知'] = '发送失败（通知中心不可用）'
      }
    }
    if (selected.has('qq')) result['QQ'] = 'Node 服务暂未接入该投递渠道'
    if (selected.has('feishu')) result['飞书'] = 'Node 服务暂未接入该投递渠道'
    if (selected.has('wechat')) result['微信'] = 'Node 服务暂未接入该投递渠道'
    if (selected.has('telegram')) result['Telegram'] = 'Node 服务暂未接入该投递渠道'
    if (selected.has('im')) {
      result['QQ'] = 'Node 服务暂未接入该投递渠道'
      result['飞书'] = 'Node 服务暂未接入该投递渠道'
      result['微信'] = 'Node 服务暂未接入该投递渠道'
      result['Telegram'] = 'Node 服务暂未接入该投递渠道'
    }
    return result
  }
}
