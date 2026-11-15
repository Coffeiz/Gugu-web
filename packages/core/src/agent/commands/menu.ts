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
