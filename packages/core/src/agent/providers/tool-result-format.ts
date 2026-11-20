import type { CanonicalMessage, Json } from '../models.js'

const tools = new Map([
  ['get_project', '项目详情'],
  ['list_projects', '项目列表'],
  ['global_search', '站内全局搜索'],
  ['shell', 'Shell 命令'],
])
const labels: Readonly<Record<string, string>> = {
  id: 'ID', name: '名称', status: '状态', priority: '优先级', summary: '项目摘要',
  client: '客户', start_date: '开始日期', deadline: '截止日期', color: '颜色',
  current_stage: '当前阶段', archived: '已归档', stages_done: '已完成阶段数', stages_total: '阶段总数',
  stages: '项目阶段', key: '阶段键', label: '标签', done: '已完成', todos: '待办', text: '正文',
  files: '文件统计', total_file_count: '文件总数', root_file_count: '根目录文件数',
  total_folder_count: '文件夹总数', sandbox_path: '沙箱路径',
  query: '搜索词', queries: '关键词', mode: '匹配模式', total: '命中数', groups: '结果分组',
  type: '类型', source_type: '来源类型', items: '命中条目', note: '说明', title: '标题', subtitle: '补充信息', date: '日期', snippet: '摘要片段',
  ok: '执行成功', cwd: '工作目录', scope: '执行范围', network_access: '网络权限',
  exit_code: '退出码', timed_out: '已超时', truncated: '输出已截断',
  stdout: '标准输出', stderr: '标准错误', error: '原因', code: '错误码', message: '说明',
  ignored_fields: '忽略字段', hint: '提示', unavailable_types: '不可用来源',
}
const incomplete = new Map([
  ['deferred', '暂缓执行'], ['waiting', '等待回复'], ['unknown', '结果未确认'],
  ['cancelled', '已取消'], ['error', '失败'],
])

function object(value: Json): Record<string, Json> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function render(value: Json, indent = '', project = false): string[] {
  if (Array.isArray(value)) return value.length
    ? value.flatMap((item, index) => [`${indent}- 第 ${index + 1} 项`, ...render(item, indent + '  ', project)])
    : [`${indent}（无条目）`]
  const fields = object(value)
  if (!fields) return [`${indent}${value === null ? '未设置（null）' : String(value)}`]
  if (!Object.keys(fields).length) return [`${indent}（无字段）`]
  return Object.entries(fields).flatMap(([key, field]) => {
    const label = project && ['id', 'name', 'status'].includes(key)
      ? `项目${labels[key]}` : Object.hasOwn(labels, key) ? labels[key] : key
    const prefix = `${indent}【${label}】`
    if (key === 'stdout' || key === 'stderr' || typeof field === 'string' && /[\r\n]/u.test(field)) {
      if (typeof field !== 'string') return [prefix, ...render(field, indent + '  ')]
      let fenceLength = 3
      for (const match of field.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
      const fence = '`'.repeat(fenceLength)
      return [prefix, fence + '\n' + field + (field.endsWith('\n') ? '' : '\n') + fence]
    }
    if (field !== null && typeof field === 'object') return [prefix, ...render(field, indent + '  ')]
    return [prefix + (field === null ? '未设置（null）' : field === '' ? '（空字符串）' : String(field))]
  })
}

export function formatToolResult(name: string, content: string, isError: boolean): string {
  const title = tools.get(name)
  if (!title) return content
  let value: Json
  try { value = JSON.parse(content) as Json } catch { return content }
  const fields = object(value)
  const status = isError ? incomplete.get(String(fields?.status)) ?? '失败' : '成功'
  const summary = !isError && name === 'get_project' && typeof fields?.name === 'string' && !/[\r\n]/u.test(fields.name) ? `找到项目「${fields.name}」`
    : !isError && name === 'list_projects' && Array.isArray(value) ? `返回 ${value.length} 个项目`
      : !isError && name === 'global_search' && typeof fields?.total === 'number' ? `命中 ${fields.total} 项` : undefined
  return [`【工具结果】${title}（${name}）`, `【执行状态】${status}`, ...(summary ? [`【摘要】${summary}`] : []),
    ...render(value, '', name === 'get_project' || name === 'list_projects')].join('\n')
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
