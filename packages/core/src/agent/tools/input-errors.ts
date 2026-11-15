import type { PreparedToolDefinition, ToolResult } from '../models.js'

type Schema = Record<string, unknown>
interface Issue { path: string; rule: string; message: string }
function object(value: unknown): value is Schema { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function types(schema: Schema): string[] { return typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((value): value is string => typeof value === 'string') : [] }
function hasType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return object(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}
function issue(path: string, rule: string, schema: Schema): Issue {
  const messages: Record<string, string> = {
    required: `缺少必填字段 ${path.split('.').at(-1)}`,
    type: `字段类型应为 ${types(schema).join(' / ') || 'object'}`,
    enum: '字段不在允许范围内', additionalProperties: '包含 schema 未允许的额外字段', pattern: '字段格式不符合要求',
    minimum: `字段不能小于 ${schema.minimum}`, maximum: `字段不能大于 ${schema.maximum}`,
    minLength: `字段长度不能小于 ${schema.minLength}`, maxLength: `字段长度不能大于 ${schema.maxLength}`,
    minItems: `数组元素数量不能少于 ${schema.minItems}`, maxItems: `数组元素数量不能多于 ${schema.maxItems}`,
  }
  return { path: path || '$', rule, message: messages[rule] ?? `字段不符合工具输入约束（${rule}）` }
}
function parameters(tool: PreparedToolDefinition): Schema {
  const fn = tool.schema.function
  return object(fn) && object(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
}
function branches(schema: Schema, value: unknown): Schema {
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (!alternatives) return schema
  const valid = alternatives.filter(object)
  const matching = valid.find(branch => types(branch).some(type => hasType(value, type)))
  return matching ? { ...schema, ...matching, anyOf: undefined, oneOf: undefined } : { ...schema, type: [...new Set(valid.flatMap(types))], anyOf: undefined, oneOf: undefined }
}
/** 仅投影已失败输入的公开规则，不作为第二套 dispatch validator。 */
function publicIssues(schema: Schema, value: unknown, path = '', depth = 0): Issue[] {
  if (depth > 24) return [issue(path, 'invalid', schema)]
  const selected = branches(schema, value), expected = types(selected)
  if (expected.length && !expected.some(type => hasType(value, type))) return [issue(path, 'type', selected)]
  const out: Issue[] = []
  if (Array.isArray(selected.enum) && !selected.enum.some(item => Object.is(item, value))) out.push(issue(path, 'enum', selected))
  if (typeof value === 'string') {
    const size = [...value].length
    if (typeof selected.minLength === 'number' && size < selected.minLength) out.push(issue(path, 'minLength', selected))
    if (typeof selected.maxLength === 'number' && size > selected.maxLength) out.push(issue(path, 'maxLength', selected))
    if (typeof selected.pattern === 'string') {
      try { if (!new RegExp(selected.pattern, 'u').test(value)) out.push(issue(path, 'pattern', selected)) } catch { /* 公开schema的注册期完整校验尚待迁移；本层不展示原始异常。 */ }
    }
  }
  if (typeof value === 'number') {
    if (typeof selected.minimum === 'number' && value < selected.minimum) out.push(issue(path, 'minimum', selected))
    if (typeof selected.maximum === 'number' && value > selected.maximum) out.push(issue(path, 'maximum', selected))
  }
  if (Array.isArray(value)) {
    if (typeof selected.minItems === 'number' && value.length < selected.minItems) out.push(issue(path, 'minItems', selected))
    if (typeof selected.maxItems === 'number' && value.length > selected.maxItems) out.push(issue(path, 'maxItems', selected))
    if (selected.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) out.push(issue(path, 'uniqueItems', selected))
    if (object(selected.items)) for (let index = 0; index < value.length; index++) out.push(...publicIssues(selected.items, value[index], path ? `${path}.${index}` : String(index), depth + 1))
  }
  if (object(value)) {
    const properties = object(selected.properties) ? selected.properties : {}
    if (Array.isArray(selected.required)) for (const key of selected.required) {
      if (typeof key === 'string' && Object.hasOwn(properties, key) && !Object.hasOwn(value, key)) out.push(issue(path ? `${path}.${key}` : key, 'required', {}))
    }
    if (selected.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) out.push(issue(path, 'additionalProperties', selected))
    for (const [key, child] of Object.entries(properties)) if (object(child) && Object.hasOwn(value, key)) out.push(...publicIssues(child, value[key], path ? `${path}.${key}` : key, depth + 1))
  }
  return out
}
/** Zod path必须沿公开属性/数组遍历；未知键只返回已验证的父路径。 */
function safeLocation(schema: Schema, input: unknown, path: unknown): { path: string; schema: Schema; value: unknown } {
  let current = schema, value = input
  const parts: (string | number)[] = []
  if (Array.isArray(path)) for (const part of path) {
    current = branches(current, value)
    if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && Array.isArray(value) && part < value.length && object(current.items)) {
      parts.push(part); current = current.items; value = value[part]
    } else if (typeof part === 'string' && object(current.properties) && Object.hasOwn(current.properties, part) && object(current.properties[part])) {
      parts.push(part); current = current.properties[part]; value = object(value) ? value[part] : undefined
    } else break
  }
  return { path: parts.join('.'), schema: branches(current, value), value }
}
function projectedIssues(schema: Schema, input: unknown, error?: unknown): Issue[] {
  if (!object(input)) return [{ path: '$', rule: 'type', message: '工具输入必须是 object' }]
  const out = publicIssues(schema, input)
  // 未公开的领域refine只使用固定规则名；不读取message、input、keys或原始异常。
  if (!out.length && object(error) && Array.isArray(error.issues)) for (const entry of error.issues) {
    if (!object(entry)) continue
    const location = safeLocation(schema, input, entry.path)
    const code = entry.code
    let rule = 'invalid'
    if (code === 'invalid_type') rule = location.value === undefined ? 'required' : 'type'
    else if (code === 'unrecognized_keys') rule = 'additionalProperties'
    else if (code === 'invalid_value' && Array.isArray(location.schema.enum)) rule = 'enum'
    else if (code === 'invalid_format' && typeof location.schema.pattern === 'string') rule = 'pattern'
    else if (code === 'invalid_union') rule = 'anyOf'
    out.push(issue(location.path, rule, location.schema))
  }
  if (!out.length) out.push(issue('', 'invalid', schema))
  const sorted = out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  return sorted.filter((item, index) => !sorted.slice(0, index).some(previous => previous.path === item.path && previous.rule === item.rule && previous.message === item.message)).slice(0, 5)
}
function hints(schema: Schema, issues: Issue[], input: unknown): string[] {
  const properties = object(schema.properties) ? schema.properties : {}
  const result: string[] = []
  for (const item of issues) {
    if (!['type', 'enum'].includes(item.rule) || item.path.includes('.')) continue
    const field = properties[item.path]
    if (!object(field)) continue
    const expected = field.type
    if (item.rule === 'enum' && Array.isArray(field.enum)) result.push(`${item.path} 必须是允许的枚举值：${field.enum.join('、')}。不要传视觉描述或 CSS 值。`)
    else if (expected === 'array') {
      const example = object(field.items) && Array.isArray(field.items.enum) && field.items.enum.length ? JSON.stringify([field.items.enum[0]]) : '[]'
      result.push(`${item.path} 必须是数组，例如 ${example}；不要传对象。`)
    } else if (expected === 'object') result.push(`${item.path} 必须是对象（{...}），不要传数组或字符串。`)
    else if (expected === 'boolean') result.push(`${item.path} 必须是 boolean：使用 true 或 false，不要加引号。`)
    else if (expected === 'string') {
      const bool = object(input) && typeof input[item.path] === 'boolean' ? input[item.path] : null
      result.push(bool !== null ? `${item.path} 必须是字符串；当前传入的是 boolean，请改为带双引号的 "${bool}"，不要传裸 true/false。` : `${item.path} 必须是字符串（JSON string），文本需用双引号；不要传数值或布尔值。`)
    } else if (expected) result.push(`${item.path} 必须是 ${Array.isArray(expected) ? expected.join(' / ') : expected} 类型。`)
  }
  return result
}

/** Python invalid_input_payload的当前已迁移工具投影，不包含原始输入或Zod异常。 */
export function invalidInputResult(tool: PreparedToolDefinition, input: unknown, error?: unknown): ToolResult {
  const schema = parameters(tool), issues = projectedIssues(schema, input, error)
  const missing = issues.filter(item => item.rule === 'required').map(item => item.path)
  const payload: Record<string, unknown> = {
    error: 'tool_input_invalid', tool: tool.name, issues,
    _schema_recovery: { needed: true, reason: 'validation_error' },
    usage_hint: '参数不符合工具 schema。先按 issues 修正；缺少无法从上下文确定的必填信息时，先向用户询问。',
    next_action: missing.length ? `请补齐必填字段：${missing.join('、')}。如果当前对话没有提供且无法可靠推断，请先向用户询问，不要提交空参数重试。` : '请根据 issues 修正参数后再调用；不要重复提交相同参数，也不要猜测用户未提供的值。',
  }
  const repair = hints(schema, issues, input)
  if (tool.name === 'create_project' && issues.some(item => item.path.split('.')[0] === 'stages')) {
    repair.push('stages 使用名称数组 ["开发","上线"]，或对象数组 [{"label":"开发","todos":["接口"]}]；重排现有阶段可带 key。', '请使用扁平数组，不要嵌套数组或继续添加 item/block 包装；保留全部待处理项。')
    payload.next_action = '请按 schema_hints 重建报错数组后再调用；不要重复提交相同参数。'
  }
  const properties = object(schema.properties) ? schema.properties : {}
  if (issues.some(item => { const field = properties[item.path]; return item.rule === 'type' && object(field) && field.type === 'string' && object(input) && typeof input[item.path] === 'boolean' })) payload.next_action = '请按 schema_hints 把布尔值改成对应的字符串后重试，不要再次传入裸 true/false。'
  if (repair.length) payload.schema_hints = repair
  return { kind: 'completed', value: payload, successful: false, mutated: false, executed: false }
}

/** 保留业务对象/JSON字符串原类型与原字段，不修改列表或未知提交状态。 */
export function enrichToolError(toolName: string, value: unknown): unknown {
  function enrich(payload: Schema): Schema {
    if (!payload.error) return payload
    const out = { ...payload }
    if (!Object.hasOwn(out, 'tool')) out.tool = toolName
    const unknown = typeof out.error === 'string' && (out.error.startsWith('未知工具') || out.error === 'unknown_tool')
    if (!Object.hasOwn(out, 'usage_hint')) out.usage_hint = unknown ? '工具名是调用协议标识，必须来自本轮提供的工具列表；业务名称应放在工具参数中。' : '工具执行失败。先根据错误信息判断下一步；需要用户补充信息时先询问，不要重复提交相同参数。'
    if (!Object.hasOwn(out, 'next_action')) out.next_action = unknown ? '请按本轮工具列表选择已声明的工具名，并依据该工具 Schema 将业务参数放入 arguments；不要把任务名、对象名称或参数对象当作工具名，也不要原样重试。' : '根据错误信息修正或向用户询问缺失信息；确认没有新信息前不要盲目重试。'
    return out
  }
  if (object(value)) return enrich(value)
  if (typeof value === 'string' && value.trimStart().startsWith('{"error"')) {
    try { const parsed: unknown = JSON.parse(value); if (object(parsed)) return JSON.stringify(enrich(parsed)) } catch { /* 保留非JSON原结果。 */ }
  }
  return value
}
