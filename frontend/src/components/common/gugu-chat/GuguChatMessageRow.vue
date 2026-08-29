<template>
  <GuguChatToolBubble v-if="msg.role === 'tool'" :msg="msg" />
  <GuguChatInteraction v-else-if="msg.role === 'interaction'" :msg="msg" @select="(selectedMsg, option) => $emit('interactionSelect', selectedMsg, option)" />
  <!-- 群聊左侧消息标发言人：ai 标"咕咕"，群成员标 platformUserName。只在
       群聊会话里显示，1:1 对话左侧默认就是咕咕，不额外占地方。 -->
  <div v-if="isGroupSession && msg.role !== 'user'" class="msg-speaker">{{ msg.role === 'ai' ? '咕咕' : msg.speakerLabel }}</div>
  <!-- IM 引用/回复：单独一条浅色预览条，跟真正打的话分开显示，别把引用原文
       （可能带 markdown 表格等）直接摊平混进正文气泡（devlog 2026-07-10）。 -->
  <div v-if="msg.role !== 'ai' && (msg.quotedText || msg.files?.some(f => f.quoted))" class="msg-quoted" :title="msg.quotedText || '引用的 QQ 表情'">
    <span v-if="msg.quotedText">{{ displayQQFaces(msg.quotedText) }}</span>
    <template v-for="f in (msg.files || []).filter(f => f.quoted)" :key="`quoted:${f.file_id || f.attach_id}`">
      <img v-if="f.qq_face || isAnimatedImageFile(f)" class="msg-quoted-thumb msg-face-gif" v-lazy-face="f.file_id || f.attach_id" draggable="false" alt="引用图片" @click.stop="$emit('openFile', f)" />
      <img v-else-if="f._thumbUrl" class="msg-quoted-thumb" :src="f._thumbUrl" draggable="false" alt="引用图片" @click.stop="$emit('openFile', f)" />
      <img v-else-if="isImageFile(f)" class="msg-quoted-thumb" v-lazy-thumb="f.file_id || f.attach_id" draggable="false" alt="引用图片" @click.stop="$emit('openFile', f)" />
    </template>
  </div>
  <div v-if="msg.role === 'ai' && (msg.text?.trim() || msg.streaming)" class="msg-bubble md-body" @click="$emit('actionClick', $event)"><MarkdownView :html="msg.streaming ? renderMdStream(msg.text) : (msg.html ?? renderMd(msg.text))" :text="msg.text" chat /></div>
  <div v-else-if="msg.text" class="msg-bubble">{{ displayQQFaces(msg.text) }}</div>
  <div v-if="msg.files && msg.files.length" class="msg-files">
    <template v-for="f in msg.files.filter(f => !f.quoted)" :key="f.file_id || f.attach_id">
    <!-- 语音条：点一下播放（带鉴权拉 blob），不是文件卡 -->
    <div v-if="f.kind === 'voice'" class="msg-voice" :class="{ playing: voicePlayingId === f.attach_id }"
         @click="$emit('toggleVoice', f)" title="点击播放语音">
      <span class="mv-btn">
        <Icon name="media.pause" v-if="voicePlayingId === f.attach_id" :size="13" />
        <Icon name="media.play"  v-else :size="13" />
      </span>
      <span class="mv-wave"><i v-for="n in 13" :key="n" :style="{ height: voiceBar(n) }" /></span>
      <span class="mv-dur">{{ fmtDur(f.duration) }}</span>
    </div>
    <div v-else-if="f.qq_face" class="msg-face-image-wrap" @click="$emit('openFile', f)" title="点击查看表情">
      <img class="msg-face-image" v-lazy-face="f.file_id || f.attach_id" draggable="false" alt="QQ表情" />
    </div>
    <div v-else class="msg-file press-fx" @click="$emit('openFile', f)" :title="canPreview(f) ? '点击预览' : '点击下载'">
      <span class="msg-file-ext">
        <template v-if="!f.qq_face">{{ (f.ext || 'file').toUpperCase().slice(0, 4) }}</template>
        <template v-if="isImageFile(f)">
          <img v-if="f._thumbUrl" class="msg-file-thumb" :src="f._thumbUrl"
            draggable="false" alt="" @error="($event.target as HTMLElement).remove()" />
          <img v-else class="msg-file-thumb" v-lazy-thumb="f.file_id || f.attach_id"
            decoding="async" draggable="false" alt="" @error="($event.target as HTMLElement).remove()" />
        </template>
      </span>
      <span class="msg-file-info">
        <span v-if="!f.qq_face" class="msg-file-name">{{ f.name }}.{{ f.ext }}</span>
        <span class="msg-file-meta">{{ fmtSize(f.size_bytes) }} · {{ canPreview(f) ? '预览' : '下载' }}</span>
      </span>
      <svg class="msg-file-dl" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" title="下载" @click.stop="$emit('download', f)"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>
    </div>
    </template>
  </div>
  <div v-if="msg.role !== 'tool' && msg.role !== 'interaction'" class="msg-footer">
    <span class="msg-time">{{ msg.time }}</span>
    <button class="msg-copy-btn" @click="$emit('copy', msg)" title="复制">
      <Icon name="status.success" v-if="copiedId === msg.id" :size="11" />
      <Icon name="action.copy"  v-else :size="11" />
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
/**
 * 单条消息展示：只接收消息对象和展示回调，不直接读取全局 Store、不直接修改会话数组。
 * 播放语音、打开/下载文件、复制正文、代码块复制和 gugu:// 协议链接都通过事件转发给
 * GuguChat.vue（这些动作牵涉共享的单实例状态——当前播放的语音、预览 Store、剪贴板——
 * 暂时仍由主组件持有，Phase 2/4 会把其中一部分收进对应 composable）。
 */
import MarkdownView from '@/components/common/MarkdownView.vue'
import GuguChatToolBubble from './GuguChatToolBubble.vue'
import GuguChatInteraction from './GuguChatInteraction.vue'
import type { ChatMessage, ChatFile } from './chatTypes'
import { renderMd, renderMdStream } from './markdown'
import {
  isImageFile, isAnimatedImageFile, canPreview,
  fmtSize, fmtDur, voiceBar, displayQQFaces,
} from './messageDisplay'
import { makeLazyThumbDirective } from './lazyThumbDirective'

defineProps<{
  msg: ChatMessage
  isGroupSession: boolean
  copiedId: number | null
  voicePlayingId: string | null
}>()

defineEmits<{
  copy: [msg: ChatMessage]
  toggleVoice: [file: ChatFile]
  openFile: [file: ChatFile]
  download: [file: ChatFile]
  actionClick: [e: MouseEvent]
  interactionSelect: [msg: ChatMessage, option: { id: string; label: string; token: string }]
}>()

const vLazyThumb = makeLazyThumbDirective('card')
// QQ 表情需要保留 GIF/动画 WebP，不能走会转成 JPEG 的 card 缩略图端点。
const vLazyFace = makeLazyThumbDirective('full')
</script>
