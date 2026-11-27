import { matchesScheduledGroup, readHostedScheduledGroups } from '../../../../../packages/core/src/runtime/desktop-schedules/desktop-group-targets.js'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../../../../packages/core/src/data/schema.js'
import type { DesktopMemoryFiles } from '../../../../../packages/core/src/agent/memory/desktop-files.js'
import type { ScheduledTaskExecutionPlan } from '../../../../../packages/core/src/tasks/run-now-read.js'
import { createScheduledTaskGroupMemoryReader } from '../../../../../packages/core/src/agent/scenes/task/group-memory.js'
import { createScheduledTaskGroupMemorySearchPort } from '../../../../../packages/core/src/agent/scenes/task/group-tools.js'
import { createMemorySearchTool } from '../../../../../packages/core/src/agent/tools/memory/index.js'
import { configureRagJieba } from '../../../../../packages/core/src/agent/rag/tokenizer.js'
import { getAgentRagJieba } from '../../../../../packages/core/src/agent/rag/node-jieba.js'
import { groupScopePrefix } from '../../../../../packages/core/src/agent/rag/memory-loader.js'
import { desktopScheduleImConnection, ownsDesktopScheduleImTarget, readDesktopScheduleImTargets, type DesktopScheduleImTarget } from '../../../../../packages/core/src/runtime/desktop-schedules/desktop-im.js'
import { createDesktopGroupContextSearch } from '../../../../../packages/core/src/im/desktop-group-context.js'
import { createGroupContextSearchTool } from '../../../../../packages/core/src/agent/tools/im/group-context.js'

/** 定时运行通过已保存的目标和当前绑定复查群权限，不依赖聊天发言人。 */
export function createDesktopScheduledImContext({ db, ownerId, memoryFiles, hostRequest }: {
  db: Kysely<Database>
  ownerId: string
  memoryFiles?: DesktopMemoryFiles
  hostRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}) {
  async function currentScheduledIm(target: DesktopScheduleImTarget, signal?: AbortSignal, database: Kysely<Database> = db) {
    signal?.throwIfAborted()
    if (!await ownsDesktopScheduleImTarget<Database>(database, ownerId, target)) {
      const groups = await readHostedScheduledGroups(target.platform,
        () => hostRequest('agent.schedules.im.groupCatalog', { platform: target.platform }, signal))
      if (!groups.some(entry => matchesScheduledGroup(entry.target, target))) return null
    }
    const result = await hostRequest('agent.schedules.im.authorize', { target }, signal)
    signal?.throwIfAborted()
    if (!result || typeof result !== 'object' || !('groupMemoryEnabled' in result) || typeof result.groupMemoryEnabled !== 'boolean')
      return null
    return { groupMemoryEnabled: result.groupMemoryEnabled,
      groupHistorySearchEnabled: 'groupHistorySearchEnabled' in result && result.groupHistorySearchEnabled === true }
  }
  function scheduledGroupStorage(scope: NonNullable<ScheduledTaskExecutionPlan['groupScope']>) {
    const fileScope = { owner_user_id: scope.ownerId, platform: scope.platform, bot_id: scope.botId,
      scope_type: 'group' as const, scope_id: scope.scopeId }
    const prefix = groupScopePrefix(scope.ownerId, { ownerId: scope.ownerId, platform: scope.platform,
      botId: scope.botId, type: 'group', id: scope.scopeId })
    return {
      async readText(input: { ownerId: string; key: string; maxChars: number; signal?: AbortSignal }) {
        input.signal?.throwIfAborted()
        if (!memoryFiles || input.ownerId !== scope.ownerId || !input.key.startsWith(prefix)) return null
        const filename = input.key.slice(prefix.length)
        if (!['profile.json', 'summary.json', 'daily.md', 'memory.md'].includes(filename)) return null
        return (await memoryFiles.readImScope(fileScope, filename))?.slice(0, input.maxChars) ?? null
      },
    }
  }
  async function scheduledGroupTombstone(scope: { owner_user_id: string; platform: string; bot_id: string; scope_id: string }) {
    const { rows } = await sql`SELECT 1 FROM desktop_im_memory_tombstones
      WHERE owner_id=${scope.owner_user_id.replaceAll('-', '')} AND platform=${scope.platform}
        AND bot_id=${scope.bot_id} AND scope_type='group' AND scope_id=${scope.scope_id}`.execute(db)
    return rows.length > 0
  }
  return {
    authorizeIm: currentScheduledIm,
    async loadGroupMemory(task: ScheduledTaskExecutionPlan) {
      const scope = task.groupScope
      const target = readDesktopScheduleImTargets(task.deliveryTargets, task.channels).find(candidate => candidate.chatType === 'group')
      if (!scope || !target || !memoryFiles || !(await currentScheduledIm(target))?.groupMemoryEnabled) return ''
      const text = await createScheduledTaskGroupMemoryReader(db, scheduledGroupStorage(scope), scheduledGroupTombstone)(scope)
      return (await currentScheduledIm(target))?.groupMemoryEnabled ? text : ''
    },
    groupTools(task: ScheduledTaskExecutionPlan) {
      const scope = task.groupScope
      const target = readDesktopScheduleImTargets(task.deliveryTargets, task.channels).find(candidate => candidate.chatType === 'group')
      if (!scope || !target) return []
      const groupHistory = createGroupContextSearchTool(createDesktopGroupContextSearch(db,
        async identity => identity.ownerId === scope.ownerId && Boolean((await currentScheduledIm(target))?.groupHistorySearchEnabled),
        desktopScheduleImConnection(target)))
      if (!memoryFiles) return [groupHistory]
      configureRagJieba(getAgentRagJieba())
      return [groupHistory, createMemorySearchTool(createScheduledTaskGroupMemorySearchPort({
        storage: scheduledGroupStorage(scope),
        scopeState: {
          async getMemoryScopeState() {
            return { revision: String(Date.now()), tombstoned: await scheduledGroupTombstone({
              owner_user_id: scope.ownerId, platform: scope.platform, bot_id: scope.botId, scope_id: scope.scopeId,
            }) }
          },
        },
        async resolveGroup(identity, signal) {
          if (identity.ownerId !== scope.ownerId || !(await currentScheduledIm(target, signal))?.groupMemoryEnabled) return null
          return { platform: scope.platform, botId: scope.botId, chatId: scope.scopeId }
        },
      }))]
    },
  }
}
