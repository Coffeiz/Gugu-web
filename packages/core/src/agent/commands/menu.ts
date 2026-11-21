import { strip } from '../../shared/values.js'

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
    { command: '/workspace', label: '工作区', description: '查看、绑定、删除工作区或管理沙盒权限', insert: '/workspace ' },
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
