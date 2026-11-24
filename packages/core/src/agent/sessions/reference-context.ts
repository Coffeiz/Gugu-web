export type AgentReferenceType = 'project' | 'file' | 'folder' | 'event' | 'canvas_note' | 'conversation' | 'skill' | 'mcp' | 'scheduled_task'

export type AgentObjectRef = { kind: AgentReferenceType; id: string | number }
export type ResolvedObjectPath = { kind: 'sandbox' | 'host_absolute'; value: string }

const labels: Record<AgentReferenceType, string> = {
  project: '项目', file: '文件', folder: '文件夹', event: '日程', canvas_note: '画布便签',
  conversation: '对话', skill: '技能', mcp: 'MCP 服务', scheduled_task: '定时任务',
}

/** @ 引用使用统一字段包裹；JSON 字符串化可避免对象字段中的换行伪造新字段。 */
export function formatAgentReferenceBlock(
  object: AgentObjectRef,
  fields: Readonly<Record<string, unknown>>,
  location?: ResolvedObjectPath,
): string {
  if (location) fields = { ...fields, 路径: location.value, 路径类型: location.kind }
  const lines = [`【引用对象】`, `【类型】${labels[object.kind]}`, `【ID】${JSON.stringify(object.id)}`]
  for (const [label, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const encoded = JSON.stringify(value)
    if (encoded !== undefined) lines.push(`【${label}】${encoded}`)
  }
  lines.push('【/引用对象】')
  return lines.join('\n')
}
