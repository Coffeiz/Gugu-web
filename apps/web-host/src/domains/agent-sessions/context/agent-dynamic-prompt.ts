import { agentCurrentDate } from './agent-static-prompt.js'

type Row = Record<string, unknown>
export interface AgentDynamicSnapshotInput {
  /** 由已授权的业务数据格式化器提供；不从模型或用户正文推导。 */
  memoryBlock: string
  projectBlock: string
  sourceBlock: string
  events: readonly { date: string; title: string }[]
  notes: readonly { title?: string | null; content?: string | null; capturedAt?: string | null }[]
  files: { total?: number; trash?: number; folders?: readonly { name: string; path?: string; file_count?: number }[]; files?: readonly { name: string; folder?: string | null }[] } | null
  knowledge: readonly Row[]
  includeProjects: boolean
  includeCalendar: boolean
  includeFiles: boolean
  includeKnowledge: boolean
}

function filesBlock(value: AgentDynamicSnapshotInput['files']): string {
  const folders = value?.folders ?? [], files = value?.files ?? []
  if (!value || (!value.total && !value.trash && !folders.length && !files.length)) return '暂无文件'
  const lines = [`个人文件库共 ${value.total ?? 0} 个活跃文件；回收站 ${value.trash || 0} 个。`]
  if (folders.length) lines.push('一级目录：' + folders.map(item => `${item.path ?? item.name}（文件数 ${item.file_count ?? 0}）`).join('、'))
  if (files.length) {
    lines.push(`最近文件（最多 ${files.length} 个；这里只是截断列表，不代表其它目录为空）：`)
    for (const file of files) lines.push(`- ${file.name}（${file.folder || '个人文件库'}）`)
  }
  return lines.join('\n')
}
function notesBlock(notes: AgentDynamicSnapshotInput['notes']): string {
  if (!notes.length) return '最近一周暂无笔记'
  return [`最近一周笔记（最多 ${notes.length} 条）：`, ...notes.map(note => `- ${note.title || '无标题'}${note.capturedAt ? `，日期：${note.capturedAt.slice(0, 10)}` : ''}：${note.content || '（无正文）'}`)].join('\n')
}
function knowledgeBlock(items: readonly Row[], enabled: boolean): string {
  if (!enabled) return '（本次任务不需要知识上下文，未加载）'
  const lines: string[] = []
  for (const item of items.slice(0, 40)) {
    const title = String(item.title || '').trim()
    if (!title) continue
    const topic = String(item.topic || '').trim()
    const description = String(item.description || '').trim() || (topic ? `（${topic}）` : '')
    lines.push(description ? `- ${title}：${description}` : `- ${title}`)
  }
  if (items.length > lines.length) lines.push(`（以上仅显示最新 ${lines.length} 条，另有 ${items.length - lines.length} 条更早条目未列出；查找旧知识用 read_knowledge 的 keyword 做 BM25 搜索，取完整正文时按 knowledge_id 直读）`)
  return lines.join('\n') || '暂无已保存知识'
}

/** snapshot 只保存低频业务资料，不包含当前分钟或本轮用户正文。 */
export function buildAgentDynamicSnapshot(input: AgentDynamicSnapshotInput): string {
  const parts = [input.memoryBlock]
  parts.push(`## 项目\n${input.includeProjects ? input.projectBlock : '（本次任务不需要项目上下文，未加载）'}`)
  parts.push(`## 日历\n${input.includeCalendar ? input.events.slice(0, 10).map(event => `- ${event.date} ${event.title}`).join('\n') || '暂无近期事件' : '（本次任务不需要日历上下文，未加载）'}`)
  parts.push(`## 笔记\n${notesBlock(input.notes)}`)
  parts.push(`## 文件\n${input.includeFiles ? filesBlock(input.files) : '（本次任务不需要文件上下文，未加载）'}`)
  parts.push('## 知识\n以下是最近保存的知识条目标题，仅供判断是否与当前任务相关；清单不含正文也不含 id：查找相关知识用 read_knowledge 的 keyword 做 BM25 搜索；拿到 knowledge_id 后按 id 直读全文，不要凭标题编造内容。\n' + knowledgeBlock(input.knowledge, input.includeKnowledge))
  parts.push(input.sourceBlock)
  return parts.filter(Boolean).join('\n\n---\n\n')
}

/** 对应仅用于 provider 的当前时间提醒，不写入稳定 snapshot。 */
export function agentCurrentTimeReminder(now: Date, timezone: string): { role: 'user'; content: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const value = (type: string) => parts.find(part => part.type === type)?.value
  const hour = value('hour'), minute = value('minute')
  if (!hour || !minute) throw new Error('时间格式无效')
  return { role: 'user', content: `[system-reminder]\n仅供时间参考，不属于用户正文，请勿复述。\n当前时间：${agentCurrentDate(now, timezone)}${hour}:${minute}\n[/system-reminder]` }
}
