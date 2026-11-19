import { z } from 'zod'
import { pythonQueryBoolean } from '../../http/python-query.js'

export const previewSchema = z.object({
  provider: z.string().min(1).max(64),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  ollama_api_mode: z.string().default('openai'),
  ollama_mode: z.string().default('local'),
  local_runtime: z.string().default('other'),
})

export type PreviewInput = z.infer<typeof previewSchema>

const bool = z.preprocess(value => {
  if (value === 0 || value === 1) return Boolean(value)
  try { return pythonQueryBoolean(value) } catch { return value }
}, z.boolean())

const integer = z.preprocess(value => {
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'string' && /^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(value.trim()))
    return Number(value.trim().replaceAll('_', ''))
  return value
}, z.number().int())

export const createSchema = z.object({
  provider: z.string().min(1).max(64),
  capability: z.enum(['llm','deep_research','similar_image_search','speech_to_text','embedding']),
  value: z.string().max(20000).default(''),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  dimensions: integer.pipe(z.number().min(0).max(65536)).nullish(),
  max_tokens: integer.nullish(),
  context_tokens: integer.nullish(),
  thinking: z.enum(['disabled','adaptive']).nullish(),
  reasoning_effort: z.enum(['','none','minimal','low','medium','high','xhigh','max']).nullish(),
  reasoning_persistence: z.enum(['off','continuation']).default('off'),
  web_search_enabled: bool.nullish(),
  image: bool.default(false),
  video: bool.default(false),
  audio: bool.default(false),
  image_detail: z.enum(['auto','low','high','original']).default('auto'),
})

const nullableBool = bool.nullable().optional()

const nullableInteger = integer.nullable().optional()

export const patchSchema = z.object({
  provider: z.string().min(1).max(64).nullable().optional(),
  value: z.string().max(20000).nullable().optional(),
  api_format: z.string().max(32).nullable().optional(),
  base_url: z.string().max(500).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  dimensions: nullableInteger.pipe(z.number().min(0).max(65536).nullable().optional()),
  max_tokens: nullableInteger,
  context_tokens: nullableInteger,
  thinking: z.enum(['disabled','adaptive']).nullable().optional(),
  reasoning_effort: z.enum(['','none','minimal','low','medium','high','xhigh','max']).nullable().optional(),
  reasoning_persistence: z.enum(['off','continuation']).nullable().optional(),
  web_search_enabled: nullableBool,
  image: nullableBool,
  video: nullableBool,
  audio: nullableBool,
  image_detail: z.enum(['auto','low','high','original']).nullable().optional(),
  enabled: nullableBool,
})

export const testSchema = z.object({
  provider: z.string().min(1).max(64),
  capability: z.enum(['deep_research', 'similar_image_search', 'embedding', 'llm', 'speech_to_text']),
  value: z.string().max(20_000).default(''),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  dimensions: z.preprocess(pydanticIntegerInput, z.number().int().min(0).max(65_536).nullable().optional()),
  credential_id: z.preprocess(pydanticIntegerInput, z.number().int().nullable().optional()),
})

/** 复现 Pydantic int 对整数数字字符串的请求 DTO 转换；非整数文本仍交给 schema 拒绝。 */
function pydanticIntegerInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const normalized = value.trim()
  return /^[+-]?\d+$/.test(normalized) ? Number(normalized) : value
}

export const mediaSchema = z.object({
  provider: z.string().min(1).max(64),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  api_key: z.string().max(20_000).default(''),
  credential_id: z.preprocess(pydanticIntegerInput, z.number().int().nullable().optional()),
  dim: z.enum(['image', 'audio', 'video']),
})

export const modelsSchema = z.object({
  provider: z.string().min(1).max(64),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  api_key: z.string().max(20000).default(''),
  credential_id: z.preprocess(pydanticIntegerInput,z.number().int().nullable().optional()),
})

export const testParams = z.object({ credential_id: z.preprocess(pydanticIntegerInput, z.number().int()) })
