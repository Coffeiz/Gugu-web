<template>
  <GuguChatInteraction v-if="msg.role === 'interaction'" :msg="msg" :answer-mode="interactionAnswerMode"
    @select="(selectedMsg, option) => $emit('interactionSelect', selectedMsg, option)"
    @text-submit="(selectedMsg, text) => $emit('interactionTextSubmit', selectedMsg, text)"
    @secret-submit="(selectedMsg, values) => $emit('secretSubmit', selectedMsg, values)"
    @secret-cancel="selectedMsg => $emit('secretCancel', selectedMsg)" />
  <div v-if="isGroupSession && msg.role === 'ai'" class="msg-speaker">{{ t('chatUi.gugu') }}</div>
  <button v-if="msg.subagentOutput" type="button" class="msg-speaker msg-speaker-subagent"
    :aria-expanded="subagentExpanded === true"
    :aria-label="msg.subagentElapsedMs === undefined ? undefined : t('chatUi.subagentDuration', { agent: memberSpeaker, duration: formatToolDuration(msg.subagentElapsedMs) })"
    @click="$emit('toggleSubagent')">
    <span class="msg-speaker-bird" aria-hidden="true"></span>
    <span>{{ memberSpeaker }}</span>
    <span v-if="msg.subagentElapsedMs !== undefined" class="msg-speaker-subagent-duration" aria-hidden="true">{{ formatToolDuration(msg.subagentElapsedMs) }}</span>
    <FlipChevron :open="subagentExpanded" aria-hidden="true" />
  </button>
  <div v-else-if="memberSpeaker" class="msg-speaker">{{ memberSpeaker }}</div>
  <!-- IM 引用/回复：单独一条浅色预览条，跟真正打的话分开显示，别把引用原文
       （可能带 markdown 表格等）直接摊平混进正文气泡（devlog 2026-07-10）。 -->
  <div v-if="msg.role !== 'ai' && (msg.quotedText || msg.files?.some(f => f.quoted))" class="msg-quoted" :title="msg.quotedText || t('chat.quotedMessage')">
    <span v-if="msg.quotedText">{{ displayQQFaces(msg.quotedText) }}</span>
    <template v-for="f in (msg.files || []).filter(f => f.quoted)" :key="`quoted:${f.file_path || f.attach_id}`">
      <img v-if="f.qq_face || isAnimatedImageFile(f)" class="msg-quoted-thumb msg-face-gif" v-lazy-face="f.file_path || f.attach_id" draggable="false" :alt="t('chat.quotedImage')" @click.stop="$emit('openFile', f)" />
      <img v-else-if="f._thumbUrl" class="msg-quoted-thumb" :src="f._thumbUrl" draggable="false" :alt="t('chat.quotedImage')" @click.stop="$emit('openFile', f)" />
      <img v-else-if="isImageFile(f)" class="msg-quoted-thumb" v-lazy-thumb="f.file_path || f.attach_id" draggable="false" :alt="t('chat.quotedImage')" @click.stop="$emit('openFile', f)" />
      <!-- 非图片引用文件（文档/压缩包等）：小 chip 展示文件名，可点开预览。
           之前两头都不渲染（msg-files 又排除 quoted），引用条看起来是空的。 -->
      <span v-else class="msg-quoted-file" @click.stop="$emit('openFile', f)">{{ f.name }}{{ f.ext ? `.${f.ext}` : '' }}</span>
    </template>
  </div>
  <GuguChatCitations v-if="msg.role === 'ai' && (msg.text?.trim() || msg.streaming)"
    :html="assistantHtml" :text="displayed" :presenting="presenting" :sources="sources"
    :snapshot-message="sessionId && msg.dbId ? JSON.stringify([sessionId, msg.dbId, msg._createdAt ?? '']) : undefined"
    @body-click="onBodyClick" />
  <!-- 用户消息也走 MD 渲染（sanitize 后），和 AI 气泡同一条链路；样式差异由
       .user-md 在 GuguChat.vue 里按紫底气泡重映射。输入框侧保持纯文本不渲染。 -->
  <div v-else-if="(!msg.subagentOutput || subagentExpanded) && (msg.text || msg.references?.length)" class="msg-bubble" :class="msg.role === 'member' ? 'md-body' : 'user-md'" @click="onBodyClick">
    <MarkdownView :html="msg.html ?? renderChatMd(displayQQFaces(msg.text), msg.references)" :text="msg.text" chat render-math />
  </div>
  <div v-if="msg.role === 'user' && msg.runOutcome" class="msg-run-outcome" role="status">
    <span class="msg-run-outcome-label">
      {{ t(msg.runOutcome.status === 'interrupted' ? 'chatUi.runInterrupted' : 'chatUi.runFailed') }}
    </span>
    <span v-if="runOutcomeDetail">{{ runOutcomeDetail }}</span>
  </div>
  <!-- 卡片与正文共用应用内导航；外部链接由浏览器打开。 -->
  <div v-if="msg.linkButtons?.buttons?.length" class="msg-link-buttons interaction-bubble" role="group" :aria-label="msg.linkButtons.message || t('chatUi.gugu')">
    <div v-if="msg.linkButtons.message" class="interaction-body">{{ displayQQFaces(msg.linkButtons.message) }}</div>
    <div class="interaction-actions" @click="emit('actionClick', $event)">
      <ActionButton v-for="b in msg.linkButtons.buttons" :key="b.id" class="interaction-option" fit
                    :href="b.url" :target="/^gugu:\/\//i.test(b.url) ? undefined : '_blank'"
                    rel="noopener noreferrer" :aria-label="b.label">
        {{ b.label }}
      </ActionButton>
    </div>
  </div>
  <div v-if="msg.files && msg.files.length" class="msg-files">
    <template v-for="f in msg.files.filter(f => !f.quoted)" :key="f.file_path || f.attach_id || f.name">
    <!-- 语音条：点一下播放（带鉴权拉 blob），不是文件卡 -->
    <template v-if="f.kind === 'voice'">
    <div class="msg-voice-wrap">
      <div class="msg-voice" :class="{ playing: voicePlayingId === f.attach_id }"
           @click="$emit('toggleVoice', f)" :title="t('chat.clickPlayVoice')">
        <span class="mv-btn">
          <Icon name="media.pause" v-if="voicePlayingId === f.attach_id" :size="13" />
          <Icon name="media.play-fill" v-else :size="13" />
        </span>
        <span class="mv-wave"><i v-for="n in 13" :key="n" :style="{ height: `${voiceBars[n - 1]}%` }" /></span>
        <span class="mv-dur">{{ fmtDur(f.duration) }}</span>
        <button v-if="f.transcript || f.transcript_status" class="msg-voice-transcript-toggle"
                type="button" @click.stop="toggleTranscript(f)"
                :aria-expanded="isTranscriptOpen(f)"
                :aria-label="f.transcript_status === 'failed' ? t('chat.transcriptionFailed') : (isTranscriptOpen(f) ? t('chat.hideTranscription') : t('chat.showTranscription'))"
                :title="f.transcript_status === 'failed' ? t('chat.transcriptionFailed') : (isTranscriptOpen(f) ? t('chat.hideTranscription') : t('chat.showTranscription'))">
          {{ f.transcript_status === 'failed' ? '!' : (isTranscriptOpen(f) ? '−' : '文') }}
        </button>
      </div>
    </div>
    <div v-if="f.transcript && isTranscriptOpen(f)" class="msg-voice-transcript">{{ f.transcript }}</div>
    <div v-else-if="f.transcript_status === 'empty' && isTranscriptOpen(f)" class="msg-voice-transcript">{{ t('chat.transcriptionEmpty') }}</div>
    </template>
    <div v-else-if="f.qq_face" class="msg-face-image-wrap" @click="$emit('openFile', f)" :title="t('chat.viewEmoji')">
      <img class="msg-face-image" v-lazy-face="f.file_path || f.attach_id" draggable="false" :alt="t('chat.viewEmoji')" />
    </div>
    <div v-else class="chat-file-card-actions chat-attachment-card">
      <button type="button" class="chat-object-card" data-object-type="file"
              :title="canPreview(f) ? t('chat.preview') : t('chat.download')"
              @click="$emit('openFile', f)">
        <span v-if="isImageFile(f)" class="chat-attachment-preview" aria-hidden="true">
          <component :is="fileListIcon(f.ext)" :size="24" />
          <img v-if="f._thumbUrl" :src="f._thumbUrl" draggable="false" alt=""
               @load="($event.target as HTMLImageElement).classList.add('is-loaded')"
               @error="($event.target as HTMLImageElement).classList.remove('is-loaded')" />
          <img v-else v-lazy-thumb="f.file_path || f.attach_id" decoding="async" draggable="false" alt=""
               @load="($event.target as HTMLImageElement).classList.add('is-loaded')"
               @error="($event.target as HTMLImageElement).classList.remove('is-loaded')" />
        </span>
        <span class="chat-object-file-identity">
          <span v-if="!isImageFile(f)" class="chat-object-file-icon" :style="{ '--chat-file-icon-color': fileIconColor(f.ext) }" aria-hidden="true">
            <component :is="fileListIcon(f.ext)" :size="20" />
          </span>
          <span class="chat-object-card-title">{{ attachmentName(f) }}</span>
        </span>
        <span class="chat-object-card-details">
          <span class="chat-object-card-fact">
            <span class="chat-object-card-fact-label">{{ t('files.size') }}</span>
            <span class="chat-object-card-fact-value">{{ fmtSize(f.size_bytes ?? f.size) }}</span>
          </span>
        </span>
      </button>
      <button type="button" class="chat-file-card-download" :title="t('chat.download')"
              :aria-label="t('chat.download')" @click="$emit('download', f)">
        <Icon name="action.down" :size="16" />
      </button>
    </div>
    </template>
  </div>
  <div v-if="visibleTimestamp || showCopy" class="msg-footer">
    <span v-if="visibleTimestamp" class="msg-time">{{ visibleTimestamp }}</span>
    <button v-if="showCopy" class="msg-copy-btn" @click="$emit('copy', msg)" :title="t('chat.copy')">
      <Icon name="status.success" v-if="copiedId === msg.id" :size="11" />
      <Icon name="action.copy"  v-else :size="11" />
    </button>
  </div>
