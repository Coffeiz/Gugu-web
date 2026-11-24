import { canonicalAgentToolName } from '../tools/configuration.js'
import type { CanonicalMessage, Json } from '../models.js'

const projectTools = new Map([
  ['get_project', '项目详情'],
  ['list_projects', '项目列表'],
  ['create_project', '新建项目'],
  ['update_project', '更新项目'],
  ['archive_project', '归档项目'],
  ['delete_project', '删除项目'],
  ['set_color', '设置项目颜色'],
  ['add_stage', '添加项目阶段'],
  ['remove_stage', '移除项目阶段'],
  ['rename_stage', '重命名项目阶段'],
  ['set_stages', '设置项目阶段'],
  ['update_stage', '更新项目阶段'],
])
const calendarTools = new Map([
  ['get_upcoming', '近期事项'],
  ['get_current_time', '获取当前时间'],
  ['list_events', '查询日历事件'],
  ['create_event', '新建日历事件'],
  ['update_event', '更新日历事件'],
  ['delete_event', '删除日历事件'],
])
const tools = new Map([
  ['global_search', '站内全局搜索'],
  ['shell', 'Shell 命令'],
  ['list_contacts', '联系人列表'],
  ['create_contact', '新建联系人'],
  ['update_contact', '更新联系人'],
  ['delete_contact', '删除联系人'],
])
const labels: Readonly<Record<string, string>> = {
  id: 'ID', name: '名称', status: '状态', priority: '优先级', summary: '项目摘要',
  contact: '联系人姓名', contact_id: '联系人 ID', client_id: '联系人 ID', deleted_client_id: '已删除的联系人 ID',
  client: '联系人', start_date: '开始日期', deadline: '截止日期', color: '颜色',
  current_stage: '当前阶段', archived: '已归档', stages_done: '已完成阶段数', stages_total: '阶段总数',
  stages: '项目阶段', key: '阶段键', label: '标签', done: '已完成', todos: '待办', text: '正文',
  files: '文件统计', total_file_count: '文件总数', root_file_count: '根目录文件数',
  total_folder_count: '文件夹总数', location: '文件位置', kind: '路径类型', value: '路径',
  query: '搜索词', queries: '关键词', mode: '匹配模式', total: '命中数', groups: '结果分组',
  type: '类型', source_type: '来源类型', items: '命中条目', note: '说明', title: '标题', subtitle: '补充信息', date: '日期', snippet: '摘要片段',
  ok: '执行成功', cwd: '工作目录', scope: '执行范围', network_access: '网络权限',
  exit_code: '退出码', timed_out: '已超时', truncated: '输出已截断',
  stdout: '标准输出', stderr: '标准错误', error: '原因', code: '错误码', message: '说明',
  ignored_fields: '忽略字段', hint: '提示', unavailable_types: '不可用来源',
}
const projectLabels: Readonly<Record<string, string>> = {
  id: '项目 ID', event_id: '事件 ID', project_id: '项目 ID', name: '项目名称', status: '项目状态',
  success: '操作成功', stage_details: '阶段详情', stage_key: '阶段键', todo_count: '待办数量',
  stage: '所属阶段', todo: '待办', todo_id: '待办 ID', remaining_stages: '剩余阶段', removed: '已移除阶段',
  results: '操作结果', action: '操作', available: '可用阶段', candidates: '候选待办',
  added: '已添加待办', new_text: '新待办内容', to_stage: '目标阶段',
  available_projects: '候选项目', current_stage_key: '当前阶段键',
  _schema_recovery: '参数修正', issues: '参数问题', path: '字段路径', rule: '校验规则', schema_hints: '参数提示',
  deleted_count: '删除数量', idempotent_replay: '复用已有执行结果',
}
const calendarLabels: Readonly<Record<string, string>> = {
  id: '事件 ID', event_id: '事件 ID', project_id: '项目 ID', deleted_event_id: '已删除的事件 ID',
  time: '时间', end_time: '结束时间', weekday: '星期', datetime: '日期时间', timezone: '时区',
  description: '描述', reminders: '提醒', lead_minutes: '提前分钟数', channels: '提醒渠道',
  enabled: '已启用', delivery_mode: '投递方式', deleted_reminders: '已删除的提醒',
  success: '操作成功', results: '操作结果', deleted_count: '删除数量', candidates: '候选事件',
  idempotent_replay: '复用已有执行结果',
  _schema_recovery: '参数修正', issues: '参数问题', path: '字段路径', rule: '校验规则', schema_hints: '参数提示',
}
const incomplete = new Map([
  ['deferred', '暂缓执行'], ['waiting', '等待回复'], ['unknown', '结果未确认'],
  ['cancelled', '已取消'], ['partial', '部分成功'], ['error', '失败'],
])

