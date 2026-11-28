import { strip } from '../../shared/values.js'

export const PERSONAL_WORKSPACE_ID = 'personal'
export const PERSONAL_WORKSPACE_NAME = '个人文件'

export function isPersonalWorkspaceSelection(value: string) {
  return [PERSONAL_WORKSPACE_ID, PERSONAL_WORKSPACE_NAME].includes(value.trim().replace(/^bind\s+/iu, '').toLowerCase())
}

export function workspaceOptionsReply(rows: readonly { id?: string | number; commandNumber?: number; name: string }[]) {
  const lines = rows.map(row => {
    const id = row.commandNumber ?? row.id
    return `- ${id === undefined ? '' : `${id}. `}${row.name}`
  })
  return ['可选工作区：', `- ${PERSONAL_WORKSPACE_ID}. ${PERSONAL_WORKSPACE_NAME}`, ...lines, '',
    '使用 /workspace bind <编号> 绑定，或 /workspace personal 切回个人文件。'].join('\n')
}

/** 聊天菜单是规范命令的静态目录；认证和命令执行权限由调用方负责。 */
export function agentCommandMenu() {
  return [
    { command: '/stop', label: '停止当前任务', description: '立即停止正在进行的任务', insert: '/stop' },
    { command: '/status', label: '查看进度', description: '查看当前任务状态', insert: '/status' },
    { command: '/compact', label: '整理上下文', description: '压缩当前会话的旧对话', insert: '/compact' },
    { command: '/goal', label: '目标任务', description: '创建一个持续推进的目标', insert: '/goal ' },
    { command: '/new', label: '开启新对话', description: '清空当前对话上下文', insert: '/new' },
    { command: '/memory', label: '查看记忆', description: '查看咕咕记住的内容', insert: '/memory' },
    { command: '/forget', label: '忘记一条记忆', description: '输入要忘记的内容', insert: '/forget ' },
    { command: '/workspace', label: '工作区', description: '查看、绑定、解除或删除工作区', insert: '/workspace ' },
    { command: '/auto', label: '自动模式', description: '查看或开启、关闭自动模式', insert: '/auto ' },
    { command: '/help', label: '命令帮助', description: '查看全部命令说明', insert: '/help' },
  ]
}

const aliases: Readonly<Record<string, string>> = { mem: 'memory', s: 'stop', cancel: 'stop', x: 'stop', h: 'help' }
const commandNames = new Set(agentCommandMenu().map(item => item.command.slice(1)))

export function canonicalAgentCommandName(value: string): string {
  const name = strip(value).replace(/^[/／]/u, '').toLowerCase()
  return Object.hasOwn(aliases, name) ? aliases[name]! : name
}

/** 保留参数原文，身份、权限和入口支持范围由调用方决定。 */
export function parseAgentCommand(text: string): { name: string; argument: string; recognized: boolean } | null {
  const value = strip(text)
  if (!/^[/／]/u.test(value)) return null
  const body = Array.from(strip(value.slice(1)))
  const split = body.findIndex(character => strip(character) === '')
  const name = canonicalAgentCommandName(body.slice(0, split < 0 ? body.length : split).join(''))
  // 不在令牌内部接受第二个斜杠。
  const recognized = body[0] !== '/' && body[0] !== '／' && commandNames.has(name)
  return { name, argument: split < 0 ? '' : strip(body.slice(split).join('')), recognized }
}

/** 兼容旧聊天入口的目标命令别名，保留目标原文。 */
export function parseAgentGoalArgument(argument: string): 'status' | 'pause' | 'resume' | 'cancel' | 'create' | null {
  const value = argument.trim().toLowerCase()
  if (!value) return null
  if (['status', '状态'].includes(value)) return 'status'
  if (['pause', '暂停'].includes(value)) return 'pause'
  if (['resume', '继续', '恢复'].includes(value)) return 'resume'
  if (['cancel', '取消', 'stop'].includes(value)) return 'cancel'
  return 'create'
}

export function parseDesktopWorkspaceCommand(argument: string): { action: 'list' | 'show' | 'bind' | 'unlink'; directoryId?: string } | null {
  const value = argument.trim()
  if (!value || value === 'list' || value === '列表') return { action: 'list' }
  if (value === 'show' || value === '查看' || value === '当前') return { action: 'show' }
  if (isPersonalWorkspaceSelection(value) || ['off', 'none', 'unbind', 'unlink', '解除绑定', '取消绑定'].includes(value.toLowerCase())) return { action: 'unlink' }
  const explicit = /^bind\s+(.+)$/iu.exec(value)?.[1]?.trim()
  const directoryId = explicit || value
  return explicit || /^(?:desktop:[a-f0-9-]{36}|[a-f0-9]{8}|[1-9][0-9]*)$/iu.test(directoryId)
    ? { action: 'bind', directoryId } : null
}

export function desktopWorkspaceReply(action: 'list' | 'show' | 'bind' | 'unlink', result: unknown): string {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
  if (action === 'list') {
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces as Array<{ id?: string; commandNumber?: number; name: string }> : []
    return workspaceOptionsReply(workspaces)
  }
  if (action === 'unlink') return '已将当前会话切回个人文件。'
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace as Record<string, unknown> : null
  if (!workspace) return action === 'show' ? '当前会话的工作区：个人文件。' : '工作区绑定失败。'
  return action === 'show' ? `当前会话绑定的工作区：${String(workspace.workspace_name)}`
    : `已将当前会话绑定到工作区「${String(workspace.workspace_name)}」。`
}
