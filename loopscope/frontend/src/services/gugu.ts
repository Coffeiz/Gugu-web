import type { ChatMessage, GuguSession } from '../types'

export interface GuguBootstrap {
  apiBase: string
  token: string
}

const KEY = 'loopscope:gugu-bootstrap'

function normalizeBase(base: string) {
  return base.replace(/\/+$/, '')
}

export function saveBootstrap(value: GuguBootstrap) {
  sessionStorage.setItem(KEY, JSON.stringify({ ...value, apiBase: normalizeBase(value.apiBase) }))
  window.dispatchEvent(new CustomEvent('loopscope:bootstrap'))
}

export function loadBootstrap(): GuguBootstrap | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function authHeaders(extra: HeadersInit = {}): HeadersInit {
  const cfg = loadBootstrap()
  return {
    ...extra,
    ...(cfg?.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
  }
}

export async function listGuguSessions(): Promise<GuguSession[]> {
  const cfg = loadBootstrap()
  if (!cfg) return []
  const r = await fetch(`${cfg.apiBase}/agent/sessions`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`Gugu sessions ${r.status}`)
  return r.json()
}

export async function loadMessages(sessionId: number): Promise<ChatMessage[]> {
  const cfg = loadBootstrap()
  if (!cfg) return []
  const r = await fetch(`${cfg.apiBase}/agent/sessions/${sessionId}/messages`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`Gugu messages ${r.status}`)
  const data = await r.json()
  return (data.messages ?? [])
    .filter((m: any) => m.role === 'user' || m.role === 'assistant')
    .map((m: any) => ({ id: m.id, role: m.role, content: m.content ?? '', createdAt: m.createdAt }))
}

export type StreamEvent = Record<string, any>

export async function sendMessage(
  message: string,
  sessionId: number | null,
  onEvent: (event: StreamEvent) => void,
): Promise<number | null> {
  const cfg = loadBootstrap()
  if (!cfg) throw new Error('尚未连接 Gugu。请从 Gugu /dev 打开 LoopScope，或在 Settings 配置。')
  const r = await fetch(`${cfg.apiBase}/agent/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, session_id: sessionId }),
  })
  if (!r.ok || !r.body) throw new Error(`Gugu chat ${r.status}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let resolved = sessionId
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const evt = JSON.parse(line.slice(6))
        if (evt.type === 'session_id') resolved = Number(evt.session_id)
        onEvent(evt)
      } catch {
        // malformed dev stream event: ignore
      }
    }
  }
  return resolved
}
