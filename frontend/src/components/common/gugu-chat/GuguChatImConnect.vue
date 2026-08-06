<template>
  <div class="im-plat-group" ref="rootRef" :class="{ 'im-flash': imHighlight }">
    <div v-for="p in imPlatforms" :key="p.key" class="im-plat">
      <button class="im-plat-head" :class="{ open: imOpen[p.key] }" @click="onTogglePlatform(p.key)">
        <svg class="im-plat-chev" :class="{ open: imOpen[p.key] }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
        <span class="im-plat-name">{{ p.label }}</span>
        <span class="im-plat-badge" :class="{ on: botsOf(p.key).length }">{{ botsOf(p.key).length ? '已接入' : '未接入' }}</span>
      </button>
      <div v-show="imOpen[p.key]" class="im-plat-body">
        <!-- 已接入 → 该平台会话抽屉 -->
        <template v-if="botsOf(p.key).length">
          <div v-for="s in imSessionsOf(p.key)" :key="s.id"
            class="exp-session-item" :class="{ active: s.id === sessionId }" @click="onLoadSession(s.id)">
            <span v-if="s.chatType === 'group'" class="exp-session-tag" title="群聊">群</span>
            <span class="exp-session-title">{{ s.title }}</span>
            <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" title="删除"><PhTrash :size="12" weight="bold" /></button>
          </div>
          <div v-if="!imSessionsOf(p.key).length" class="exp-session-empty">暂无对话</div>
        </template>
        <!-- 未接入 → 扫码连接 + 二维码抽屉 -->
        <template v-else>
          <div v-if="connect && connect.platform === p.key" class="im-qr-box">
            <canvas :ref="onSetConnectCanvas" class="im-qr-canvas"></canvas>
            <div class="im-qr-hint">{{ connectHint }}</div>
            <button class="im-qr-cancel" @click="onCancelImConnect">取消</button>
          </div>
          <template v-else>
            <button class="im-connect-btn" :disabled="connecting === p.key" @click="onStartImConnect(p.key)">
              {{ connecting === p.key ? '生成中…' : '扫码连接' }}
            </button>
            <div v-if="connectErr && connecting !== p.key" class="im-qr-err">{{ connectErr }}</div>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * IM 平台二维码连接视图：飞书 / QQ / 微信抽屉——已接入显示该平台会话列表，
 * 未接入显示扫码连接入口和二维码。只做展示和事件转发，不持有 IM 连接状态
 * 本身（那是跨请求的轮询状态机，由 useChatImConnect.ts 持有，GuguChat.vue
 * 组合后把状态和回调一起传下来）。
 *
 * rootRef 通过 defineExpose 暴露给 GuguChatSidebar.vue 转发：offline 状态被
 * 点击时（promptConnectIM）要展开侧栏、把这个 IM 分组滚入视口并高亮，这段
 * 一次性的滚动+高亮编排仍由 GuguChat.vue/useChatImConnect.ts 持有。
 *
 * exp-session-item / exp-session-tag / exp-session-del / exp-session-empty
 * 这几个类名和 GuguChatSidebar.vue 的网页会话列表共用——样式没有在这里重复
 * 定义，由 GuguChatSidebar.vue 用 :deep() 统一覆盖到这个子组件里。
 */
import { ref, computed } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
import type { ChatSession, ImPlatformKey } from './chatTypes'

interface ImPlatformOption { key: ImPlatformKey; label: string }
interface ImConnectState { platform: string; id: string | number }

defineProps<{
  imPlatforms: ImPlatformOption[]
  imOpen: Record<ImPlatformKey, boolean>
  imHighlight: boolean
  botsOf: (platform: ImPlatformKey) => unknown[]
  imSessionsOf: (platform: ImPlatformKey) => ChatSession[]
  sessionId: number | null
  connect: ImConnectState | null
  connectHint: string
  connectErr: string
  connecting: string
  onTogglePlatform: (key: ImPlatformKey) => void
  onSetConnectCanvas: (el: Element | import('vue').ComponentPublicInstance | null) => void
  onStartImConnect: (key: ImPlatformKey) => void
  onCancelImConnect: () => void
  onLoadSession: (id: number) => void
  onDeleteSession: (id: number) => void
}>()

const rootRef = ref<HTMLElement | null>(null)
defineExpose({ imGroupEl: computed(() => rootRef.value) })
</script>

<style scoped>
/* 点击离线后，IM 区短暂高亮一下引导视线（不留痕） */
.im-plat-group { border-radius: 10px; }
.im-plat-group.im-flash { animation: imFlash 2.4s ease-out 1; }
@keyframes imFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(123, 127, 178, 0); }
  14%      { box-shadow: 0 0 0 2px rgba(123, 127, 178, 0.55); }
  60%      { box-shadow: 0 0 0 2px rgba(123, 127, 178, 0.28); }
}

/* IM 平台抽屉（飞书 / QQ / 微信） */
.im-plat { display: flex; flex-direction: column; }
.im-plat-head {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 10px; border-radius: 9px; border: none; cursor: pointer;
  background: none; font-family: var(--font-sans);
  transition: background 0.12s;
}
.im-plat-head:hover { background: rgba(255,255,255,0.55); }
.im-plat-head.open { background: rgba(123,127,178,0.08); }
.im-plat-chev { color: var(--text-secondary); transition: transform 0.18s ease; flex-shrink: 0; }
.im-plat-chev.open { transform: rotate(-180deg); }
.im-plat-name { flex: 1; text-align: left; font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.im-plat-badge {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 2px 6px; border-radius: 4px;
  background: rgba(123,127,178,0.12); color: var(--text-secondary);
}
.im-plat-badge.on { background: rgba(74,180,120,0.16); color: #2f9e63; }
.im-plat-body {
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 0 6px;
}
.im-connect-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  margin: 4px 0 2px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.im-connect-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.im-connect-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.im-connect-btn:disabled { opacity: 0.6; cursor: default; }
.im-qr-box {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 12px 8px 10px;
}
.im-qr-canvas {
  width: 160px; height: 160px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.im-qr-hint { font-size: 11.5px; color: var(--text-secondary); text-align: center; line-height: 1.5; }
.im-qr-err { font-size: 11.5px; color: rgba(200,80,80,0.9); padding: 4px 0; }
.im-qr-cancel {
  font-size: 11.5px; color: var(--text-secondary); background: none; border: none;
  cursor: pointer; padding: 3px 10px; border-radius: 6px; transition: background 0.12s;
}
.im-qr-cancel:hover { background: rgba(123,127,178,0.12); color: var(--text-primary); }
</style>
