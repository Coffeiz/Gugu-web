import type { TraceRun, TraceRunSummary } from '../types'

// 所有诊断数据都通过 Gugu 用户鉴权代理读取；不要直接访问无用户会话的 Collector。
const BASE = '/gugu-api/dev/loopscope'

function collectorFetch(path: string) {
  return fetch(`${BASE}${path}`, { credentials: 'include' }).then(response => {
    if (response.status === 401) window.dispatchEvent(new Event('loopscope:auth-required'))
    return response
  })
}

export async function listTraceSessions() {
  const r = await collectorFetch('/sessions')
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function listReflectionRuns(options: { limit?: number; before?: number } = {}): Promise<TraceRun[]> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.before !== undefined) query.set('before', String(options.before))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const r = await collectorFetch(`/reflections${suffix}`)
  if (!r.ok) throw new Error(`LoopScope reflections ${r.status}`)
  return r.json()
}

export async function listRuns(
  sessionId: number | string,
  source = 'web',
  options: { limit?: number; before?: number } = {},
): Promise<TraceRunSummary[]> {
  const key = encodeURIComponent(`gugu:${source}:${sessionId}`)
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.before !== undefined) query.set('before', String(options.before))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const r = await collectorFetch(`/sessions/${key}/runs${suffix}`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  const runs = await r.json() as TraceRunSummary[]
  // Collector 旧版本曾按“最旧到最新”返回；在 API 层统一成“最新到最旧”，
  // 这样前端分页方向不会依赖 Collector 是否已同步更新。
  return runs.sort((a, b) => (b.started_at - a.started_at) || b.id.localeCompare(a.id))
}

export async function getRun(id: string, options: { includeSpans?: boolean } = {}): Promise<TraceRun> {
  const query = options.includeSpans === undefined ? '' : `?include_spans=${options.includeSpans ? 'true' : 'false'}`
  const r = await collectorFetch(`/runs/${encodeURIComponent(id)}${query}`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function getRunSpans(
  id: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ items: TraceRun['spans']; hasMore: boolean; offset: number; limit: number }> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.offset !== undefined) query.set('offset', String(options.offset))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const r = await collectorFetch(`/runs/${encodeURIComponent(id)}/spans${suffix}`)
  if (!r.ok) throw new Error(`LoopScope spans ${r.status}`)
  return r.json()
}

export async function health() {
  const r = await collectorFetch('/health')
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export function subscribeTraceEvents(onEvent: (event: { run_id: string; session_key: string; status: string }) => void) {
  const stream = new EventSource(`${BASE}/events`, { withCredentials: true })
  stream.onmessage = message => {
    try {
      const event = JSON.parse(message.data) as Record<string, unknown>
      if (event.type !== 'run.changed'
        || typeof event.run_id !== 'string'
        || typeof event.session_key !== 'string'
        || typeof event.status !== 'string') return
      onEvent({ run_id: event.run_id, session_key: event.session_key, status: event.status })
    } catch {
      // 忽略格式错误的通知；后续通知或手动刷新可以恢复。
    }
  }
  return () => stream.close()
}
