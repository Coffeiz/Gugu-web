import type { TraceRun } from '../types'

// 前端和 API 通常由同一台 devserver 提供；通过 Vite 同源代理访问，避免浏览器把
// 127.0.0.1 解析成本机而不是远端 devserver。
const BASE = import.meta.env.VITE_LOOPSCOPE_API_URL ?? '/loopscope-api'

export async function listTraceSessions() {
  const r = await fetch(`${BASE}/sessions`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function listRuns(
  sessionId: number | string,
  source = 'web',
  options: { limit?: number; before?: number } = {},
): Promise<TraceRun[]> {
  const key = encodeURIComponent(`gugu:${source}:${sessionId}`)
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.before !== undefined) query.set('before', String(options.before))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const r = await fetch(`${BASE}/sessions/${key}/runs${suffix}`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function getRun(id: string, options: { includeSpans?: boolean } = {}): Promise<TraceRun> {
  const query = options.includeSpans === undefined ? '' : `?include_spans=${options.includeSpans ? 'true' : 'false'}`
  const r = await fetch(`${BASE}/runs/${encodeURIComponent(id)}${query}`)
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
  const r = await fetch(`${BASE}/runs/${encodeURIComponent(id)}/spans${suffix}`)
  if (!r.ok) throw new Error(`LoopScope spans ${r.status}`)
  return r.json()
}

export async function health() {
  const r = await fetch(`${BASE}/health`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}
