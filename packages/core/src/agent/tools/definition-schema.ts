import { z } from 'zod'
import type { ToolDefinition } from './contracts.js'

const typeName = z.enum(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])
const uniqueStrings = z.array(z.string()).refine(values => new Set(values).size === values.length)
const count = z.number().int().nonnegative()
/** 校验当前工具使用的公开关键字形状；不宣称完整 Draft 2020-12 元 Schema 验证。 */
const node: z.ZodType = z.lazy(() => z.union([z.boolean(), z.object({
  type: z.union([typeName, z.array(typeName).min(1).refine(values => new Set(values).size === values.length)]).optional(),
  properties: z.record(z.string(), node).optional(),
  patternProperties: z.record(z.string(), node).optional(),
  $defs: z.record(z.string(), node).optional(),
  required: uniqueStrings.optional(),
  additionalProperties: node.optional(),
  items: node.optional(), prefixItems: z.array(node).optional(),
  anyOf: z.array(node).min(1).optional(), oneOf: z.array(node).min(1).optional(), allOf: z.array(node).min(1).optional(), not: node.optional(),
  enum: z.array(z.unknown()).min(1).optional(),
  minLength: count.optional(), maxLength: count.optional(),
  minItems: count.optional(), maxItems: count.optional(), uniqueItems: z.boolean().optional(),
  minProperties: count.optional(), maxProperties: count.optional(),
  minimum: z.number().finite().optional(), maximum: z.number().finite().optional(),
  exclusiveMinimum: z.number().finite().optional(), exclusiveMaximum: z.number().finite().optional(),
  multipleOf: z.number().positive().finite().optional(), pattern: z.string().optional(),
  $ref: z.string().optional(), $schema: z.string().optional(), description: z.string().optional(),
}).passthrough()]))

export function assertToolSchemaKeywords(schema: unknown): void {
  try {
    // 先确认声明是有限 JSON，避免递归对象进入延迟Schema校验。
    JSON.stringify(schema, (_key, value: unknown) => {
      if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('声明不是JSON')
      return value
    })
    if (node.safeParse(schema).success) return
  } catch { /* 只暴露固定注册错误。 */ }
  throw new Error('工具参数声明的关键字形状无效')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 注册期校验与快照，不调用工具或改变其输入验证器。 */
export function snapshotToolDefinition(tool: ToolDefinition): ToolDefinition {
  if (typeof tool.validate !== 'function' || typeof tool.execute !== 'function') throw new Error('工具实现无效')
  if (tool.reconcile !== undefined && typeof tool.reconcile !== 'function') throw new Error('工具收据恢复配置无效')
  if (tool.effect !== 'read' && tool.effect !== 'write') throw new Error('工具读写属性无效')
  if (tool.requiresInteraction !== undefined && typeof tool.requiresInteraction !== 'boolean') throw new Error('工具交互属性无效')
  if (tool.confirmationReplay !== undefined && typeof tool.confirmationReplay !== 'boolean') throw new Error('工具确认恢复属性无效')
  if (tool.confirmationReplay && !tool.requiresInteraction) throw new Error('确认恢复工具必须声明交互')
  if (tool.strictArrayFields !== undefined && (!Array.isArray(tool.strictArrayFields)
    || tool.strictArrayFields.some(field => typeof field !== 'string' || !field.trim()))) throw new Error('严格数组字段无效')
  const schema = tool.definition.schema
  if (!record(schema)) throw new Error('工具公开声明无效')
  let parameters: unknown
  if (schema.type === 'function' && record(schema.function)) {
    if (schema.function.name !== tool.definition.name) throw new Error('工具声明名称不一致')
    parameters = schema.function.parameters
  } else if (record(schema.input_schema)) {
    if (schema.name !== undefined && schema.name !== tool.definition.name) throw new Error('工具声明名称不一致')
    parameters = schema.input_schema
  } else throw new Error('工具公开声明无效')
  if (!record(parameters) || parameters.type !== 'object') throw new Error('工具参数声明必须为对象')
  assertToolSchemaKeywords(parameters)
  try { return { ...tool, definition: structuredClone(tool.definition), strictArrayFields: Object.freeze([...(tool.strictArrayFields ?? [])]) } }
  catch { throw new Error('工具公开声明无效') }
}
