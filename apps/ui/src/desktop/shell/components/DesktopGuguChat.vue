<script setup lang="ts">
import { createDesktopGreetingAccess } from '../greeting-access'
import { createDesktopChatCommandAccess, listDesktopChatCommands } from '../chat-command-access'
import { encodeVoiceRecording } from '../voice-recording'
import { provide } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { chatAttachmentImageKey, chatCommandCatalogKey, chatModelCatalogKey, chatToolDetailsKey } from '@/components/common/gugu-chat/chatPresentationAccess'
import type { DesktopBridge } from '@gugu/core/desktop'
import type { ChatReference, QueuedMessagePayload } from '@/components/common/gugu-chat/chatTypes'
import type { ChatConversationAccess } from '@/components/common/gugu-chat/composables/useChatConversation'
import { createDesktopChatImAccess } from '../../im/chat-access'
import type { ChatInteractionAccess } from '@/components/common/gugu-chat/chatInteractionAccess'
import GuguChat from '@/components/common/gugu-chat/GuguChat.vue'
import { desktopData, DesktopBridgeError } from '@desktop/bridge/bridge'
import { hasDesktopAgentModelBridge, requestDesktopAgentModel, requestDesktopAuxiliaryModel } from '../../account/agent-model-transport'
import {
  deleteDesktopDraftAttachment, downloadDesktopAgentAttachment, hasDesktopAgentAttachmentBridge, uploadDesktopAgentAttachment,
} from '../agent-attachment-transport'
import { requestDesktopAgentSessions, subscribeDesktopAgentRunChanges } from '../agent-session-transport'
import { supportsConfiguredVoiceModel } from '@gugu/core/agent/config/voice-availability'
import { createAgentUiLabels, DEFAULT_AGENT_STATE_LABELS } from '@gugu/core/agent/sessions/ui-labels'
import { BUILTIN_AGENT_TOOL_STATE_LABELS } from '@gugu/core/agent/sessions/state-labels'
import {
  claimDesktopChatQueueItem, patchDesktopChatQueue, releaseDesktopChatQueueItem, replaceDesktopChatQueue,
  createDesktopChatEventStream, createDesktopChatSession, cancelDesktopChatSession, deleteDesktopChatSession, getDesktopChatHistory, getDesktopChatHistoryThroughMessage,
  getDesktopRunState, listDesktopChatSessions, readDesktopChatQueue, readDesktopChatToolDetails, readDesktopImportedChatQueues, renameDesktopChatSession,
} from '../agent-chat'

const imAccess = createDesktopChatImAccess()
const greetingAccess = createDesktopGreetingAccess()
const router = useRouter()
const uiStore = useUiStore()
const readAgentUiLabels = createAgentUiLabels({
  defaultStateLabels: { ...DEFAULT_AGENT_STATE_LABELS, ...BUILTIN_AGENT_TOOL_STATE_LABELS },
  stateLabelOverrides: () => ({}),
})

async function readUiLabels() {
  return readAgentUiLabels()
}

if (hasDesktopAgentModelBridge()) {
  provide(chatModelCatalogKey, {
    selectionKey: 'gugu:desktop:chat-model',
    list: () => requestDesktopAgentModel({ action: 'list' }),
  })
}

provide(chatCommandCatalogKey, listDesktopChatCommands)

provide(chatToolDetailsKey, readDesktopChatToolDetails)

const automaticModeAccess = {
  async read() { return (await desktopData.appearance()).automaticModeEnabled === true },
  async write(value: boolean) { return (await desktopData.updateAppearance({ automaticModeEnabled: value })).automaticModeEnabled === true },
}

const resolveChatCommand = createDesktopChatCommandAccess(automaticModeAccess)

const respondToInteraction: ChatInteractionAccess = async answer => {
  const { sessionId, runId, promptId } = answer
  if (!runId) return { status: 'failed' }
  const request = answer.action === 'select' ? { token: answer.token, selectedOptionIds: answer.selectedOptionIds, customAnswer: answer.customAnswer }
    : answer.action === 'text' ? { text: answer.text } : { secrets: answer.secrets }
  const result = await requestDesktopAgentSessions({
    action: 'respond', id: sessionId, runId, promptId, operationId: crypto.randomUUID(), ...request,
  })
  return { status: 'accepted', runId: result.runId }
}

async function readPendingQueue(queueId: string) {
  const { items } = await readDesktopChatQueue(queueId)
  return { items: items as QueuedMessagePayload[] }
}

async function readImportedQueues() {
  const { queues } = await readDesktopImportedChatQueues()
  return { queues: queues.map(({ items }) => ({ items: items as QueuedMessagePayload[] })) }
}

