import type { CapabilityCatalog, Json, PreparedToolDefinition, RunCapabilities } from '../models.js'
import { normalizePreferenceResponse, readPreferenceDocument } from '../../preferences/general.js'
import { createCapabilityCatalog } from './catalog.js'

function record(value: Json | undefined): Record<string, Json> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function fields(schema: Record<string, Json>): [string, Json][] {
  return Object.entries(record(schema.properties) ?? {})
}

function fieldType(value: Json | undefined, depth = 0): string {
  const schema = record(value)
  if (!schema) return 'unknown'
  if (depth < 2 && schema.type === 'array' && record(schema.items))
    return `array<${fieldType(schema.items, depth + 1)}>`
  if (depth < 2 && schema.type === 'object') {
    const children = fields(schema).map(([name, child]) => `${name}:${fieldType(child, depth + 1)}`)
    return children.length ? `object:${children.join(',')}` : 'object'
  }
  if (typeof schema.type === 'string') {
    const values = schema.enum
    if (Array.isArray(values) && values.length > 0 && values.length <= 8
      && values.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
      const choices = values.join('|')
      if (choices.length <= 140) return `${schema.type}[${choices}]`
    }
    return schema.type
  }
  const alternatives = schema.anyOf ?? schema.oneOf
  if (depth < 2 && Array.isArray(alternatives) && alternatives.length)
    return [...new Set(alternatives.map(item => fieldType(item, depth + 1)))].join('|')
  return 'unknown'
}

/** 从运行时实际使用的 Schema 生成提示词字段签名。 */
function toolFieldSignature(parameters: Json | undefined): string {
  const schema = record(parameters)
  if (!schema) return ''
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const signature = fields(schema).map(([name, value]) =>
    `${name}(${fieldType(value)})${required.has(name) ? ',必填' : ''}`).join('、')
  const hasBranches = Array.isArray(schema.allOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || schema.if !== undefined
  return [signature, hasBranches ? '条件约束请读取完整 Schema' : ''].filter(Boolean).join('；')
}

export function createAgentToolBrief(preferences: unknown, tools: readonly PreparedToolDefinition[], userSkills: readonly Json[] = []): CapabilityCatalog {
  const { toolInjectionMode } = normalizePreferenceResponse(readPreferenceDocument(preferences),
    { replyStyle: null, personality: null, groupPersonality: null }, false)
  if (toolInjectionMode !== 'description') return { metadataOnly: true, toolCatalog: '', skillCatalog: '', userSkills }

  const hasSearch = tools.some(tool => tool.name === 'search_tools')
  const brief = tools.filter(tool => tool.name !== 'choose_no_reply').map(tool => {
    const schema = record(tool.schema.function) ?? tool.schema
    const description = typeof schema.description === 'string' && schema.description.trim() ? schema.description : tool.name
    return { name: tool.name, description, fields: toolFieldSignature(schema.parameters ?? schema.input_schema) }
  })
  const descriptions = createCapabilityCatalog({ tools: brief, skills: [] }).tools
  const lines = descriptions.map((tool, index) => {
    const fields = brief[index]?.fields
    return `- \`${tool.name}\`：${tool.description_short}${fields ? `；字段：${fields}` : ''}`
  })
  return {
    fixedAdapter: true, metadataOnly: false, skillCatalog: '', userSkills,
    toolCatalog: [
      '## 当前可用工具简介',
      '逐字使用当前目录的工具名，通过 call_tool 传入 tool_name 和 arguments。已有当前版本的 Schema 时直接复用。',
      ...(hasSearch ? ['不确定该用哪个工具时，用 search_tools 的 query 按用途查找。已知名称、需要完整参数定义时，用 names 查询。'] : []),
      ...lines,
    ].join('\n'),
  }
}

/** 简介模式保留固定入口，原始 Schema 仍可由运行时查询。 */
export function projectAgentToolBrief(catalog: CapabilityCatalog | null, names: readonly string[], shellReminder?: string): Pick<RunCapabilities, 'providerToolNames' | 'toolReminder'> {
  if (!catalog?.fixedAdapter) return catalog?.mcpReminder ? { toolReminder: catalog.mcpReminder } : {}
  const providerToolNames = ['call_tool', 'search_tools', 'use_skill', 'ask_user', 'stop_recurring', 'choose_no_reply', 'shell', 'agent_message', 'agent_wait', 'agent_cancel', 'agent_inspect']
    .filter(name => names.includes(name))
  const toolReminder = [catalog.toolCatalog, shellReminder, catalog.mcpReminder].filter(Boolean).join('\n\n')
  return { providerToolNames, ...(toolReminder ? { toolReminder } : {}) }
}
