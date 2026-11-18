import { strip } from '../../shared/values.js'
import { projectColorKey } from '../../projects/colors.js'
import { dateInputNeedsYear, normalizeDateInput } from './date-input.js'
import { asciiDecimalDigits, decimalDigitPattern } from '../../shared/unicode-decimal.js'
import type { PreparedToolDefinition } from '../models.js'

type Schema = Readonly<Record<string, unknown>>
interface NormalizationState { strict: readonly string[]; adaptations?: string[] }
function adapted(state: NormalizationState, path: string, label: string): void {
  state.adaptations?.push(`${path || 'args'}:${label}`)
}
const decimalInteger = new RegExp(`^[+-]?${decimalDigitPattern}+$`, 'u')
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function schemaTypes(schema: Schema): Set<string> {
  return new Set(typeof schema.type === 'string' ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((value): value is string => typeof value === 'string') : [])
}

function actualType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}
function unionBranch(schema: Schema, input: unknown): unknown {
  if (!Array.isArray(schema.anyOf)) return null
  const branches = schema.anyOf.filter(object)
  const type = actualType(input)
  const matches = branches.filter(branch => {
    const types = schemaTypes(branch)
    return types.has(type) || type === 'number' && typeof input === 'number' && Number.isInteger(input) && types.has('integer')
  })
  if (matches.length === 1) return matches[0]
  // 与 Python string|object 联合类型一致：数值可转string，boolean不可转。
  if (!matches.length && type === 'number') {
    const strings = branches.filter(branch => schemaTypes(branch).has('string'))
    if (strings.length === 1) return strings[0]
  }
  return null
}
function itemPropertyNames(schema: unknown): Set<string> {
  if (!object(schema)) return new Set()
  const own = object(schema.properties) ? Object.keys(schema.properties) : []
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : []
  return new Set([...own, ...branches.flatMap(branch => [...itemPropertyNames(branch)])])
}
function unwrapArray(schema: Schema, input: Record<string, unknown>, state: NormalizationState, field: string, path: string): unknown {
  const fields = itemPropertyNames(schema.items)
  let current: unknown = input
  let changed = false
  for (let depth = 0; depth < 4; depth++) {
    if (!object(current) || Object.keys(current).length !== 1) break
    const key = Object.keys(current)[0]!
    if (!['item', 'block'].includes(key) || fields.has(key)) break
    current = current[key]
    changed = true
  }
  if (!changed) return input
  if (object(current) && Object.keys(current).length === 1) {
    const key = Object.keys(current)[0]!
    if (['item', 'block'].includes(key) && !fields.has(key)) return input
  }
  if (Array.isArray(current)) {
    adapted(state, path, 'item_wrapper_unwrapped')
    return current.map((value, index) => normalizeValue(schema.items, value, field, state, `${path}[${index}]`))
  }
  if (object(current) || ['string', 'number', 'boolean'].includes(typeof current)) {
    adapted(state, path, 'item_wrapper_unwrapped')
    return [normalizeValue(schema.items, current, field, state, `${path}[0]`)]
  }
  return input
}