</template>

<script setup lang="ts">
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import Icon from '@/components/common/icons/Icon.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { useI18n } from 'vue-i18n'
import { computed, inject, ref } from 'vue'
import { translateAgentError } from '@/i18n'
/**
 * 单条消息展示：只接收消息对象和展示回调，不直接读取全局 Store、不直接修改会话数组。
 * 播放语音、打开/下载文件、复制正文、代码块复制和 gugu:// 协议链接都通过事件转发给
 * GuguChat.vue（这些动作牵涉共享的单实例状态——当前播放的语音、预览 Store、剪贴板——
 * 暂时仍由主组件持有，Phase 2/4 会把其中一部分收进对应 composable）。
 */
import MarkdownView from '@/components/common/content/MarkdownView.vue'
import GuguChatCitations from './GuguChatCitations.vue'
import type { ChatSource } from './chatSources'
import GuguChatInteraction from './GuguChatInteraction.vue'
import { findClickedChatReference, type ChatMessage, type ChatFile, type ChatReference, type InteractionAnswerMode } from './chatTypes'
import { renderMdStream, renderChatMd } from './markdown'
import { useStreamText } from './composables/useStreamText'
import {
  isImageFile, isAnimatedImageFile, canPreview,
  fmtSize, fmtDur, displayQQFaces,
} from './messageDisplay'
import { chatAttachmentImageKey } from './chatPresentationAccess'
import { makeLazyThumbDirective } from './lazyThumbDirective'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'
import { formatToolDuration } from './toolActivity'
const props = defineProps<{
  msg: ChatMessage
  timestamp?: string
  sources?: readonly ChatSource[]
  sessionId: number | null
  subagentExpanded?: boolean
  hasFollowingMessage?: boolean
  isGroupSession: boolean
  interactionAnswerMode: InteractionAnswerMode
  copiedId: number | null
  voicePlayingId: string | null
  voiceBars: number[]
}>()
const showCopy = computed(() => props.msg.role !== 'tool' && props.msg.role !== 'interaction' && Boolean(props.msg.text?.trim()))
const { displayed, presenting } = useStreamText(() => ({
  key: `${props.sessionId}:${props.msg._syncKey ?? props.msg.id}`,
  text: props.msg.role === 'ai' ? props.msg.text ?? '' : '',
  streaming: props.msg.role === 'ai' && Boolean(props.msg.streaming),
  hasFollowingMessage: Boolean(props.hasFollowingMessage),
}))
const assistantHtml = computed(() => {
  if (!presenting.value) return props.msg.html ?? renderChatMd(props.msg.text, props.msg.references)
  return renderMdStream(displayed.value)
})
const visibleTimestamp = computed(() => {
  const { msg, timestamp } = props
  if (!timestamp || msg.role === 'interaction') return undefined
  if (msg.role !== 'ai') return timestamp
  if (!msg.text?.trim()) {
    const files = msg.files?.filter(file => !file.quoted) ?? []
    const onlyFileCards = files.length > 0 && files.every(file => file.kind !== 'voice' && !file.qq_face)
    return msg.linkButtons?.buttons.length || onlyFileCards ? undefined : timestamp
  }
  const html = assistantHtml.value
  if (!html.includes('class="chat-object-cards')) return timestamp
  const content = document.createElement('template')
  content.innerHTML = html
  const blocks = [...content.content.childNodes].filter(node => node.nodeType === Node.ELEMENT_NODE || node.textContent?.trim())
  return blocks.length && blocks.every(node => node instanceof Element && node.classList.contains('chat-object-cards'))
    ? undefined : timestamp
})
const { t } = useI18n()
const memberSpeaker = computed(() => props.msg.subagentOutput ? props.msg.speakerLabel || t('chatUi.subagent')
  : props.isGroupSession && props.msg.role === 'member' ? props.msg.speakerLabel : undefined)
