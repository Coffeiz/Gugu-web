import type { ChatMessage, GuguSession } from '../types'

export interface GuguBootstrap {
  apiBase: string
  token: string
}

const KEY = 'loopscope:gugu-bootstrap'

function normalizeBase(base: string) {
  return base.replace(/\/+$/, '')
}

function apiBase(cfg: GuguBootstrap) {
  const configured = normalizeBase(cfg.apiBase)
  if (typeof window === 'undefined') return configured

  // 旧版 bootstrap 会把 Gugu 的 /api/v1 地址写入 sessionStorage；
  // 独立窗口应通过自身的同源代理访问，避免跨端口 CORS 失败。
  try {
    const parsed = new URL(configured, window.location.origin)
    if (parsed.pathname.endsWith('/api/v1') && parsed.origin !== window.location.origin) {
      return `${window.location.origin}/gugu-api`
    }
  } catch {
    return configured
  }
  return configured
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
  const r = await fetch(`${apiBase(cfg)}/agent/sessions`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`Gugu sessions ${r.status}`)
  return r.json()
}

export interface MessagePage {
  messages: ChatMessage[]
  hasMore: boolean
  oldestId: number | null
  newestId: number | null
}

export async function loadMessagePage(
  sessionId: number,
  options: { limit?: number; beforeId?: number; afterId?: number } = {},
): Promise<MessagePage> {
  const cfg = loadBootstrap()
  if (!cfg) return { messages: [], hasMore: false, oldestId: null, newestId: null }
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.beforeId !== undefined) query.set('before_id', String(options.beforeId))
  if (options.afterId !== undefined) query.set('after_id', String(options.afterId))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  const r = await fetch(`${apiBase(cfg)}/agent/sessions/${sessionId}/messages${suffix}`, { headers: authHeaders() })
  if (!r.ok) throw new Error(`Gugu messages ${r.status}`)
  const data = await r.json()
  const page = data.pagination ?? {}
  const timeline: any[] = Array.isArray(data.timelineEvents) ? data.timelineEvents : []
  const tools: any[] = Array.isArray(data.toolEvents) ? data.toolEvents : []
  const messages: ChatMessage[] = (data.messages ?? [])
    .filter((m: any) => m.role === 'user' || m.role === 'assistant')
    .map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content ?? '',
      createdAt: m.createdAt,
      canonicalId: Number(m.id),
      timelineOrder: Number(m.timelineOrder ?? Number(m.id) * 1000),
    }))
  // 新接口把一个 assistant 消息的多轮正文拆到 timelineEvents；不能只恢复
  // messages，否则刷新后只剩用户气泡。timeline 中的工具项也一并恢复，兼容
  // web/IM 两种持久化形态。
  for (const event of timeline) {
    if (!event || event.kind !== 'assistant' && event.kind !== 'tool') continue
    const order = Number(event.timelineOrder ?? 0)
    messages.push({
      id: String(event.id ?? `timeline:${order}`),
      role: event.kind === 'tool' ? 'tool' : 'assistant',
      content: event.text ?? '',
      createdAt: event.createdAt,
      canonicalId: Math.floor(order / 1000) || undefined,
      timelineOrder: order,
      runId: event.runId,
      toolName: event.toolName,
      toolLabel: event.toolLabel,
      toolStatus: event.toolStatus,
      toolInput: event.toolInput,
      toolResult: event.toolResult,
    })
  }
  for (const event of tools) {
    const order = Number(event.timelineOrder ?? 0)
    messages.push({
      id: String(event.id ?? `tool:${event.toolCallId ?? order}`),
      role: 'tool',
      content: '',
      createdAt: event.createdAt,
      canonicalId: Math.floor(order / 1000) || undefined,
      timelineOrder: order,
      toolName: event.toolName,
      toolLabel: event.toolLabel,
      toolStatus: event.toolStatus,
      toolInput: event.toolInput,
      toolResult: event.toolResult,
    })
  }
  messages.sort((a, b) => (a.timelineOrder ?? 0) - (b.timelineOrder ?? 0) || String(a.id).localeCompare(String(b.id)))
  return {
    messages,
    hasMore: Boolean(page.hasMore),
    oldestId: page.oldestId ?? null,
    newestId: page.newestId ?? null,
  }
}

export async function loadMessages(sessionId: number): Promise<ChatMessage[]> {
  const page = await loadMessagePage(sessionId)
  return page.messages
}

export type StreamEvent = Record<string, any>

export async function sendMessage(
  message: string,
  sessionId: number | null,
  onEvent: (event: StreamEvent) => void,
): Promise<number | null> {
  const cfg = loadBootstrap()
  if (!cfg) throw new Error('尚未连接 Gugu。请从 Gugu /dev 打开 LoopScope，或在 Settings 配置。')
  const r = await fetch(`${apiBase(cfg)}/agent/chat`, {
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
