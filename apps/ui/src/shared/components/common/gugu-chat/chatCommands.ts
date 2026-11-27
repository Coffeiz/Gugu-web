import { agentApi } from '@/services/api'
import { isAgentCommandHelpArgument } from '@gugu/core/agent/commands/help'
import { PERSONAL_WORKSPACE_ID, parseAgentCommand, parseDesktopWorkspaceCommand, workspaceOptionsReply } from '@gugu/core/agent/commands/menu'
import type { ChatWorkspaceAccess } from './chatTypes'

export function resolveWorkspaceChatCommand(text: string, sessionId: number | null,
  name: string, access: ChatWorkspaceAccess, locked: boolean): ReturnType<ResolveChatCommand> {
  const command = parseAgentCommand(text)
  if (command?.name !== 'workspace') return
  const argument = command.argument
  if (isAgentCommandHelpArgument(argument))
    return async () => ({ text: '/workspace list · 列出工作区\n/workspace show · 显示当前工作区\n/workspace bind <编号> · 切换工作区\n/workspace personal · 切回个人文件' })
  const parsed = parseDesktopWorkspaceCommand(argument || 'show')
  if (!parsed) return
  return async () => {
    if (parsed.action === 'show') return { text: `当前会话的工作区：${name}。` }
    if (parsed.action === 'list') return { text: workspaceOptionsReply(await access.list(sessionId ?? 0)) }
    if (locked) return { text: '当前会话无法切换工作区。' }
    if (sessionId === null) return { text: '请先发送一条消息建立会话。' }
    const selection = parsed.action === 'unlink' ? null
      : (await access.list(sessionId)).find(row => String(row.id) === parsed.directoryId)
    if (selection === undefined) return { text: '工作区不存在或已停用。' }
    await access.select(sessionId, selection?.id ?? PERSONAL_WORKSPACE_ID)
    return { text: selection ? `已将当前会话绑定到工作区「${selection.name}」。` : '已将当前会话切回个人文件。', refreshSessions: true }
  }
}

export interface ChatCommandOption {
  command: string
  label: string
  description: string
  insert: string
}

export type ResolveChatCommand = (text: string, sessionId: number | null) => (() => Promise<{
  text: string
  refreshSessions?: boolean
  automaticModeEnabled?: boolean
} | { newSession: true }>) | undefined

let commandCache: ChatCommandOption[] | null = null
let commandRequest: Promise<ChatCommandOption[]> | null = null

export function loadChatCommands(): Promise<ChatCommandOption[]> {
  if (commandCache) return Promise.resolve(commandCache)
  if (!commandRequest) {
    commandRequest = agentApi.listCommands()
      .then((data) => {
        commandCache = data.commands
        return commandCache
      })
      .finally(() => { commandRequest = null })
  }
  return commandRequest
}