const openTranscripts = ref(new Set<string>())
const dismissedTranscripts = ref(new Set<string>())
function attachmentName(file: ChatFile) {
  const name = file.name || t('mindUi.unnamedFile')
  const ext = file.ext ? `.${file.ext}` : ''
  return ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name
}
function transcriptKey(file: ChatFile) {
  return String(file.attach_id || file.file_path || file.name || 'voice')
}
function isTranscriptOpen(file: ChatFile) {
  const key = transcriptKey(file)
  return openTranscripts.value.has(key)
    || (Boolean(file.transcript) && !dismissedTranscripts.value.has(key))
}
function toggleTranscript(file: ChatFile) {
  const key = transcriptKey(file)
  const next = new Set(openTranscripts.value)
  const dismissed = new Set(dismissedTranscripts.value)
  if (isTranscriptOpen(file)) {
    next.delete(key)
    dismissed.add(key)
  } else {
    dismissed.delete(key)
    next.add(key)
  }
  openTranscripts.value = next
  dismissedTranscripts.value = dismissed
}
const runOutcomeDetail = computed(() => {
  const outcome = props.msg.runOutcome
  if (outcome?.status !== 'failed' || !outcome.messageKey) return ''
  return translateAgentError(outcome.messageKey, outcome.messageParams)
})

