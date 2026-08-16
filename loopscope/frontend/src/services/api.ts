import type { TraceRun } from '../types'

// 前端和 API 通常由同一台 devserver 提供；通过 Vite 同源代理访问，避免浏览器把
// 127.0.0.1 解析成本机而不是远端 devserver。
const BASE = import.meta.env.VITE_LOOPSCOPE_API_URL ?? '/loopscope-api'

export async function listTraceSessions() {
  const r = await fetch(`${BASE}/sessions`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function listRuns(sessionId: number | string): Promise<TraceRun[]> {
  const key = encodeURIComponent(`gugu:web:${sessionId}`)
  const r = await fetch(`${BASE}/sessions/${key}/runs`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function getRun(id: string): Promise<TraceRun> {
  const r = await fetch(`${BASE}/runs/${encodeURIComponent(id)}`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}

export async function health() {
  const r = await fetch(`${BASE}/health`)
  if (!r.ok) throw new Error(`LoopScope ${r.status}`)
  return r.json()
}