async function readHistory(id: number, before?: number) {
  const { pendingQueue, ...history } = await getDesktopChatHistory(id, before)
  return { ...history, pendingQueue: pendingQueue as QueuedMessagePayload[] }
}

const sessionAccess: ChatConversationAccess = {
  subscribeRunChanges: subscribeDesktopAgentRunChanges,
  run: {
    createSession: createDesktopChatSession,
    readHistory,
    async readState(id) {
      const { runId, status } = await getDesktopRunState(id)
      return { runId: runId ?? undefined, status }
    },
    cancel(id, runId) {
      return requestDesktopAgentSessions({ action: 'cancelRun', id, runId })
    },
    resume(id, runId, signal) {
      return createDesktopChatEventStream({ action: 'resume', id, runId, operationId: crypto.randomUUID() }, signal)
    },
    send({ attachments, ...input }, signal) {
      return createDesktopChatEventStream({
        action: 'send', ...input, operationId: crypto.randomUUID(),
        attachments: attachments.flatMap(file => file.attach_id ? [file.attach_id] : []),
      }, signal)
    },
  },
  queue: {
    replace: replaceDesktopChatQueue,
    patch: patchDesktopChatQueue,
    claim: claimDesktopChatQueueItem,
    release: releaseDesktopChatQueueItem,
  },
  listSessions: listDesktopChatSessions,
  readExecutionState: async id => (await getDesktopRunState(id)).executionState,
  deleteSession: deleteDesktopChatSession,
  renameSession: renameDesktopChatSession,
  readPendingQueue,
  readHistory,
  async readRunState(id: number) {
    const { runId, status } = await getDesktopRunState(id)
    return { runId: runId ?? undefined, active: Boolean(runId && ['running', 'preparing'].includes(status)) }
  },
}

const attachmentsAvailable = hasDesktopAgentAttachmentBridge()
provide(chatAttachmentImageKey, readAttachment)

function isAttachmentExpired(error: unknown) {
  return error instanceof DesktopBridgeError && error.code === 'not_found'
}

async function readAttachment(id: string) {
  return (await downloadDesktopAgentAttachment(id)).blob
}

async function readVoiceAvailability() {
  if (!attachmentsAvailable) return { available: false }
  const result = await requestDesktopAuxiliaryModel({ action: 'list' })
  return {
    available: !!result && 'items' in result && result.items.some(
      model => model.capability === 'speech_to_text' && model.enabled && supportsConfiguredVoiceModel(model),
    ),
  }
}
function fileBridge() {
  return (window as Window & { guguDesktop?: DesktopBridge }).guguDesktop
}

async function referenceDroppedFile(file: File) {
  const bridge = fileBridge()
  if (!bridge?.createDroppedFileReference) throw new DesktopBridgeError('unsupported', '请在桌面应用中拖入本机文件')
  const result = await bridge.createDroppedFileReference(file)
  if (result.ok === false) throw new DesktopBridgeError(result.error.code, result.error.message)
  return result.result
}

async function openPlatformReference(reference: Pick<ChatReference, 'type' | 'id'>) {
  if (reference.type === 'event') {
    const id = Number(reference.id)
    if (!Number.isSafeInteger(id) || id < 1) return false
    uiStore.pendingCalendarEvent = { id }
    await router.push('/calendar')
    return true
  }
  if (reference.type !== 'file' || typeof reference.id !== 'string' || !reference.id.startsWith('drop-')) return false
  await desktopData.openDroppedFileReference(reference.id)
  return true
}

async function uploadAttachment(file: File, voice = false) {
  return uploadDesktopAgentAttachment(voice ? await encodeVoiceRecording(file) : file, voice)
}
</script>

<template>
  <GuguChat
    :im-access="imAccess"
    :greeting-access="greetingAccess"
    :read-ui-labels="readUiLabels"
    :session-access="sessionAccess"
    local-session-badges
    :automatic-mode-access="automaticModeAccess"
    :resolve-chat-command="resolveChatCommand"
    :read-history-through-message="getDesktopChatHistoryThroughMessage"
    :respond-to-interaction="respondToInteraction"
    :read-voice-availability="readVoiceAvailability"
    :cancel-session="cancelDesktopChatSession"
    :read-pending-queue="readPendingQueue"
    :read-imported-queues="readImportedQueues"
    :is-attachment-expired="isAttachmentExpired"
    :reference-dropped-file="referenceDroppedFile"
    :open-platform-reference="openPlatformReference"
    :upload-attachment="uploadAttachment"
    :delete-draft-attachment="deleteDesktopDraftAttachment"
    :read-attachment="readAttachment"
  />
</template>
