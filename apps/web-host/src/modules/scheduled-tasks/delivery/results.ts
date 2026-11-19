import type { Pool } from 'pg'
import type { ScheduledTaskTestNotificationPlan } from '@gugu/core/scheduled-task-test-notify'
import type { ScheduledTaskExecutionPorts } from '@gugu/core/scheduled-task-run-now'
import type { AssertScheduledTaskLease } from '@gugu/core/scheduled-task-runner'
import type { EmailAttachmentReferences } from '@gugu/core/email/smtp-test'
import type { PreparedScheduledImDelivery, ScheduledTaskDeliveryPlan } from './targets.js'
import type { createScheduledImPushHistory } from './history.js'
import type { createScheduledTaskFeishuDelivery } from './feishu.js'
import type { createScheduledTaskWechatDelivery } from './wechat.js'
import type { createScheduledTaskQqDelivery } from './qq.js'
import type { createScheduledTaskTelegramDelivery } from './telegram.js'
import { readEmailProfile } from './email.js'

type NotificationRow = {
  id: number
  title: string
  content: string
  color: string
  bubble: boolean
  persist: boolean
}

type PublishNotification = (target: string, notification: NotificationRow) => Promise<boolean>
type ImPushHistory = ReturnType<typeof createScheduledImPushHistory>
type DeliveryOptions = {
  email(plan: ScheduledTaskTestNotificationPlan, attachments?: EmailAttachmentReferences, recipient?: string | null): Promise<Record<string, string>>
  feishu?: ReturnType<typeof createScheduledTaskFeishuDelivery>
  wechat?: ReturnType<typeof createScheduledTaskWechatDelivery>
  qq?: ReturnType<typeof createScheduledTaskQqDelivery>
  telegram?: ReturnType<typeof createScheduledTaskTelegramDelivery>
  recordImPush?: ImPushHistory
}

async function deliverEmail(
  plan: ScheduledTaskDeliveryPlan,
  send: DeliveryOptions['email'],
  attachments: EmailAttachmentReferences | undefined,
): Promise<string> {
  try {
    const result = plan.emailRecipient === undefined ? await send(plan, attachments) : await send(plan, attachments, plan.emailRecipient)
    return result['邮件'] ?? '发送失败（smtp_delivery_error）'
  } catch {
    return '发送失败（smtp_delivery_error）'
  }
}

