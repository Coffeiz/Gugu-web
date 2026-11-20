export const defaultLoopScopeEndpoint: string
export function loopScopeTraceEnabled(value: unknown): boolean
export interface LoopScopeTraceEvent {
  identity: { ownerId: string; sessionId: string; runId: string }
  kind: 'run' | 'round' | 'provider' | 'tool' | 'context'
  name: string
  at: number
  round?: number
  spanId?: string
  parentSpanId?: string | null
  status?: string
  input?: unknown
  output?: unknown
  attributes?: Readonly<Record<string, unknown>>
  usage?: Readonly<Record<string, unknown>>
}
export function createLoopScopeTrace(options: {
  endpoint: string
  source?: string
  maxQueue?: number
  maxRuns?: number
  maxSpans?: number
  maxTraceBytes?: number
  maxQueueBytes?: number
  requestTimeoutMs?: number
  transport: {
    request(input: {
      url: string
      method: 'POST'
      allowLocal: true
      headers: Readonly<Record<string, string>>
      body: Record<string, unknown> | Uint8Array
    }, signal: AbortSignal): Promise<{ status: number; cancel?(): Promise<void> | void }>
  }
}): { record(event: LoopScopeTraceEvent): void; close(drainMs?: number): Promise<void> }

export function createLoopScopeClient<Response>(options: {
  endpoint?: string
  transport: {
    request(input: {
      url: string
      method: 'GET'
      allowLocal: true
      headers: Readonly<Record<string, string>>
    }, signal: AbortSignal): Promise<Response>
  }
}): {
  read(path: string, query: string, signal: AbortSignal): Promise<Response | null>
}
