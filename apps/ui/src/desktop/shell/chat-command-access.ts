import { agentCommandHelp, isAgentCommandHelpArgument } from '@gugu/core/agent/commands/help'
import { agentCommandMenu, canonicalAgentCommandName, parseAgentCommand, parseAgentGoalArgument } from '@gugu/core/agent/commands/menu'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { i18n } from '@/i18n'
import type { ResolveChatCommand } from '@/components/common/gugu-chat/chatCommands'
import { requestDesktopAgentSessions } from './agent-session-transport'
import { cancelDesktopChatSession, getDesktopRunState } from './agent-chat'

const workspaceDescription = '查看、绑定、解除或删除工作区'
const workspaceHelp = '/workspace list　列出可绑定工作区\n/workspace show　查看当前绑定\n/workspace bind <序号或名称>　绑定指定工作区\n/workspace personal　切回个人文件\n/workspace delete <ID> [confirm]　删除工作区登记\n/workspace status　查看沙箱权限状态'

const availableCommands: readonly string[] = ['auto', 'status', 'stop', 'memory', 'forget', 'new', 'help', 'goal', 'compact', 'workspace']

export async function listDesktopChatCommands() {
  return agentCommandMenu().filter(item => availableCommands.includes(item.command.slice(1)))
    .map(item => item.command === '/new' ? { ...item, description: i18n.global.t('chat.newCommandDescription') }
      : item.command === '/workspace' ? { ...item, description: workspaceDescription } : item)
}

export function createDesktopChatCommandAccess(automaticMode: {
  read(): Promise<boolean>
  write(enabled: boolean): Promise<boolean>
}): ResolveChatCommand {
  const t = i18n.global.t
  return (text, sessionId) => {
    const command = parseAgentCommand(text)
    if (!command?.recognized) return undefined
    const { name } = command
    const argument = command.argument.toLowerCase()
    const goalAction = name === 'goal' && !isAgentCommandHelpArgument(argument) ? parseAgentGoalArgument(argument) : null
    if (goalAction === 'create' || name === 'compact' && !isAgentCommandHelpArgument(argument)) return undefined
    if (name === 'workspace' && !isAgentCommandHelpArgument(argument)) return undefined
    return async () => {
      if (name === 'workspace') return { text: workspaceHelp }
      if (name === 'goal' && !isAgentCommandHelpArgument(argument)) {
        if (sessionId == null) return { text: '当前还没有可管理目标任务的会话。' }
        if (!goalAction) return { text: agentCommandHelp('goal', availableCommands) }
        return { ...await requestDesktopAgentSessions({ action: 'goal', id: sessionId, goalAction }),
          refreshSessions: goalAction !== 'status' }
      }
      if (!availableCommands.includes(name) || name === 'help' || isAgentCommandHelpArgument(argument)) {
        const target = name === 'help' && !isAgentCommandHelpArgument(argument)
          ? canonicalAgentCommandName(argument) : name === 'help' ? '' : name
        if (target === 'workspace') return { text: workspaceHelp }
        if (target === 'new') return { text: `/new　${t('chat.newCommandDescription')}` }
        return { text: agentCommandHelp(target, availableCommands, { '/new': t('chat.newCommandDescription'), '/workspace': workspaceDescription }) }
      }
      if (name === 'new')
        return argument ? { text: `/new　${t('chat.newCommandDescription')}` } : { newSession: true }
      if (name === 'auto') {
        if (argument && !['status', 'on', 'off'].includes(argument))
          return { text: t('chat.automaticModeCommandUsage') }
        const enabled = argument === 'on' || argument === 'off'
          ? await automaticMode.write(argument === 'on')
          : await automaticMode.read()
        return {
          text: t(enabled ? 'chat.automaticModeEnabledStatus' : 'chat.automaticModeDisabledStatus'),
          automaticModeEnabled: enabled,
        }
      }
      if (name === 'memory') {
        if (argument) return { text: t('chat.memoryCommandUsage') }
        const { text } = await requestDesktopAgentSessions({ action: 'readMemory' })
        return { text: text || t('chat.memoryEmpty') }
      }
      if (name === 'forget') {
        const query = command.argument
        if (!query) return { text: t('chat.forgetCommandUsage') }
        const preview = await requestDesktopAgentSessions({ action: 'forgetMemory', query })
        if (!preview.count) return { text: t('chat.forgetNoMatch') }
        const confirmed = await confirmDialog({
          title: t('chat.forgetConfirmTitle'),
          message: t('chat.forgetConfirmMessage', { count: preview.count }),
          confirmText: t('common.actions.delete'),
          tone: 'danger',
        })
        if (!confirmed) return { text: t('chat.forgetCancelled') }
        const { count } = await requestDesktopAgentSessions({ action: 'forgetMemory', query, revision: preview.revision })
        return { text: t('chat.forgetCompleted', { count }) }
      }
      if (argument) return { text: t('chat.taskCommandUsage') }
      if (name === 'stop') {
        if (sessionId == null) return { text: t('chat.noActiveTask') }
        const { outcome } = await cancelDesktopChatSession(sessionId)
        return { text: t(outcome === 'interrupted' ? 'chat.taskStopRequested' : 'chat.noActiveTask') }
      }
      const state = sessionId == null ? null : await getDesktopRunState(sessionId)
      if (state?.status === 'waiting') return { text: t('chatUi.waitingConfirmation') }
      return { text: t(state?.status === 'running' || state?.status === 'preparing' ? 'chat.taskInProgress' : 'chat.noActiveTask') }
    }
  }
}
