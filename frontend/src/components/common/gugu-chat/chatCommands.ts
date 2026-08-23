export interface ChatCommandOption {
  command: string
  label: string
  description: string
  insert: string
}

/** 与 backend/agent/router.py 和 backend/agent/commands.py 保持一致的用户可见命令。 */
export const CHAT_COMMANDS: ChatCommandOption[] = [
  { command: '/stop', label: '停止当前任务', description: '立即停止正在进行的任务', insert: '/stop' },
  { command: '/status', label: '查看进度', description: '查看当前任务状态', insert: '/status' },
  { command: '/compact', label: '整理上下文', description: '压缩当前会话的旧对话', insert: '/compact' },
  { command: '/memory', label: '查看记忆', description: '查看咕咕记住的内容', insert: '/memory' },
  { command: '/forget', label: '忘记一条记忆', description: '输入要忘记的内容', insert: '/forget ' },
  { command: '/workspace', label: '工作区', description: '查看或绑定当前会话工作区', insert: '/workspace ' },
  { command: '/help', label: '命令帮助', description: '查看全部命令说明', insert: '/help' },
]
