import type { ScheduledTaskTestNotificationPlan } from '@gugu/core/scheduled-task-test-notify'
import { parseScheduledTaskDeliveryTarget } from '@gugu/core/scheduled-task-run-now-read'
import type { EmailAttachmentReferences } from '@gugu/core/email/smtp-test'
import type { AssertScheduledTaskLease } from '@gugu/core/scheduled-task-runner'

export type ScheduledTaskDeliveryPlan = ScheduledTaskTestNotificationPlan & {
  fixedTargets?: Readonly<Record<string, unknown>>
  artifacts?: readonly unknown[]
  emailAttachments?: EmailAttachmentReferences
  emailRecipient?: string | null
}

export type ScheduledImRecipient = { channel_id: number; chat_type: 'group' | 'c2c'; chat_id?: string; puid?: string }
export type PreparedScheduledImDelivery = (() => Promise<string>) & {
  recipient?: ScheduledImRecipient
  sendAttachment?(artifact: unknown, assertLease?: AssertScheduledTaskLease): Promise<boolean>
}

/** 快照仅携带 Bot 和收件人标识。发送时的凭据及权限仍由渠道适配器复核。 */
export function bindScheduledImRecipient(
  send: () => Promise<string>, botId: number, group: boolean, recipient: string,
): PreparedScheduledImDelivery {
  return Object.assign(send, {
    recipient: group
      ? { channel_id: botId, chat_type: 'group' as const, chat_id: recipient }
      : { channel_id: botId, chat_type: 'c2c' as const, puid: recipient },
  })
}

export function fixedDeliveryTarget(plan: Pick<ScheduledTaskDeliveryPlan, 'fixedTargets'>, platform: string) {
  return parseScheduledTaskDeliveryTarget(plan.fixedTargets, platform)
}
