<template>
  <div class="stream-preview">
    <div class="stream-controls">
      <ActionButton fit type="button" @click="replay">{{ streaming ? '从头重播' : '播放样板' }}</ActionButton>
      <ActionButton v-if="streaming" fit type="button" variant="secondary" @click="stop">停止</ActionButton>
    </div>
    <GuguChatWindow v-if="visible" ref="chatWindow" v-bind="previewProps"
      :class="{ 'stream-preview-expanded': expanded }" :expanded="expanded"
      :messages="messages" :streaming="streaming" :status-kind="waiting ? 'dots' : ''"
      :status-typed="statusText"
      :on-enter-expanded="() => expanded = true" :on-exit-expanded="() => expanded = false"
      :on-close="close" :on-stop-streaming="stop" :on-copy="copy" :copied-id="copiedId">
      <template #composer><div class="stream-preview-footer">本地 SSE 样板</div></template>
    </GuguChatWindow>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { createAgentChatSseDecoder, encodeAgentChatSse } from '@gugu/core/agent/chat-sse'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import GuguChatWindow from '@/components/common/gugu-chat/GuguChatWindow.vue'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'
import { mapSessionMessageDelta, mergeSessionMessageDelta } from '@/components/common/gugu-chat/composables/sessionMessageSync'

const chatWindow = ref<InstanceType<typeof GuguChatWindow> | null>(null)
const visible = ref(true)
const expanded = ref(false)
const streaming = ref(false)
const waiting = ref(false)
const statusText = ref('')
const copiedId = ref<number | null>(null)
const prompt: ChatMessage = { id: 1, role: 'user', text: '帮我看看角色设定项目的进度，明天下午有空吗？', time: '14:00' }
const messages = ref<ChatMessage[]>([prompt])
let timer: ReturnType<typeof setTimeout> | undefined
let playback = 0

const noop = () => {}
const previewProps = {
  previewOnly: true, textOnly: true, windowStyle: { position: 'relative' }, ownerZ: 1,
  resizing: false, automaticModeEnabled: false, automaticModeAvailable: false, automaticModeSaving: false,
  isChatDragging: false, currentSessionTitle: '项目安排', currentSessionWorkspaceName: null,
  currentSessionGoalActive: false, currentSessionGoalStatus: null, filesystemAuthorized: false,
  filesystemAuthorizationEnabled: false, sessionId: null, interactionAnswerMode: 'inline' as const,
  presenceKind: '', presenceText: '', presenceTitle: '', isGroupSession: false,
  voicePlayingId: null, voiceBars: [], sessionSettling: false, pendingQueue: [],
  inputText: '', references: [], pendingAtt: [], attUploading: false, recording: false,
  voiceInputAvailable: false, recordSecs: 0, vw: 0,
  onToggleAutomaticMode: noop, onRemoveAtt: noop, onStartRecord: noop, onCancelRecord: noop,
  onStopRecord: noop, onFilePicked: noop, onPaste: noop, onSend: noop, onToggleVoice: noop,
  onOpenFile: noop, onDownload: noop, onActionClick: noop, onInteractionSelect: noop,
  onInteractionTextSubmit: noop, onSecretSubmit: noop, onSecretCancel: noop, onReferenceClick: noop,
  onPromptConnect: noop, onFilesystemAuthorization: noop, onRenameSession: noop, onRaiseChat: noop,
  onDragEnter: noop, onDragOver: noop, onDragLeave: noop, onDrop: noop,
}

