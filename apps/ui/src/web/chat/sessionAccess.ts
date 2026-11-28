import { agentApi } from '@/services/api'
import type { ChatConversationAccess } from '@/components/common/gugu-chat/composables/useChatConversation'

export const webChatSessionAccess: ChatConversationAccess = {
  listSessions: agentApi.listSessions,
  readHistory: (id, beforeId) => agentApi.getMessages(id, { beforeId, limit: 50 }),
  readFirstPage: id => agentApi.getMessages(id, { restoreInteractions: true }),
  readChanges: (id, afterId) => agentApi.getMessages(id, { afterId, limit: 200 }),
  readExecutionState: async id => (await agentApi.getSessionState(String(id))).executionState,
  readRunState: id => agentApi.getSessionState(String(id)),
  readPendingQueue: agentApi.getPendingQueue,
  deleteSession: id => agentApi.deleteSession(String(id)),
  renameSession: (id, title) => agentApi.renameSession(String(id), title),
  queue: {
    replace: agentApi.updatePendingQueue,
    patch: agentApi.patchPendingQueue,
    claim: agentApi.claimPendingQueueItem,
    release: agentApi.releasePendingQueueItem,
  },
}

export function cancelWebChatSession(id: number) {
  return agentApi.cancelSession(String(id))
}
