import type { Kysely } from 'kysely'
import type { Database } from '#core-source/data/schema.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { RunIdentity } from '#core-source/agent/models.js'
import { stableJson } from '#core-source/agent/context/history/canonical-history.js'
import { createListScheduledTasksTool, createScheduledTaskWriteTools } from '#core-source/agent/tools/scheduled-tasks.js'
import type { createSqliteToolConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'
import { desktopImGroupRunEvent } from '#core-source/im/desktop-inbox.js'
import { desktopScheduleImDeliveryTargets, desktopScheduleImPlatforms, desktopScheduleImTarget, ownsDesktopScheduleImTarget, readDesktopScheduleImTargets, type DesktopScheduleImPlatform, type DesktopScheduleImTarget } from '#core-source/scheduled-tasks/desktop-im.js'
import { desktopScheduledTasks } from '#core-source/scheduled-tasks/desktop.js'
import { ScheduledTaskReferenceError } from '#core-source/scheduled-tasks/task-write.js'
import type { createScheduledTaskQueries } from '#core-source/scheduled-tasks/task-list.js'
import type { createDesktopScheduledImContext } from '../../schedules/context.js'
import { desktopGroupMemoryContext } from './im-memory-context.js'

export function createDesktopScheduleTools(options: {
  core: SqlDataRuntime
  ownerId: string
  imPlatform: string | undefined
  hasImSession: boolean
  groupChat: boolean
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  currentScheduledIm: ReturnType<typeof createDesktopScheduledImContext>['authorizeIm']
  scheduledTasks: ReturnType<typeof createScheduledTaskQueries>
  authorizeWrite: Parameters<typeof createSqliteToolConfirmation>[1]
}) {
  const { core, ownerId, imPlatform, hasImSession, groupChat, hostRequest, currentScheduledIm, scheduledTasks, authorizeWrite } = options
  const { db } = core
  async function privateScheduleImTarget(platform: DesktopScheduleImPlatform, identity: RunIdentity, signal?: AbortSignal,
    database: Kysely<Database> = db) {
    const target = desktopScheduleImTarget.safeParse(await hostRequest('agent.schedules.im.privateTarget', { platform }, signal))
    return target.success && await ownsDesktopScheduleImTarget<Database>(database, identity.ownerId, target.data) ? target.data : null
  }
  async function scheduleImTarget(identity: RunIdentity, signal?: AbortSignal, database: Kysely<Database> = db) {
    const platform = imPlatform
    if (platform !== 'qq' && platform !== 'feishu' && platform !== 'telegram' && platform !== 'wechat') return null
    if (!groupChat) return privateScheduleImTarget(platform, identity, signal, database)
    const receipt = await desktopImGroupRunEvent(database, identity)
    if (!receipt) return null
    const scope = desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext', { ...receipt, ownerId }, signal), ownerId)
    if (!scope?.actor.verifiedOwner || scope.platform !== platform) return null
    const target = desktopScheduleImTarget.safeParse({
      platform, botId: scope.botId, chatType: 'group', recipient: scope.chatId, boundUserId: scope.platformUserId,
    })
    return target.success ? target.data : null
  }
  function writeScheduleTarget(input: Record<string, unknown>) {
    const { delivery_targets, authorized_tools: _authorizedTools, ...fields } = input
    const targets = readDesktopScheduleImTargets(delivery_targets, Array.isArray(fields.channels) ? fields.channels : [])
    return { fields, targets }
  }
  async function resolveScheduleDelivery(database: Kysely<Database>, identity: RunIdentity,
    intent: { channels?: readonly string[]; mode?: 'owner_private' | 'current_group' }, signal: AbortSignal) {
    const channelList = intent.channels
    const selected = channelList?.filter((channel): channel is DesktopScheduleImPlatform =>
      channel === 'qq' || channel === 'feishu' || channel === 'telegram' || channel === 'wechat') ?? []
    const bound = hasImSession && (groupChat || !selected.length) ? await scheduleImTarget(identity, signal, database) : null
    if ((groupChat || intent.mode === 'current_group') && bound?.chatType !== 'group')
      throw new ScheduledTaskReferenceError('当前 IM 对话没有可用的群任务投递授权')
    if (groupChat && intent.mode === 'owner_private')
      throw new ScheduledTaskReferenceError('群聊不能指定私聊投递目标')
    if (intent.mode === 'owner_private' && !bound && !selected.length)
      throw new ScheduledTaskReferenceError('请指定可用的私聊投递渠道')
    const channels = [...new Set([...selected, ...(bound ? [bound.platform] : [])])]
    if (!channels.length) return {}
    const targets: DesktopScheduleImTarget[] = []
    for (const platform of channels) {
      const target = bound?.platform === platform ? bound : await privateScheduleImTarget(platform, identity, signal, database)
      if (!target || !await currentScheduledIm(target, signal, database))
        throw new ScheduledTaskReferenceError('当前 IM 投递目标已失效')
      targets.push(target)
    }
    return { channels: [...channels, ...(channelList?.includes('web') ? ['web'] : [])],
      delivery_targets: desktopScheduleImDeliveryTargets(targets) }
  }
  const scheduleWrites = core.receipts ? createScheduledTaskWriteTools(core, {
    reminderOnly: !hasImSession,
    supportedChannels: ['web', ...desktopScheduleImPlatforms],
    capabilities: { workspaceSupported: false, filesystemAuthorizationEnabled: false },
    async authorize(tx, identity, input, signal) {
      if (input.workspace_id !== undefined || input.email_attachment_file_paths !== undefined || input.authorized_tools !== undefined
        || input.filesystem_authorized !== undefined || input.channels?.some(channel => channel !== 'web' && channel !== 'qq' && channel !== 'feishu' && channel !== 'telegram' && channel !== 'wechat'))
        return false
      if (!await authorizeWrite(tx, identity, signal)) return false
      if (!groupChat) return input.delivery_mode !== 'current_group'
      const target = await scheduleImTarget(identity, signal, tx)
      if (!target || input.delivery_mode === 'owner_private' || 'task' in input || 'task_ids' in input) return false
      if ('task_id' in input && typeof input.task_id === 'number') {
        const task = await desktopScheduledTasks<Database>(tx, identity.ownerId).get(input.task_id)
        const current = readDesktopScheduleImTargets(task.delivery_targets, task.channels).find(candidate => candidate.chatType === 'group')
        return stableJson(current) === stableJson(target)
      }
      return true
    },
    async delivery(tx, identity, intent, signal) {
      return resolveScheduleDelivery(tx, identity, intent, signal)
    },
    async create(tx, owner, input) {
      const { fields, targets } = writeScheduleTarget(input)
      return (await desktopScheduledTasks<Database>(tx, owner).create({ execution_mode: targets.length ? 'instruction' : 'reminder', ...fields }, null, targets)).id
    },
    async update(tx, owner, id, patch) {
      const { fields, targets } = writeScheduleTarget(patch)
      const tasks = desktopScheduledTasks<Database>(tx, owner)
      if (!hasImSession && (fields.execution_mode ?? (await tasks.get(id)).execution_mode) !== 'reminder')
        throw new ScheduledTaskReferenceError('桌面端请使用提醒模式 execution_mode=reminder')
      await tasks.update(id, fields, null, targets)
    },
    async publish() {},
  }) : []
  const groupScheduleList = createListScheduledTasksTool({
    async list(identity, signal) {
      const target = await scheduleImTarget(identity, signal)
      if (!target) return []
      return (await scheduledTasks.agent(identity.ownerId, signal)).filter(task =>
        readDesktopScheduleImTargets(task.delivery_targets, task.channels).some(candidate => stableJson(candidate) === stableJson(target)))
        .map(({ delivery_targets: _target, ...task }) => task)
    },
  })
  return { privateScheduleImTarget, scheduleImTarget, resolveScheduleDelivery, scheduleWrites, groupScheduleList }
}