function object(value: Json): Record<string, Json> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function render(value: Json, indent = '', fieldLabels: Readonly<Record<string, string>> = labels): string[] {
  if (Array.isArray(value)) return value.length
    ? value.flatMap((item, index) => [`${indent}- 第 ${index + 1} 项`, ...render(item, indent + '  ', fieldLabels)])
    : [`${indent}（无条目）`]
  const fields = object(value)
  if (!fields) return [`${indent}${value === null ? '未设置（null）' : String(value)}`]
  if (!Object.keys(fields).length) return [`${indent}（无字段）`]
  return Object.entries(fields).flatMap(([key, field]) => {
    const projectKey = fieldLabels === projectLabels && key === 'id' && Object.hasOwn(fields, 'text') ? 'todo_id' : key
    const label = Object.hasOwn(fieldLabels, projectKey)
      ? fieldLabels[projectKey] : Object.hasOwn(labels, key) ? labels[key] : key
    const prefix = `${indent}[${label}]`
    if (key === 'stdout' || key === 'stderr' || typeof field === 'string' && /[\r\n]/u.test(field)) {
      if (typeof field !== 'string') return [prefix, ...render(field, indent + '  ', fieldLabels)]
      let fenceLength = 3
      for (const match of field.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
      const fence = '`'.repeat(fenceLength)
      return [prefix, fence + '\n' + field + (field.endsWith('\n') ? '' : '\n') + fence]
    }
    if (field !== null && typeof field === 'object') return [prefix, ...render(field, indent + '  ', fieldLabels)]
    return [prefix + (field === null ? '未设置（null）' : field === '' ? '（空字符串）' : String(field))]
  })
}

const upcomingKinds: Readonly<Record<string, string>> = {
  project_deadline: '项目截止', event: '日程', deadline: '截止事项',
}

function renderUpcoming(items: Json[]): string[] {
  const groups = new Map<string, string[]>()
  for (const item of items) {
    const fields = object(item)
    if (!fields || typeof fields.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(fields.date)) return render(items)
    const { date, kind, title, project_id, event_id, ...details } = fields
    if (typeof title !== 'string' || typeof kind !== 'string') return render(items, '', projectLabels)
    const type = Object.hasOwn(upcomingKinds, kind) ? upcomingKinds[kind] : kind
    const metadata = [type]
    if (typeof project_id === 'number') metadata.push(`项目 ID ${project_id}`)
    if (typeof event_id === 'number') metadata.push(`事件 ID ${event_id}`)
    const entries = groups.get(date) ?? []
    entries.push(`- ${title.replace(/[\r\n]+/gu, ' ')}（${metadata.join(' · ')}）`)
    if (Object.keys(details).length) entries.push(...render(details, '  ', projectLabels))
    groups.set(date, entries)
  }
  if (!groups.size) return ['[事项]所选日期范围内暂无事项']
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).flatMap(([date, entries]) => [
    '', `[${date}]`, ...entries,
  ])
}

export function formatToolResult(name: string, content: string, isError: boolean): string {
  name = canonicalAgentToolName(name)
  const projectTitle = projectTools.get(name)
  const calendarTitle = calendarTools.get(name)
  const title = projectTitle ?? calendarTitle ?? tools.get(name)
  if (!title) return content
  let value: Json
  try { value = JSON.parse(content) as Json } catch { return content }
  const fields = object(value)
  const status = isError ? incomplete.get(String(fields?.status)) ?? '失败' : '成功'
  const header = `[工具结果]${title}（${name}）`
  if (name === 'get_upcoming' && !isError && Array.isArray(fields?.items)) {
    const { from, to, items } = fields
    const range = [from, to].every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date))
      ? ` · ${from} → ${to}` : ''
    return [`${header} · ${status} · ${items.length} 项${range}`, ...renderUpcoming(items)].join('\n')
  }
  if (projectTitle || calendarTitle) {
    const fieldLabels = projectTitle ? projectLabels : calendarLabels
    const reason = fields?.error === 'tool_input_invalid' ? '参数不符合要求' : fields?.error
    const summary = status === '失败' && typeof reason === 'string' && reason.length <= 32 && !/[\r\n]/u.test(reason) ? reason
      : !isError && (name === 'list_projects' || name === 'list_events') && Array.isArray(value) ? `${value.length} 项` : undefined
    const heading = [header, status, summary].filter(Boolean).join(' · ')
    if (isError && fields && summary !== undefined && fields.error === summary) {
      const { error, ...details } = fields
      return [heading, ...(Object.keys(details).length ? render(details, '', fieldLabels) : [])].join('\n')
    }
    return [heading, ...render(value, '', fieldLabels)].join('\n')
  }
  if (name === 'shell' && Array.isArray(fields?.movedToTrash) && Array.isArray(fields?.failed)) {
    const { summary, ...details } = fields
    return [header, `[执行状态]${status}`, ...(typeof summary === 'string' ? [`[摘要]${summary}`] : []),
      ...render(details, '', { ...labels, movedToTrash: '已移入废纸篓', failed: '未移入废纸篓', cancelled: '已取消' })].join('\n')
  }
  const summary = !isError && name === 'global_search' && typeof fields?.total === 'number' ? `命中 ${fields.total} 项` : undefined
  return [header, `[执行状态]${status}`, ...(summary ? [`[摘要]${summary}`] : []), ...render(value)].join('\n')
}

/** 只改变模型投影中的文本，保留历史 JSON、原生媒体块和工具调用关联。 */
export function formatToolResults(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message
    return { ...message, content: message.content.map(value => {
      const block = object(value)
      if (block?.type !== 'tool_result' || typeof block.tool_name !== 'string' || typeof block.content !== 'string') return value
      const content = formatToolResult(block.tool_name, block.content, block.is_error === true)
      return content === block.content ? value : { ...block, content }
    }) }
  })
}