export function createPostgresScheduledTaskTestDelivery(
  pool: Pick<Pool, 'query'>,
  publish: PublishNotification,
  options: DeliveryOptions,
) {
  return async (plan: ScheduledTaskDeliveryPlan, assertLease?: AssertScheduledTaskLease): Promise<Record<string, string>> => {
    const result: Record<string, string> = {}
    const selected = new Set(plan.channels)
    const sendFeishu = selected.has('feishu') || selected.has('im') ? await options.feishu?.(plan) : undefined
    const sendWechat = selected.has('wechat') || selected.has('im') ? await options.wechat?.(plan) : undefined
    const sendQq = selected.has('qq') || selected.has('im') ? await options.qq?.(plan) : undefined
    const sendTelegram = selected.has('telegram') || selected.has('im') ? await options.telegram?.(plan) : undefined
    if (selected.has('email')) {
      await assertLease?.()
      result['邮件'] = await deliverEmail(plan, options.email, plan.emailAttachments)
    }
    if (selected.has('web') || selected.has('chat')) {
      await assertLease?.()
      let notification: NotificationRow | undefined
      try {
        const inserted = await pool.query<NotificationRow>(
          `INSERT INTO site_notifications(title,content,color,target,bubble,persist,bubble_expire_at,created_by,created_at)
           VALUES($1,$2,$3,$4,TRUE,TRUE,NULL,'scheduled_task',NOW())
           RETURNING id,title,content,color,bubble,persist`,
          [plan.title, plan.text, '#7b7fb2', plan.ownerId],
        )
        notification = inserted.rows[0]
      } catch { /* 数据库不可用时仍尝试投递到其他已配置渠道。 */ }
      if (notification) {
        await assertLease?.()
        let published = false
        try { published = await publish(plan.ownerId, notification) } catch { /* 持久通知仍可在通知中心读取。 */ }
        result['web 通知'] = published ? '已发送' : '已保存（实时提示失败）'
        if (plan.artifacts?.length) result['web 通知'] += '（网页通知不支持附件，图片未随通知显示）'
      } else {
        result['web 通知'] = '发送失败（通知中心不可用）'
      }
    }
    const send = async (platform: 'qq' | 'feishu' | 'wechat' | 'telegram', deliver?: PreparedScheduledImDelivery) => {
      if (!deliver) return 'Node 服务暂未接入该投递渠道'
      await assertLease?.()
      const status = await deliver()
      if (status === '已发送' && deliver.recipient && options.recordImPush) {
        try {
          await assertLease?.()
          await options.recordImPush(plan, platform, deliver.recipient)
        } catch { console.warn('定时 IM 推送后的会话维护失败') }
      }
      const artifacts = plan.artifacts
      if (status !== '已发送' || !artifacts?.length) return status
      let sent = 0
      if (deliver.sendAttachment) for (const artifact of artifacts) {
        await assertLease?.()
        try { if (await deliver.sendAttachment(artifact, assertLease)) sent++ } catch { /* 单件失败仍继续后续附件。 */ }
      }
      return sent === artifacts.length ? status : `文字已发送，附件发送失败（${sent}/${artifacts.length}）`
    }
    if (selected.has('qq') || selected.has('im')) result['QQ'] = await send('qq', sendQq)
    if (selected.has('telegram') || selected.has('im')) result['Telegram'] = await send('telegram', sendTelegram)
    if (selected.has('feishu') || selected.has('im')) result['飞书'] = await send('feishu', sendFeishu)
    if (selected.has('wechat') || selected.has('im')) result['微信'] = await send('wechat', sendWechat)
    return result
  }
}

export function createPostgresScheduledTaskResultDelivery(
  pool: Pick<Pool, 'query'>,
  publish: PublishNotification,
  options: DeliveryOptions,
) {
  const deliver = createPostgresScheduledTaskTestDelivery(pool, publish, options)
  type ResultDelivery = ScheduledTaskExecutionPorts<unknown>['deliver']
  type Task = Parameters<ResultDelivery>[0]
  function resultPlan(task: Task, outcome: Parameters<ResultDelivery>[1]): ScheduledTaskDeliveryPlan {
    return {
      ownerId: task.ownerId,
      channels: [...task.channels],
      title: outcome.status === 'failed' ? `${task.name}（执行失败）` : task.name,
      text: outcome.text,
      fixedTargets: task.deliveryTargets,
      artifacts: outcome.files,
      emailAttachments: outcome.files.length || task.emailAttachmentFileIds.length
        ? { fileIds: task.emailAttachmentFileIds, generated: outcome.files } : undefined,
    }
  }
  const deliverResult: ResultDelivery = (task, outcome, assertLease) => deliver(resultPlan(task, outcome), assertLease)
  return Object.assign(deliverResult, {
    async bindRecipients(task: Task) {
      const initialPlan = resultPlan(task, { status: 'success', text: '', files: [] })
      const fixedTargets = { ...task.deliveryTargets }
      for (const platform of ['feishu', 'qq', 'wechat', 'telegram'] as const) {
        if (!(task.channels.includes(platform) || task.channels.includes('im')) || Object.hasOwn(fixedTargets, platform)) continue
        try { fixedTargets[platform] = (await options[platform]?.(initialPlan))?.recipient ?? null }
        catch { fixedTargets[platform] = null }
      }
      const emailRecipient = task.channels.includes('email')
        ? (await readEmailProfile(pool, task.ownerId))?.ownerEmail ?? null
        : undefined
      return (outcome: Parameters<ResultDelivery>[1], assertLease?: AssertScheduledTaskLease, noticeTitle?: string) => {
        const plan = resultPlan(task, outcome)
        return deliver({
          ...plan, fixedTargets, emailRecipient,
          ...(noticeTitle ? { title: noticeTitle, artifacts: [], emailAttachments: undefined } : {}),
        }, assertLease)
      }
    },
  })
}
