import { getCsrfHeaders } from '@/services/api'
import { isUnauthorizedResponse } from '@/services/authSession'
import { API_BASE } from './chatConstants'

export type ChatInteractionAnswer = {
  sessionId: number
  runId?: string
  promptId: number
} & (
  | { action: 'select'; token: string; resume: boolean }
  | { action: 'text'; text: string }
  | { action: 'secrets'; secrets: Record<string, string> | null }
)

export type ChatInteractionResult =
  | { status: 'accepted'; runId?: string }
  | { status: 'expired'; detail?: string }
  | { status: 'unauthorized' }
  | { status: 'failed' }

export type ChatInteractionAccess = (answer: ChatInteractionAnswer) => Promise<ChatInteractionResult>

export const respondToHttpInteraction: ChatInteractionAccess = async answer => {
  let route: string
  let payload: object | undefined
  switch (answer.action) {
    case 'select':
      route = answer.resume ? 'resume' : 'respond'
      payload = { token: answer.token }
      break
    case 'text':
      route = 'resume-text'
      payload = { text: answer.text }
      break
    case 'secrets':
      route = answer.secrets === null ? 'secrets/cancel' : 'secrets'
      payload = answer.secrets === null ? undefined : { values: answer.secrets }
      break
  }

  const response = await fetch(`${API_BASE}/agent/interactions/${answer.promptId}/${route}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...getCsrfHeaders(), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
  if (isUnauthorizedResponse(response)) return { status: 'unauthorized' }
  if (response.status === 404 || response.status === 409) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null
    return { status: 'expired', detail: typeof body?.detail === 'string' ? body.detail : undefined }
  }
  if (!response.ok) return { status: 'failed' }
  if (route !== 'resume') return { status: 'accepted' }
  const body = await response.json().catch(() => null) as { run_id?: unknown } | null
  return { status: 'accepted', runId: typeof body?.run_id === 'string' ? body.run_id : undefined }
}
