<template>
  <div class="exp-sidebar panel-left">
    <div class="exp-sidebar-header">
      <span class="exp-sidebar-title">咕咕</span>
    </div>
    <div class="exp-sidebar-divider"></div>
    <div class="exp-session-list">
      <!-- IM 平台：飞书 / QQ / 微信，可展开抽屉。未接入 → 扫码连接；接入后 → 该平台会话 -->
      <GuguChatImConnect
        ref="imConnectRef"
        :im-platforms="imPlatforms" :im-open="imOpen" :im-highlight="imHighlight"
        :bots-of="botsOf" :im-sessions-of="imSessionsOf" :session-id="sessionId"
        :connect="connect" :connect-hint="connectHint" :connect-err="connectErr" :connecting="connecting"
        :on-toggle-platform="onTogglePlatform" :on-set-connect-canvas="onSetConnectCanvas"
        :on-start-im-connect="onStartImConnect" :on-cancel-im-connect="onCancelImConnect"
        :on-load-session="onLoadSession" :on-delete-session="onDeleteSession" :on-rename-session="onRenameSession"
      />

      <!-- 网页对话 -->
      <div v-if="webSessions.length" class="exp-group-divider"></div>
      <div
        v-for="s in webSessions" :key="s.id"
        class="exp-session-item"
        :data-session-id="s.id"
        :class="{ active: s.id === sessionId }"
        @click="onLoadSession(s.id)"
      >
        <SessionTitleEdit :title="s.title" :on-rename="(t) => onRenameSession(s.id, t)" />
        <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" title="删除">
          <PhTrash :size="12" weight="bold" />
        </button>
      </div>
    </div>
    <div class="exp-sidebar-divider" style="margin: 0 12px"></div>
    <div class="exp-new-session-wrap">
      <button class="exp-new-session-btn" @click="onNewSession">
        <PhPencilSimple weight="bold" :size="13" />
        新对话
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 大窗侧边栏：IM 平台抽屉（GuguChatImConnect.vue）+ 网页会话列表 + 新建会话。
 * 只做展示和事件转发，不持有会话数据或 IM 连接状态本身——这些仍在
 * GuguChat.vue（会话加载与流式紧耦合，IM 扫码连接是跨请求的轮询状态机，
 * 都不适合在这一步单独抽composable，标记为后续独立工作）。
 *
 * imGroupEl 通过 defineExpose 转发 GuguChatImConnect 自己暴露的同名值：
 * offline 状态被点击时（promptConnectIM）要展开侧栏、把 IM 分组滚入视口并
 * 高亮，这段一次性的滚动+高亮编排仍由父组件（useChatImConnect.ts）持有，
 * 只是要经这一层转发才能拿到实际 DOM（IM 分组的 DOM 现在归子组件所有）。
 */
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

const imConnectRef = ref<InstanceType<typeof GuguChatImConnect> | null>(null)
defineExpose({ imGroupEl: computed(() => imConnectRef.value?.imGroupEl ?? null) })
</script>

<style scoped>
.exp-sidebar {
  width: 210px; flex-shrink: 0;
  display: flex; flex-direction: column;
}
.exp-sidebar-header {
  display: flex; align-items: center;
  padding: 16px 14px 12px;
  flex-shrink: 0;
}
.exp-sidebar-divider {
  height: 1px; flex-shrink: 0; margin: 0 4px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-group-divider {
  height: 1px; flex-shrink: 0; margin: 4px 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-sidebar-title { flex: 1; font-size: 14px; font-weight: 700; color: var(--text-primary); text-align: center; }

.exp-new-session-wrap {
  padding: 10px 10px 12px;
  flex-shrink: 0;
}
.exp-new-session-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.exp-new-session-btn:hover {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.exp-new-session-btn:active {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.exp-new-session-btn svg { display: block; }

.exp-session-list {
  flex: 1; overflow-y: auto;
  padding: 8px;
  display: flex; flex-direction: column; gap: 2px;
}
/* exp-session-item 系列类名同时用于本组件的网页会话列表和
   GuguChatImConnect.vue 子组件的 IM 会话列表——用 :deep() 而不是各自
   重复一份，样式只维护一处（跟 GuguChat.vue 用 :deep() 覆盖 MessageRow
   的做法一致）。 */
:deep(.exp-session-item) {
  display: flex; align-items: center; gap: 1px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  transition: background 0.12s;
  flex-shrink: 0;  /* 防止 line-height 调整后被外层 flex column 压扁 */
}
:deep(.exp-session-item:hover) { background: rgba(255,255,255,0.55); }
:deep(.exp-session-item.active) { background: rgba(123,127,178,0.12); }
:deep(.exp-session-item.active .exp-session-title) { font-weight: 700; }
:deep(.exp-session-del) {
  width: 20px; height: 20px; border-radius: 5px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.15s, background 0.15s; flex-shrink: 0;
}
/* 重命名按钮与删除按钮：整个会话项 hover 时一起浮现（判定区域一致，动画同文件卡 0.15s） */
:deep(.exp-session-item:hover .exp-session-rename-btn),
:deep(.exp-session-item:hover .exp-session-del) { opacity: 1; }
:deep(.exp-session-del:hover) { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }
:deep(.exp-session-del svg) { display: block; }
:deep(.exp-session-empty) { font-size: 12px; color: var(--text-secondary); padding: 12px 10px; }
.exp-session-source {
  flex-shrink: 0; font-size: 11px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans); letter-spacing: 0.01em;
  padding: 2px 5px; border-radius: 4px;
}
.exp-session-source.src-qq { background: rgba(18,183,245,0.15); color: #0c8fc0; }
.exp-session-source.src-feishu { background: rgba(66,133,244,0.15); color: #3b6fc4; }
:deep(.exp-session-tag) {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans);
  padding: 2px 4px; border-radius: 4px;
  background: rgba(123,127,178,0.15); color: #6a6ea3;
}

/* IM 平台抽屉的样式（分组高亮、扫码连接、二维码）已随 GuguChatImConnect.vue 迁移 */
</style>
