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
  attributes: Record<string, unknown>
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
  input: Record<string, any>
  output: Record<string, any>
  attributes: Record<string, any>
  spans?: TraceSpan[]
}