const emit = defineEmits<{
  toggleSubagent: []
  copy: [msg: ChatMessage]
  toggleVoice: [file: ChatFile]
  openFile: [file: ChatFile]
  download: [file: ChatFile]
  actionClick: [e: MouseEvent]
  interactionSelect: [msg: ChatMessage, option: { id: string; label: string; token: string; selectedOptionIds?: string[]; customAnswer?: string }]
  interactionTextSubmit: [msg: ChatMessage, text: string]
  secretSubmit: [msg: ChatMessage, values: Record<string, string>]
  secretCancel: [msg: ChatMessage]
  referenceClick: [reference: ChatReference]
}>()

const readAttachmentImage = inject(chatAttachmentImageKey)
const vLazyThumb = makeLazyThumbDirective('card', readAttachmentImage)
// QQ 表情需要保留 GIF/动画 WebP，不能走会转成 JPEG 的 card 缩略图端点。
const vLazyFace = makeLazyThumbDirective('full', readAttachmentImage)

function onBodyClick(event: MouseEvent) {
  // gugu:// 动作链接交给主聊天组件统一拦截，避免浏览器把自定义协议当成外部请求。
  emit('actionClick', event)
  const reference = findClickedChatReference(event.target, props.msg.references)
  if (reference) emit('referenceClick', reference)
}
</script>

<style scoped>
.msg-voice-wrap {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
}

.msg-voice-transcript-toggle {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin-left: 1px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 12%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.82;
}

.msg-voice-transcript-toggle:hover { opacity: 1; background: color-mix(in srgb, currentColor 20%, transparent); }

.msg-voice-transcript {
  max-width: min(34rem, 80vw);
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--surface-glass);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.msg-run-outcome {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 7px;
  max-width: min(100%, 34rem);
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}

.msg-run-outcome-label {
  color: var(--color-danger, #b85b59);
  font-weight: 600;
}
</style>
