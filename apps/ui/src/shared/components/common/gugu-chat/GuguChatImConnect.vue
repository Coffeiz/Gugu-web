<template>
  <div class="im-plat-group" ref="rootRef" :class="{ 'im-flash': imHighlight }">
    <div v-for="p in imPlatforms" :key="p.key" class="im-plat">
      <button class="im-plat-head" :class="{ open: imOpen[p.key] }" @click="onTogglePlatform(p.key)">
        <svg class="im-plat-chev" :class="{ open: imOpen[p.key] }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
        <span class="im-plat-name">{{ p.label }}</span>
        <span class="im-plat-badge" :class="{ on: botsOf(p.key).some(bot => bot.enabled) }">{{ statusLabel(botsOf(p.key)) }}</span>
      </button>
      <div v-show="imOpen[p.key]" class="im-plat-body">
        <template v-if="botsOf(p.key).length">
          <div v-for="s in imSessionsOf(p.key)" :key="s.id"
            class="exp-session-item" :class="{ active: s.id === sessionId }" @click="onLoadSession(s.id)">
            <span v-if="s.chatType === 'group'" class="exp-session-tag" :title="t('chatUi.groupChat')">{{ t('chatUi.group') }}</span>
            <div class="exp-session-copy">
              <SessionTitleEdit :title="s.title" :running="s.isRunning === true" :on-rename="(t) => onRenameSession(s.id, t)" />
              <span v-if="formatSessionTime(s.updatedAt)" class="exp-session-time">{{ formatSessionTime(s.updatedAt) }}</span>
            </div>
            <button class="exp-session-del" @click.stop="onDeleteSession(s.id)" :title="t('common.actions.delete')"><Icon name="action.delete" :size="12" /></button>
          </div>
          <div v-if="p.key === 'telegram' && botsOf(p.key)[0]?.ownerBound === false" class="exp-session-empty">
            <button type="button" class="im-connect-btn" @click="onOpenTelegramTokenDialog(true)">{{ t('profileImUi.telegramGetCode') }}</button>
          </div>
          <div v-else-if="!imSessionsOf(p.key).length" class="exp-session-empty">{{ t('chatUi.noSessions') }}</div>
        </template>
        <template v-else>
          <div v-if="connect && connect.platform === p.key" class="im-qr-box">
            <canvas :ref="onSetConnectCanvas" class="im-qr-canvas"></canvas>
            <div class="im-qr-hint">{{ connectHint }}</div>
            <button class="im-qr-cancel" @click="onCancelImConnect">{{ t('common.actions.cancel') }}</button>
          </div>
          <template v-else-if="p.key === 'telegram'">
            <button class="im-connect-btn" @click="onOpenTelegramTokenDialog()">{{ t('chatUi.connectTelegramBot') }}</button>
          </template>
          <template v-else>
            <button class="im-connect-btn" :disabled="connecting === p.key" @click="onStartImConnect(p.key)">
              {{ connecting === p.key ? t('chatUi.generatingQr') : t('chatUi.scanConnect') }}
            </button>
            <div v-if="connectErr && connecting !== p.key" class="im-qr-err">{{ connectErr }}</div>
          </template>
        </template>
      </div>
    </div>
    <TelegramTokenDialog
      :show="telegramTokenDialogOpen"
      :busy="telegramConnecting"
      :error="telegramConnectError"
      :binding-step="telegramBindingStep" @generate="onOpenTelegramTokenDialog(true)"
      @close="onCloseTelegramTokenDialog"
      @submit="onSubmitTelegramToken"
    />
  </div>
</template>

<script setup lang="ts">
import type { ChatImBot, TelegramBindingStep } from './composables/useChatImConnect'
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import TelegramTokenDialog from './TelegramTokenDialog.vue'
import SessionTitleEdit from './SessionTitleEdit.vue'
import type { ChatSession, ImPlatformKey } from './chatTypes'
const { t } = useI18n()

