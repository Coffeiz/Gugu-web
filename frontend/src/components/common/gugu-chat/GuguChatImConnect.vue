<template>
  <div class="im-plat-group" ref="rootRef" :class="{ 'im-flash': imHighlight }">
    <div v-for="p in imPlatforms" :key="p.key" class="im-plat">
      <button class="im-plat-head" :class="{ open: imOpen[p.key] }" @click="onTogglePlatform(p.key)">
        <svg class="im-plat-chev" :class="{ open: imOpen[p.key] }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
        <span class="im-plat-name">{{ p.label }}</span>
        <span class="im-plat-badge" :class="{ on: botsOf(p.key).length }">{{ botsOf(p.key).length ? '已接入' : '未接入' }}</span>
      </button>
      <div v-show="imOpen[p.key]" class="im-plat-body">
        <template v-if="botsOf(p.key).length">
          <div v-for="s in imSessionsOf(p.key)" :key="s.id"
            class="exp-session-item" :class="{ active: s.id === sessionId }" @click="onLoadSession(s.id)">
            <span v-if="s.chatType === 'group'" class="exp-session-tag" title="群聊">群</span>
            <div class="exp-session-copy">
              <SessionTitleEdit :title="s.title" :on-rename="(t) => onRenameSession(s.id, t)" />
              <span v-if="formatSessionTime(s.updatedAt)" class="exp-session-time">{{ formatSessionTime(s.updatedAt) }}</span>
            </div>
            <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" title="删除"><PhTrash :size="12" weight="bold" /></button>
          </div>
          <div v-if="!imSessionsOf(p.key).length" class="exp-session-empty">暂无对话</div>
        </template>
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
import { ref, computed } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
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
  sessionId: number | null
  connect: ImConnectState | null
  connectHint: string
  connectErr: string
  connecting: string
  formatSessionTime: (raw?: string) => string
  onTogglePlatform: (key: ImPlatformKey) => void
  onSetConnectCanvas: (el: Element | import('vue').ComponentPublicInstance | null) => void
  onStartImConnect: (key: ImPlatformKey) => void
  onCancelImConnect: () => void
  onLoadSession: (id: number) => void
  onDeleteSession: (id: number) => void
  onRenameSession: (id: number, title: string) => void
}>()

const rootRef = ref<HTMLElement | null>(null)
defineExpose({ imGroupEl: computed(() => rootRef.value) })
</script>

<style scoped>
.im-plat-group { display:flex; flex-direction:column; gap:2px; border-radius:var(--radius-sm); }
.im-plat-group.im-flash { animation: imFlash 2.4s ease-out 1; }
@keyframes imFlash {
  0%,100% { box-shadow:0 0 0 0 color-mix(in srgb,var(--action-primary) 0%,transparent); }
  14% { box-shadow:0 0 0 2px color-mix(in srgb,var(--action-primary) 55%,transparent); }
  60% { box-shadow:0 0 0 2px color-mix(in srgb,var(--action-primary) 28%,transparent); }
}
.im-plat { display:flex; flex-direction:column; gap:2px; }
.im-plat-head {
  min-height: 36px;
  display:flex;
  align-items:center;
  gap:var(--space-sm);
  padding:var(--space-sm);
  border:1px solid transparent;
  border-radius:var(--radius-sm);
  background:transparent;
  color:var(--content-secondary);
  cursor:pointer;
  font-family:var(--font-sans);
  transition:background .14s ease,color .14s ease,border-color .14s ease;
}
.im-plat-head:hover { color:var(--content-primary); background:var(--gugu-chat-session-hover); }
.im-plat-head.open { color:var(--content-primary); background:var(--surface-soft); border-color:var(--border-hairline); }
/* Disclosure 统一约定：源图形默认向下，因此收起态左转 90° 指向右，展开态回到向下。 */
.im-plat-chev { color:var(--content-tertiary); transform:rotate(-90deg); transition:transform .18s ease; flex-shrink:0; }
.im-plat-chev.open { transform:rotate(0deg); }
.im-plat-name { flex:1; text-align:left; font-size:var(--font-size-sm); font-weight:var(--font-weight-semibold); }
.im-plat-badge {
  flex-shrink:0;
  padding:2px var(--space-xs);
  border-radius:var(--radius-xs);
  color:var(--content-tertiary);
  background:var(--surface-soft-hover);
  font-size:var(--font-size-xs);
  font-weight:var(--font-weight-medium);
  line-height:1;
}
.im-plat-badge.on { color:var(--status-success); background:var(--status-success-bg); }
/* IM session 是普通 session 的分组来源，不做树形缩进；平台、IM session 与相邻项统一 2px 节奏。 */
.im-plat-body { display:flex; flex-direction:column; gap:2px; padding:0; }
.im-connect-btn {
  width:100%;
  height:var(--control-sm);
  display:flex;
  align-items:center;
  justify-content:center;
  border:1px solid var(--border-default);
  border-radius:var(--radius-sm);
  color:var(--action-primary);
  background:var(--surface-raised);
  font:var(--font-weight-semibold) var(--font-size-sm) var(--font-sans);
  cursor:pointer;
  transition:background .15s ease,border-color .15s ease,transform .15s ease;
}
.im-connect-btn:hover:not(:disabled) { background:var(--surface-card-solid); border-color:var(--border-hover); }
.im-connect-btn:active:not(:disabled) { transform:translateY(1px); }
.im-connect-btn:disabled { opacity:.6; cursor:default; }
.im-qr-box { display:flex; flex-direction:column; align-items:center; gap:var(--space-sm); padding:var(--space-md) var(--space-sm); }
.im-qr-canvas { width:160px; height:160px; border-radius:var(--radius-sm); background:#fff; padding:var(--space-xs); box-sizing:border-box; box-shadow:var(--elevation-card); }
.im-qr-hint { font-size:var(--font-size-xs); color:var(--content-secondary); text-align:center; line-height:var(--line-height-body); }
.im-qr-err { font-size:var(--font-size-xs); color:var(--status-danger); padding:var(--space-xs) 0; }
.im-qr-cancel { font-size:var(--font-size-xs); color:var(--content-secondary); background:none; border:none; cursor:pointer; padding:var(--space-xs) var(--space-sm); border-radius:var(--radius-xs); }
.im-qr-cancel:hover { background:var(--surface-soft-hover); color:var(--content-primary); }
</style>
