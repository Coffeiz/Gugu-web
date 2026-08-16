import type { TraceRun } from '../types'

const BASE = import.meta.env.VITE_LOOPSCOPE_API_URL ?? 'http://127.0.0.1:4320/api'

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
