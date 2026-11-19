import type { TaskFilesystemRevokeEffects } from '@gugu/core/scheduled-task-filesystem-revoke'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createScheduledTaskWriteTools } from '@gugu/core/tools'
import { normalizeScheduledTaskChannels, normalizeScheduledTaskTools, ScheduledTaskReferenceError } from '@gugu/core/scheduled-task-write'
import { parseScheduledTaskDeliveryTarget } from '@gugu/core/scheduled-task-run-now-read'
import { createBorrowedPostgresTaskWrites, type TaskWriteOptions } from '../../scheduled-tasks/persistence/task-writes-postgres.js'
import type { createWebAgentConfirmationAuthorization } from './agent-confirmation.js'

/** Agent 只承诺当前 Web Host 能实际消费的独立任务及 owner 投递。 */
export function createWebAgentScheduledTaskWrites(core: SqlDataRuntime, options: {
  writes: Omit<TaskWriteOptions, 'publish'>
  filesystemRevocation: TaskFilesystemRevokeEffects
  emailAuthorization?: Parameters<typeof createScheduledTaskWriteTools>[1]['emailAuthorization']
  authorize: ReturnType<typeof createWebAgentConfirmationAuthorization>['authorizeInTransaction']
  accessVersion: string
  workers: { once: boolean; repeating: boolean }
  emailAvailable(owner: string, client?: Parameters<TaskWriteOptions['resolve']>[0]): Promise<boolean>
  imEnabled(platform: 'qq' | 'feishu'): boolean
  publish(owner: string, operation: 'create' | 'update', taskId: number): Promise<void>
}) {
  if (!core.receipts || (!options.workers.once && !options.workers.repeating)) return undefined
  const writes = {
    ...options.writes,
    async resolve(client, owner, input, schedule, previous) {
      const enabled = input.enabled ?? previous?.enabled ?? true
      if (previous?.filesystem_authorization_grant_id != null)
        throw new ScheduledTaskReferenceError('已有文件授权的定时任务须通过设置修改')
      if (enabled && !(schedule.schedule_kind === 'once' ? options.workers.once : options.workers.repeating))
        throw new ScheduledTaskReferenceError('该类型的定时任务消费者未启用')
      if (enabled && (Object.hasOwn(input, 'workspace_id') ? input.workspace_id : previous?.workspace_id) != null)
        throw new ScheduledTaskReferenceError('该任务的工作区、文件或自动发送邮件授权暂不可用')
      const preauthorizesEmail = normalizeScheduledTaskTools(input.authorized_tools ?? previous?.authorized_tools).includes('send_email')
      if (preauthorizesEmail && (enabled || input.authorized_tools != null) && !await options.emailAvailable(owner, client))
        throw new ScheduledTaskReferenceError('当前账号的定时任务邮件工具不可用')
      const resolved = await options.writes.resolve(client, owner, input, schedule, previous)
      if (!enabled) return resolved
      const channels = typeof previous?.channels === 'string' && input.channels == null
        ? previous.channels.split(',') : normalizeScheduledTaskChannels(input.channels ?? ['web']).split(',')
      for (const channel of channels) {
        if (channel === 'web' || channel === 'chat') continue
        if (channel === 'email') {
          if (!await options.emailAvailable(owner, client)) throw new ScheduledTaskReferenceError('当前账号的邮件提醒投递不可用')
          continue
        }
        if ((channel !== 'qq' && channel !== 'feishu') || !options.imEnabled(channel))
          throw new ScheduledTaskReferenceError('当前账号的定时任务投递渠道不可用')
        const targets = resolved.delivery_targets as Readonly<Record<string, unknown>> | undefined
        const target = parseScheduledTaskDeliveryTarget(targets ?? undefined, channel)
        if (!target || target.group) throw new ScheduledTaskReferenceError('当前账号没有可验证的私聊投递目标')
        const bot = (await client.query<{ owner_platform_user_id: string | null }>(
          'SELECT owner_platform_user_id FROM user_bots WHERE user_id=$1 AND platform=$2 AND id=$3 AND enabled=TRUE FOR SHARE',
          [owner, channel, target.botId],
        )).rows[0]
        if (bot?.owner_platform_user_id !== target.recipient)
          throw new ScheduledTaskReferenceError('定时任务私聊投递归属已变化')
      }
      return resolved
    },
  } satisfies Omit<TaskWriteOptions, 'publish'>
  return createScheduledTaskWriteTools(core, {
    capabilities: { workspaceSupported: false, filesystemAuthorizationEnabled: false },
    filesystemRevocation: options.filesystemRevocation,
    emailAuthorization: options.emailAuthorization,
    async canPreauthorizeEmail(identity, signal) {
      const available = await options.emailAvailable(identity.ownerId)
      signal.throwIfAborted()
      return available
    },
    async authorize(tx, identity, _input, signal) {
      return (await options.authorize(tx, identity, signal))?.endsWith(`:${options.accessVersion}`) === true
    },
    async delivery(_tx, _identity, intent) {
      if (intent.mode === 'current_group') throw new ScheduledTaskReferenceError('只有当前 QQ 群聊的可信运行可以设置群投递')
      // 由 REST 解析器固定私聊目标，避免仅修改 delivery_mode 时保留先前群目标。
      return { im_delivery: { qq: { mode: 'private' }, feishu: { mode: 'private' } } }
    },
    async create(tx, owner, input) {
      return (await createBorrowedPostgresTaskWrites(tx, writes).create(owner, input, null, null)).task.id
    },
    async update(tx, owner, id, patch) {
      await createBorrowedPostgresTaskWrites(tx, writes).update(owner, id, patch, null)
    },
    publish: options.publish,
  })
}