function sampleFrames() {
  const started = new Date()
  const base = { runId: 'design-run', roundId: 'design-round', createdAt: started.toISOString() }
  const project = { ...base, kind: 'tool', eventId: 'project', toolCallId: 'demo-project', timelineOrder: 2,
    toolName: 'get_project', toolInput: { project_id: 42 }, toolStatus: 'running' }
  const calendar = { ...base, kind: 'tool', eventId: 'calendar', toolCallId: 'demo-calendar', timelineOrder: 3,
    toolName: 'list_events', toolInput: { from: '明天', to: '明天' }, toolStatus: 'running' }
  const reply = { ...base, kind: 'assistant', eventId: 'reply', timelineOrder: 4 }
  const parts = [
    '**角色设定**已经完成第一阶段，',
    '还有两项待办：\n\n- 补齐主角表情草图',
    '\n- 确认配角服装配色',
    '\n\n日历暂时没能读取，所以还不能确认明天下午是否有空。',
  ]
  return [
    { delay: 550, item: project },
    { delay: 400, item: calendar },
    { delay: 650, item: { ...project, toolStatus: 'success', toolDurationMs: 1050,
      toolResult: { id: 42, name: '角色设定', status: 'active', stages_done: 1, stages_total: 2 } } },
    { delay: 550, item: { ...calendar, toolStatus: 'error', toolDurationMs: 1200,
      toolResult: { error: '日历暂时不可用' } } },
    ...parts.map((_, index) => ({ delay: index ? 230 : 550, item: { ...reply, text: parts.slice(0, index + 1).join('') } })),
    { delay: 350 },
  ]
}

function finish() {
  messages.value = messages.value.map(message => {
    if (message.streaming) return { ...message, streaming: false }
    if (message.role === 'tool' && message.toolStatus === 'running') return { ...message, toolStatus: 'cancelled' }
    return message
  })
  streaming.value = false
  waiting.value = false
  statusText.value = ''
}

function stop() {
  playback++
  clearTimeout(timer)
  finish()
}

function close() {
  stop()
  visible.value = false
}

function replay() {
  stop()
  const current = playback
  visible.value = true
  copiedId.value = null
  messages.value = [{ ...prompt, _createdAt: new Date().toISOString(), _timelineOrder: 1 }]
  streaming.value = true
  waiting.value = true
  statusText.value = '正在准备回复'
  const frames = sampleFrames()
  const decoder = createAgentChatSseDecoder()
  const encoder = new TextEncoder()
  let nextId = 1

  function playFrame(index: number) {
    const frame = frames[index]
    timer = setTimeout(async () => {
      if (current !== playback) return
      const packet = encoder.encode(encodeAgentChatSse(frame.item
        ? { type: 'display_event', item: frame.item }
        : { type: 'done' }))
      for (const raw of decoder.push(packet)) {
        const event = JSON.parse(raw)
        if (event.type === 'done') {
          finish()
          return
        }
        const delta = mapSessionMessageDelta({ timelineEvents: [event.item] }, () => ++nextId, role => ({ role }))
        for (const message of delta) if (message.role === 'ai') message.streaming = true
        const list = chatWindow.value?.messageListRef?.el
        const follow = !list || list.scrollHeight - list.scrollTop - list.clientHeight <= 24
        const toolFinished = event.item.kind === 'tool' && event.item.toolStatus !== 'running'
        waiting.value = toolFinished
        statusText.value = toolFinished ? '正在整理结果' : ''
        messages.value = mergeSessionMessageDelta(messages.value, delta)
        await nextTick()
        if (current !== playback) return
        if (follow) chatWindow.value?.messageListRef?.scrollToBottom()
      }
      playFrame(index + 1)
    }, frame.delay)
  }

  playFrame(0)
}

async function copy(message: ChatMessage) {
  try {
    await navigator.clipboard.writeText(message.text)
    copiedId.value = message.id
  } catch {
    copiedId.value = null
  }
}

onBeforeUnmount(() => {
  playback++
  clearTimeout(timer)
})
</script>

<style scoped>
.stream-preview { display: grid; gap: var(--space-md); min-width: 0; }
.stream-controls { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
.stream-preview-footer {
  padding: var(--space-sm) var(--space-md);
  border-top: 1px solid var(--gugu-chat-header-border);
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
}
.stream-preview :deep(.chat-window) {
  width: min(100%, 430px);
  height: 420px;
  background: var(--gugu-chat-bg);
  border-color: var(--gugu-chat-border);
  border-radius: var(--gugu-chat-radius);
  box-shadow: var(--gugu-chat-shadow);
}
.stream-preview :deep(.stream-preview-expanded) { width: min(100%, 760px); }
</style>
