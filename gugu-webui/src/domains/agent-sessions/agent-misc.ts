import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

export interface AgentMiscRoutesOptions {
  requireUser: preHandlerHookHandler
  commandMenu(): unknown[]
  defaultStateLabels: Record<string, string>
  stateLabelOverrides(): Record<string, string | undefined>
}

export const DEFAULT_AGENT_STATE_LABELS = Object.freeze({
  _preparing: '咕咕正在整理…',
  _verify_prefix: '复查 · ',
  _thinking: '',
  _context_compaction: '正在整理上下文…',
})

const COMMAND_MENU = [
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

export function agentCommandMenu(): unknown[] {
  return COMMAND_MENU.map((item) => ({ ...item }))
}

function splitCandidates(raw: string | undefined): string[] {
  return (raw ?? '').split(/[|\n]/).map((value) => value.trim()).filter(Boolean)
}

export function registerAgentMiscRoutes(app: FastifyInstance, options: AgentMiscRoutesOptions): void {
  app.get('/api/v1/agent/commands', { preHandler: options.requireUser }, async () => ({
    commands: options.commandMenu(),
  }))

  app.get('/api/v1/agent/ui-labels', { preHandler: options.requireUser }, async () => {
    const overrides = Object.fromEntries(Object.entries(options.stateLabelOverrides())
      .filter(([key, value]) => key.startsWith('_') && Boolean(value)))
    const labels = { ...options.defaultStateLabels, ...overrides }
    return {
      thinking: splitCandidates(labels._thinking),
      contextCompacting: splitCandidates(labels._context_compaction),
    }
  })

}