function statusLabel(bots: ChatImBot[]) {
  if (bots.some(bot => bot.enabled)) return t('chatUi.connected')
  if (!bots.length) return t('chatUi.notConnected')
  const bot = bots[0]
  if (bot.telegramStatus) {
    if (bot.ownerBound === false && bot.telegramStatus === 'connected') return t('profileImUi.telegramPendingBinding')
    return t(`desktopTelegram.${bot.telegramStatus}`)
  }
  const state = bot.connectionState
  return t(state && state !== 'running' ? `profileImUi.${state}` : 'profileImUi.connecting')
}

interface ImPlatformOption { key: ImPlatformKey; label: string }
interface ImConnectState { platform: string; id: string | number }

defineProps<{
  imPlatforms: ImPlatformOption[]
  imOpen: Record<ImPlatformKey, boolean>
  imHighlight: boolean
  botsOf: (platform: ImPlatformKey) => ChatImBot[]
  imSessionsOf: (platform: ImPlatformKey) => ChatSession[]
  sessionId: number | null
  connect: ImConnectState | null
  connectHint: string
  connectErr: string
  connecting: string
  formatSessionTime: (raw?: string) => string
  telegramTokenDialogOpen: boolean
  telegramConnecting: boolean
  telegramConnectError: string
  telegramBindingStep?: TelegramBindingStep
  onOpenTelegramTokenDialog: (binding?: boolean) => void
  onCloseTelegramTokenDialog: () => void
  onSubmitTelegramToken: (token: string) => void
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
.im-plat-group { display:flex; flex-direction:column; gap:2px; border-radius:var(--radius-xs); }
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
  border-radius:var(--radius-xs);
  background:transparent;
  color:var(--content-secondary);
  cursor:pointer;
  font-family:var(--font-sans);
  transition:background .14s ease,color .14s ease,border-color .14s ease;
}
.im-plat-head:hover { color:var(--content-primary); background:var(--sidebar-item-hover); }
.im-plat-head.open { color:var(--content-primary); background:var(--surface-soft); }
/* Disclosure 统一约定：源图形默认向下，因此收起态左转 90° 指向右，展开态回到向下。 */
.im-plat-chev { color:var(--content-tertiary); transform:rotate(-90deg); transition:transform .18s ease; flex-shrink:0; }
.im-plat-chev.open { transform:rotate(0deg); }
.im-plat-name { flex:1; text-align:left; font-size:var(--font-size-sm); font-weight:var(--font-weight-semibold); }
.im-plat-badge {
  flex-shrink:0;
  padding:2px var(--space-xs);
  border-radius:var(--radius-compact);
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
  border-radius:var(--radius-xs);
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
.im-qr-canvas { width:160px; height:160px; border-radius:var(--radius-xs); background:#fff; padding:var(--space-xs); box-sizing:border-box; box-shadow:var(--elevation-card); }
.im-qr-hint { font-size:var(--font-size-xs); color:var(--content-secondary); text-align:center; line-height:var(--line-height-body); }
.im-qr-err { font-size:var(--font-size-xs); color:var(--status-danger); padding:var(--space-xs) 0; }
.im-qr-cancel { display:inline-flex; align-items:center; justify-content:center; min-height:var(--control-height-sm); font-size:var(--font-size-xs); font-family:inherit; color:var(--content-primary); background:var(--control-bg); border:1px solid var(--content-divider); cursor:pointer; padding:var(--space-xs) var(--space-md); border-radius:var(--radius-compact); transition:background-color var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard); }
.im-qr-cancel:hover { background:var(--surface-soft-hover); color:var(--content-primary); border-color:var(--input-border-hover); }
.im-qr-cancel:focus-visible { outline:2px solid var(--action-primary); outline-offset:2px; }
@media (prefers-reduced-motion: reduce) { .im-qr-cancel { transition:none; } }
</style>
