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

export interface CodeProvenance {
  file?: string
  module?: string
  function?: string
  qualname?: string
  line?: number | null
}

export interface TokenUsage {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  fresh_input?: number
  total?: number
  cache_ratio?: number
}

export interface TokenImpact {
  source_tokens?: number
  included_tokens?: number
  argument_tokens?: number
  result_tokens?: number
  prompt_tokens_estimate?: number
  prompt_tokens_actual?: number
  prompt_tokens_source?: 'provider' | 'estimate' | string
  prompt_growth_estimate?: number
  system_tokens_estimate?: number
  messages_tokens_estimate?: number
  estimated_input_tokens?: number
  followup_tokens?: number
  output_tokens_estimate?: number
  [key: string]: unknown
}

export interface TraceSpan {
  id: string
  run_id: string
  parent_span_id?: string | null
  kind: string
  name: string
  status: string
  started_at: number
  ended_at?: number | null
  duration_ms?: number | null
  input: unknown
  output: unknown
  attributes: Record<string, any>
  code?: CodeProvenance
  usage?: TokenUsage
  token_impact?: TokenImpact
  ordinal: number
}

export interface TraceRun {
  id: string
  session_key: string
  trace_id?: string
  status: string
  started_at: number
  ended_at?: number | null
  duration_ms?: number | null
  input?: Record<string, any>
  output?: Record<string, any>
  attributes: Record<string, any>
  usage?: TokenUsage
  spans?: TraceSpan[]
}

export interface CanonicalEventStats {
  count?: number
  by_type?: Record<string, number>
  schema_digests?: string[]
}

export interface AdapterCallStats {
  count?: number
  success?: number
  errors?: number
  canonical_render_calls?: number
  by_provider?: Record<string, number>
  by_api_format?: Record<string, number>
}

export interface TraceSpanPage {
  items: TraceSpan[]
  hasMore: boolean
  offset: number
  limit: number
}
