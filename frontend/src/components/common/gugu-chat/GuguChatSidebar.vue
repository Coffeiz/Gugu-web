<template>
  <div class="exp-sidebar">
    <div class="exp-sidebar-header">
      <span class="exp-sidebar-title">咕咕</span>
    </div>

    <div class="exp-sidebar-divider"></div>
    <div class="exp-session-list scroll-surface scroll-surface--compact">
      <!-- 即时通讯区域：保留真实平台折叠/扫码/会话行为，只统一视觉和最后对话时间。 -->
      <span class="sidebar-caption">即时通讯</span>
      <GuguChatImConnect
        ref="imConnectRef"
        :im-platforms="imPlatforms" :im-open="imOpen" :im-highlight="imHighlight"
        :bots-of="botsOf" :im-sessions-of="imSessionsOf" :session-id="sessionId"
        :connect="connect" :connect-hint="connectHint" :connect-err="connectErr" :connecting="connecting"
        :format-session-time="formatSessionTime"
        :on-toggle-platform="onTogglePlatform" :on-set-connect-canvas="onSetConnectCanvas"
        :on-start-im-connect="onStartImConnect" :on-cancel-im-connect="onCancelImConnect"
        :on-load-session="onLoadSession" :on-delete-session="onDeleteSession" :on-rename-session="onRenameSession"
      />

      <!-- 网页对话 -->
      <div class="exp-group-divider"></div>
      <span class="sidebar-caption">最近对话</span>
      <div
        v-for="s in webSessions" :key="s.id"
        class="exp-session-item"
        :data-session-id="s.id"
        :class="{ active: s.id === sessionId }"
        @click="onLoadSession(s.id)"
      >
        <div class="exp-session-copy">
          <SessionTitleEdit :title="s.title" :on-rename="(t) => onRenameSession(s.id, t)" />
          <span v-if="formatSessionTime(s.updatedAt)" class="exp-session-time">{{ formatSessionTime(s.updatedAt) }}</span>
        </div>
        <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" title="删除">
          <PhTrash :size="12" weight="bold" />
        </button>
      </div>
      <div v-if="!webSessions.length" class="exp-session-empty">还没有网页对话</div>
    </div>

    <div class="exp-sidebar-divider"></div>
    <div class="exp-new-session-wrap">
      <button class="exp-new-session-btn" @click="onNewSession">
        <PhPencilSimple weight="bold" :size="13" />
        新对话
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, type ComponentPublicInstance } from 'vue'
import { PhTrash, PhPencilSimple } from '@phosphor-icons/vue'
import GuguChatImConnect from './GuguChatImConnect.vue'
import SessionTitleEdit from './SessionTitleEdit.vue'
import type { ChatSession, ImPlatformKey } from './chatTypes'

interface ImPlatformOption { key: ImPlatformKey; label: string }
interface ImConnectState { platform: string; id: string | number }

defineProps<{
  imPlatforms: ImPlatformOption[]
  imOpen: Record<ImPlatformKey, boolean>
  imHighlight: boolean
  botsOf: (platform: ImPlatformKey) => unknown[]
  imSessionsOf: (platform: ImPlatformKey) => ChatSession[]
  webSessions: ChatSession[]
  sessionId: number | null
  connect: ImConnectState | null
  connectHint: string
  connectErr: string
  connecting: string
  onTogglePlatform: (key: ImPlatformKey) => void
  onSetConnectCanvas: (el: Element | ComponentPublicInstance | null) => void
  onStartImConnect: (key: ImPlatformKey) => void
  onCancelImConnect: () => void
  onLoadSession: (id: number) => void
  onDeleteSession: (id: number) => void
  onRenameSession: (id: number, title: string) => void
  onNewSession: () => void
}>()

function formatSessionTime(raw?: string) {
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

const imConnectRef = ref<InstanceType<typeof GuguChatImConnect> | null>(null)
defineExpose({ imGroupEl: computed(() => imConnectRef.value?.imGroupEl ?? null) })
</script>

<style scoped>
.exp-sidebar {
  width: 210px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  color: var(--content-primary);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}
.exp-sidebar-header {
  min-height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-md);
  flex-shrink: 0;
}
.exp-sidebar-title { font-size: var(--font-size-md); font-weight: var(--font-weight-bold); }
.exp-sidebar-divider,
.exp-group-divider {
  height: 1px;
  flex-shrink: 0;
  background: var(--divider-line);
}
.exp-sidebar-divider { margin: 0 var(--space-md); }
.exp-group-divider { margin: var(--space-sm) var(--space-xs); }

.exp-new-session-wrap {
  min-height: 48px;
  box-sizing: border-box;
  padding: var(--space-sm);
  flex-shrink: 0;
}
.exp-new-session-btn {
  width: 100%;
  height: var(--control-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--action-primary);
  background: color-mix(in srgb,var(--surface-raised) 84%,transparent);
  box-shadow: var(--elevation-card);
  font: var(--font-weight-semibold) var(--font-size-sm) var(--font-sans);
  cursor: pointer;
}
.exp-new-session-btn:hover { background: var(--surface-raised); border-color: var(--border-hover); box-shadow: var(--elevation-card-hover); }
.exp-new-session-btn:active { transform: translateY(1px); }

.exp-session-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-md) var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sidebar-caption {
  display: block;
  padding: var(--space-xs) var(--space-sm);
  color: var(--gugu-chat-caption);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--tracking-label);
}

:deep(.exp-session-item) {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--content-secondary);
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
}
:deep(.exp-session-item.active) {
  color: var(--gugu-chat-session-active-fg);
  background: var(--gugu-chat-session-active);
  border-color: var(--sidebar-item-active-border);
  box-shadow: var(--sidebar-item-active-shadow);
}
:deep(.exp-session-copy) { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-xs); }
:deep(.exp-session-time) { color: var(--content-tertiary); font-size: var(--font-size-xs); line-height: 1; }
:deep(.exp-session-item.active .exp-session-title) { font-weight: var(--font-weight-semibold); }
:deep(.exp-session-del) {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  border: none;
  background: transparent;
  color: var(--content-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  flex-shrink: 0;
}
:deep(.exp-session-item:hover .exp-session-rename-btn),
:deep(.exp-session-item:hover .exp-session-del) { opacity: 1; }
:deep(.exp-session-del:hover) { background: var(--status-danger-bg); color: var(--status-danger); }
:deep(.exp-session-empty) { font-size: var(--font-size-xs); color: var(--content-tertiary); padding: var(--space-sm); }
:deep(.exp-session-tag) {
  flex-shrink: 0;
  padding: 2px var(--space-xs);
  border-radius: var(--radius-xs);
  color: var(--selection-fg);
  background: var(--selection-bg);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 1;
}
</style>