function normalizeValue(schema: unknown, input: unknown, field: string, state: NormalizationState, path: string): unknown {
  if (!object(schema)) return input
  const branch = unionBranch(schema, input)
  if (branch) return normalizeValue(branch, input, field, state, path)
  const types = schemaTypes(schema)
  if (object(input) && types.has('object') && object(schema.properties)) {
    const result = { ...input }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(input, key)) continue
      const location = path ? `${path}.${key}` : key
      const required = Array.isArray(schema.required) && schema.required.includes(key)
      if (!required && object(child) && typeof input[key] === 'string' && !strip(input[key] as string)) {
        const childTypes = schemaTypes(child)
        if (child['x-empty-string'] === 'omit' && childTypes.size === 1 && childTypes.has('string')) {
          delete result[key]; adapted(state, location, 'empty_omitted'); continue
        }
        if (child['x-empty-string'] === 'empty-array' && childTypes.size === 1 && childTypes.has('array')) {
          result[key] = []; adapted(state, location, 'empty_string_to_array'); continue
        }
      }
      result[key] = normalizeValue(child, input[key], key, state, location)
    }
    return result
  }
  if (Array.isArray(input) && types.has('array'))
    return input.map((value, index) => normalizeValue(schema.items, value, field, state, `${path}[${index}]`))
  if (object(input) && types.size === 1 && types.has('array') && !state.strict.includes(field)) return unwrapArray(schema, input, state, field, path)
  if (typeof input === 'number' && Number.isFinite(input) && types.has('string')
    && !['integer', 'number', 'boolean'].some(type => types.has(type))) {
    adapted(state, path, 'number_to_string')
    return String(input)
  }
  if (typeof input !== 'string') return input
  const text = strip(input)
  if (!text) return input
  if (!types.has('string') && !['boolean', 'integer', 'number'].some(type => types.has(type))
    && (types.has('array') || types.has('object'))) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (types.has(actualType(parsed)) && (Array.isArray(parsed) || object(parsed))) {
        adapted(state, path, `json_string_to_${actualType(parsed)}`)
        return normalizeValue(schema, parsed, field, state, path)
      }
    } catch { /* 无法解析的输入保留，交由原validator拒绝。 */ }
  }
  if (types.has('boolean') && /^(true|false)$/i.test(text)) {
    adapted(state, path, 'string_to_boolean')
    return text.toLowerCase() === 'true'
  }
  if (types.has('integer')) {
    const numeric = field.endsWith('_id') && text.startsWith('#') ? text.slice(1) : text
    if (decimalInteger.test(numeric)) {
      const integer = Number(asciiDecimalDigits(numeric))
      if (Number.isSafeInteger(integer)) {
        adapted(state, path, 'string_to_integer')
        return integer
      }
    }
  }
  return input
}

/** 仅搬回顶层无处安放的元素字段；原对象是调用方副本。 */
function hoistArrayItems(schema: Schema, input: Record<string, unknown>, state: NormalizationState): void {
  if (!object(schema.properties)) return
  const properties = schema.properties
  for (const [field, child] of Object.entries(properties)) {
    if (!object(child) || !schemaTypes(child).has('array') || state.strict.includes(field)) continue
    const current = input[field]
    if (current !== undefined && current !== null && !(typeof current === 'string' && !strip(current))) continue
    if (!object(child.items) || !object(child.items.properties) || !Object.keys(child.items.properties).length) continue
    const itemProperties = child.items.properties
    const extras = Object.keys(input).filter(key => !Object.hasOwn(properties, key))
    if (!extras.length || extras.some(key => !Object.hasOwn(itemProperties, key))) continue
    const item: Record<string, unknown> = {}
    for (const key of extras) { item[key] = input[key]; delete input[key] }
    input[field] = [item]
    adapted(state, field, 'flattened_items_hoisted')
  }
}

function normalizeNoteBlocks(name: string, input: Record<string, unknown>, state: NormalizationState): void {
  function decode(value: unknown): unknown[] | undefined {
    if (typeof value !== 'string') return undefined
    try {
      const decoded: unknown = JSON.parse(value)
      if (Array.isArray(decoded)) return decoded
    } catch { /* 保留原输入供 Schema 拒绝。 */ }
  }
  function normalizeNodes(value: unknown, path: string): unknown {
    if (Array.isArray(value)) return value.map((item, index) => normalizeNodes(item, `${path}[${index}]`))
    if (!object(value)) return value
    const result = { ...value }
    if (Object.hasOwn(result, 'text') && !Object.hasOwn(result, 'type')) {
      result.type = 'text'
      adapted(state, `${path}.type`, 'inferred_text')
    }
    for (const field of ['content', 'items', 'paragraphs']) {
      if (Object.hasOwn(result, field)) result[field] = normalizeNodes(result[field], `${path}.${field}`)
    }
    return result
  }
  if (name === 'note_create' && !Object.hasOwn(input, 'blocks')) {
    const blocks = decode(input.content)
    if (blocks) {
      input.blocks = blocks
      delete input.content
      adapted(state, 'note_create.content', 'json_string_to_blocks')
    }
  }
  for (const field of ['blocks', 'append_blocks']) {
    if (!Object.hasOwn(input, field)) continue
    const blocks = decode(input[field])
    if (blocks) adapted(state, `${name}.${field}`, 'json_string_to_array')
    input[field] = normalizeNodes(blocks ?? input[field], field)
  }
}

