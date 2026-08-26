import { z } from 'zod'

export const JsonObjectSchema = z.record(z.unknown())

export const CodeProvenanceSchema = z.object({
  file: z.string().optional(),
  module: z.string().optional(),
  function: z.string().optional(),
  qualname: z.string().optional(),
  line: z.number().int().nullable().optional(),
}).passthrough()

export const TokenUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  fresh_input: z.number().optional(),
  total: z.number().optional(),
  cache_ratio: z.number().optional(),
}).passthrough()

export const TokenImpactSchema = z.object({
  source_tokens: z.number().optional(),
  included_tokens: z.number().optional(),
  argument_tokens: z.number().optional(),
  result_tokens: z.number().optional(),
  prompt_tokens_estimate: z.number().optional(),
  prompt_growth_estimate: z.number().optional(),
  system_tokens_estimate: z.number().optional(),
  messages_tokens_estimate: z.number().optional(),
  estimated_input_tokens: z.number().optional(),
  followup_tokens: z.number().optional(),
  output_tokens_estimate: z.number().optional(),
}).passthrough()

export const TraceSpanInputSchema = z.object({
  id: z.string(),
  run_id: z.string().optional(),
  parent_span_id: z.string().nullable().optional(),
  kind: z.string(),
  name: z.string(),
  status: z.string().default('success'),
  started_at: z.number(),
  ended_at: z.number().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  input: z.unknown().default({}),
  output: z.unknown().default({}),
  attributes: JsonObjectSchema.default({}),
  code: CodeProvenanceSchema.optional().default({}),
  usage: TokenUsageSchema.optional().default({}),
  token_impact: TokenImpactSchema.optional().default({}),
  ordinal: z.number().int().optional(),
}).passthrough()

export const TraceRunInputSchema = z.object({
  id: z.string(),
  trace_id: z.string().optional().default(''),
  session_key: z.string(),
  external_session_id: z.union([z.string(), z.number()]).optional().transform(v => v == null ? '' : String(v)),
  source: z.string().optional().default('unknown'),
  status: z.string().optional().default('success'),
  started_at: z.number(),
  ended_at: z.number().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  input: z.unknown().default({}),
  output: z.unknown().default({}),
  attributes: JsonObjectSchema.default({}),
  usage: TokenUsageSchema.optional().default({}),
  spans: z.array(TraceSpanInputSchema).default([]),
  title: z.string().optional(),
}).passthrough()

export const TraceSessionSchema = z.object({
  session_key: z.string(),
  external_session_id: z.string().optional(),
  source: z.string(),
  title: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  run_count: z.number().optional(),
  error_count: z.number().optional(),
})

export const ContextFragmentSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  span_id: z.string().nullable().optional(),
  kind: z.string(),
  title: z.string(),
  content_markdown: z.string().default(''),
  raw: z.unknown().optional(),
  token_count: z.number().optional(),
  source: z.unknown().optional(),
  ordinal: z.number().int().default(0),
})

export type CodeProvenance = z.infer<typeof CodeProvenanceSchema>
export type TokenUsage = z.infer<typeof TokenUsageSchema>
export type TokenImpact = z.infer<typeof TokenImpactSchema>
export type TraceSpanInput = z.infer<typeof TraceSpanInputSchema>
export type TraceRunInput = z.infer<typeof TraceRunInputSchema>
export type TraceSession = z.infer<typeof TraceSessionSchema>
export type ContextFragment = z.infer<typeof ContextFragmentSchema>

export interface TraceSpan extends TraceSpanInput { run_id: string; ordinal: number }
export interface TraceRun extends Omit<TraceRunInput, 'spans'> { spans?: TraceSpan[] }

export interface GuguSession {
  id: number
  title: string
  source: string
  updatedAt?: string
}

export interface ChatDebugEvent {
  kind: 'status' | 'tool' | 'round'
  label: string
  detail?: unknown
  done?: boolean
}

export interface ChatMessage {
  id: number | string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string
  pending?: boolean
  runId?: string
  debugEvents?: ChatDebugEvent[]
}

