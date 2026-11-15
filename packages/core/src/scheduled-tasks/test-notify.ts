const channels = new Set(['web', 'email', 'feishu', 'qq', 'wechat', 'telegram', 'im', 'chat'])

export interface ScheduledTaskTestNotificationPlan {
  ownerId: string
  channels: string[]
  title: string
  text: string
}

export interface ScheduledTaskTestNotificationInput {
  channels?: string[] | null
  name?: string | null
  qq_delivery?: Record<string, unknown> | null
  im_delivery?: Record<string, unknown> | null
}

/** 复用旧版测试提醒的渠道归一化和消息契约；实际投递由 Host 平台适配器执行。 */
export function createScheduledTaskTestNotifier(
  deliver: (plan: ScheduledTaskTestNotificationPlan) => Promise<Record<string, string>>,
) {
  return async (ownerId: string, input: ScheduledTaskTestNotificationInput) => {
    const selected = [...new Set((input.channels ?? []).filter(channel => channels.has(channel)))]
    if (selected.length === 0) selected.push('web')
    const name = (input.name || '活动提醒').trim()
    const title = `${name}（测试）`
    const text = `这是一条测试提醒——「${name}」。如果你收到了这条消息，说明提醒渠道工作正常。`
    const result = await deliver({ ownerId, channels: selected, title, text })
    const msg = Object.keys(result).length === 0
      ? '已发送（未选任何投递渠道）'
      : `测试发送结果：\n${Object.entries(result).map(([channel, status]) => `· ${channel}：${status}`).join('\n')}`
    return { ok: true as const, result, msg }
  }
}