/** 仅做已迁移的无歧义标量与容器兼容；随后仍必须经过工具 validator，不授予任何能力。 */
export function normalizeToolInput(definition: PreparedToolDefinition, input: unknown, context: { defaultYear?: number; strictArrayFields?: readonly string[]; adaptations?: string[] } = {}): unknown {
  if (!object(input)) return input
  const wire = definition.schema
  const functionSchema = object(wire.function) ? wire.function.parameters : wire.input_schema
  if (!object(functionSchema)) return input
  const alias: Record<string, string> = {
    create_client: 'client_name', update_client: 'client_name',
    create_project: 'project_name', update_project: 'project_name',
  }
  const state: NormalizationState = { strict: context.strictArrayFields ?? [], adaptations: context.adaptations }
  const properties = object(functionSchema.properties) ? functionSchema.properties : {}
  let unwrapped = input
  // 只解除精确匹配的协议形状，绝不更换已授权的工具名。
  if (functionSchema.additionalProperties === false && !Object.hasOwn(properties, 'tool_name') && !Object.hasOwn(properties, 'arguments')
    && Object.keys(unwrapped).length === 2 && typeof unwrapped.tool_name === 'string' && strip(unwrapped.tool_name) === definition.name && object(unwrapped.arguments)) {
    unwrapped = unwrapped.arguments
    state.adaptations?.push('call_tool_envelope:unwrapped')
  }
  if (Object.keys(unwrapped).length === 1 && !Object.hasOwn(properties, 'arguments') && object(unwrapped.arguments)
    && Object.keys(unwrapped.arguments).some(key => Object.hasOwn(properties, key))) unwrapped = unwrapped.arguments
  const field = alias[definition.name]
  const source = { ...unwrapped }
  // 专属名称字段即使显式为null/空串，也不能被历史name覆盖。
  if (field && object(functionSchema.properties) && Object.hasOwn(functionSchema.properties, field)
    && Object.hasOwn(source, 'name') && !Object.hasOwn(source, field)) {
    source[field] = source.name
    delete source.name
    state.adaptations?.push(`${definition.name}.name:renamed_to_${field}`)
  }
  if ((definition.name === 'create_project' || definition.name === 'set_color') && typeof source.color === 'string') {
    const color = projectColorKey(source.color) ?? source.color
    if (color !== source.color) state.adaptations?.push(`${definition.name}.color:normalized_token`)
    source.color = color
  }
  if (definition.name === 'create_project' || definition.name === 'update_project') {
    for (const field of ['start_date', 'deadline']) if (typeof source[field] === 'string') {
      const explicit = normalizeDateInput(source[field])
      const canonical = explicit ?? (dateInputNeedsYear(source[field]) ? normalizeDateInput(source[field], context.defaultYear) : null) ?? source[field]
      if (canonical !== source[field]) state.adaptations?.push(`${definition.name}.${field}:normalized_date`)
      source[field] = canonical
    }
  }
  if (definition.name === 'note_create' || definition.name === 'note_update') normalizeNoteBlocks(definition.name, source, state)
  hoistArrayItems(functionSchema, source, state)
  return normalizeValue(functionSchema, source, '', state, '')
}
