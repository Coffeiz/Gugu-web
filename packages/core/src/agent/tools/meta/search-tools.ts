import type { Json, PreparedToolDefinition } from '../../models.js'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const synonyms = [
  ['create', 'add', 'schedule', '创建', '新建', '添加', '安排'],
  ['list', 'browse', '列出', '浏览'],
  ['search', 'find', '搜索', '查找', '检索'],
  ['update', 'edit', '修改', '更新', '编辑'],
  ['delete', 'remove', '删除', '移除'],
  ['calendar', 'event', 'events', 'meeting', '日历', '日程', '活动', '事件', '会议'],
  ['file', 'files', 'document', '文件', '文档'],
  ['note', 'notes', '笔记', '便签'],
  ['canvas', '画布'],
  ['client', 'clients', 'contact', 'contacts', '联系人', '客户'],
  ['task', 'tasks', '任务', '待办'],
  ['shell', 'terminal', '终端', '命令'],
]
const simpleTypes = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const summaryMetadata = new Set(['type', 'title', 'description', 'default', 'examples', '$comment'])
const rootMetadata = new Set([...summaryMetadata, '$schema', 'properties', 'required', 'additionalProperties'])
const maxFields = 24

function record(value: Json | undefined): Record<string, Json> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function tokens(value: string): Set<string> {
  return new Set([...segmenter.segment(value.normalize('NFKC').toLowerCase().replaceAll('_', ' '))]
    .filter(word => word.isWordLike).map(word => word.segment))
}

function publicDefinition(tool: PreparedToolDefinition) {
  return record(tool.schema.function) ?? tool.schema
}

/** 扁平摘要仅用于选择工具，实际执行仍按工具定义校验。 */
export function summarizeTool(tool: PreparedToolDefinition) {
  const definition = publicDefinition(tool)
  const schema = record(definition.parameters ?? definition.input_schema)
  const fields = Object.entries(record(schema?.properties) ?? {})
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const parameters = fields.slice(0, maxFields).map(([name, value]) => {
    const field = record(value)
    const type = typeof field?.type === 'string' ? field.type : 'unknown'
    return { name, type, required: required.has(name) }
  })
  const requiresFullSchema = !schema || schema.type !== 'object' || fields.length > maxFields
    || record(schema.additionalProperties) !== undefined
    || Object.keys(schema).some(key => !rootMetadata.has(key))
    || fields.some(([, value]) => {
      const field = record(value)
      return !field || typeof field.type !== 'string' || !simpleTypes.has(field.type)
        || Object.keys(field).some(key => !summaryMetadata.has(key))
    })
  return {
    name: tool.name,
    description: typeof definition.description === 'string'
      ? definition.description.replace(/\s+/gu, ' ').trim().slice(0, 160) : '',
    parameters,
    requires_full_schema: requiresFullSchema,
  }
}

/** 在调用方提供的当前授权目录内做确定性排序。 */
export function rankToolSearch(query: string, available: readonly PreparedToolDefinition[], limit: number): PreparedToolDefinition[] {
  const exact = available.find(tool => tool.name.toLowerCase() === query.normalize('NFKC').toLowerCase())
  if (exact) return [exact]
  const terms = [...tokens(query)].map(term => ({ term, aliases: synonyms.find(group => group.includes(term)) ?? [] }))
  const canvasIntent = terms.some(({ aliases }) => aliases.includes('canvas'))
  const noteIntent = !canvasIntent && terms.some(({ aliases }) => aliases.includes('note'))
  return available.map(tool => {
    const definition = publicDefinition(tool)
    const name = tokens(tool.name)
    const description = tokens(typeof definition.description === 'string' ? definition.description : '')
    const score = terms.reduce((total, { term, aliases }) => total
      + (name.has(term) ? 10 : aliases.some(alias => name.has(alias)) ? 6 : 0)
      + (description.has(term) ? 4 : aliases.some(alias => description.has(alias)) ? 2 : 0), 0)
    const domainMatch = (canvasIntent && tool.name.startsWith('canvas_')) || (noteIntent && tool.name.startsWith('note_'))
    const domainMismatch = noteIntent && tool.name.startsWith('canvas_')
    return { tool, score: score > 0 ? score + (domainMatch ? 12 : 0) - (domainMismatch ? 12 : 0) : 0 }
  }).filter(match => match.score > 0).sort((left, right) => right.score - left.score)
    .slice(0, limit).map(match => match.tool)
}
