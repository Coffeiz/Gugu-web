import { getLocale } from '@/i18n'
import { CLIENT_ID, getCsrfHeaders } from '@/services/api'
import { API_BASE } from './chatConstants'
import type { ChatFile, ChatReference } from './chatTypes'

export interface ChatHttpStreamAccess {
  send(input: {
    text: string
    clientMessageId: string
    sessionId: number | null
    queueId: string
    itemKey?: number
    claimToken?: string | null
    attachments: ChatFile[]
    references: ChatReference[]
    credentialId?: number | null
    greeting?: string
  }, signal?: AbortSignal): Promise<Response>
  resume(sessionId: number, runId: string | undefined, signal: AbortSignal): Promise<Response>
}

export const chatHttpStream: ChatHttpStreamAccess = {
  send(input, signal) {
    const { text, clientMessageId, sessionId, queueId, itemKey, claimToken, attachments, references, credentialId, greeting } = input
    return fetch(`${API_BASE}/agent/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...getCsrfHeaders() },
      body: JSON.stringify({
        message: text,
        client_message_id: clientMessageId,
        locale: getLocale(),
        session_id: sessionId,
        pending_queue_id: queueId,
        ...(itemKey !== undefined ? { pending_queue_item_key: itemKey } : {}),
        ...(claimToken ? { pending_queue_claim_token: claimToken } : {}),
        attachments: attachments.map(file => file.attach_id),
        references,
        ...(credentialId === undefined ? {} : { credential_id: credentialId }),
        ...(greeting ? { greeting } : {}),
      }),
      signal,
    })
  },
  resume(sessionId, runId, signal) {
    const query = runId ? `?run_id=${encodeURIComponent(runId)}` : ''
    return fetch(`${API_BASE}/agent/sessions/${sessionId}/stream${query}`, { credentials: 'include', signal })
  },
}
