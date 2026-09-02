<template>
  <div class="notif-page">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ t('adminNotifications.title') }}</h2>
        <p class="page-desc">{{ t('adminNotifications.description') }}</p>
      </div>
    </div>

    <div class="content-grid">
      <!-- 编辑区 -->
      <div class="compose-card">
        <div class="compose-title">{{ t('adminNotifications.compose') }}</div>

        <div class="field">
          <label>{{ t('adminNotifications.titleLabel') }} <span class="opt">{{ t('adminNotifications.optional') }}</span></label>
          <input v-model="form.title" :placeholder="t('adminNotifications.titlePlaceholder')" maxlength="100" class="text-input" />
        </div>

        <div class="field">
          <label>{{ t('adminNotifications.contentLabel') }} <span class="opt">{{ t('adminNotifications.markdownOptional') }}</span></label>
          <textarea v-model="form.content" rows="4" :placeholder="t('adminNotifications.contentPlaceholder')" class="text-input textarea" />
        </div>

        <div class="field">
          <label>{{ t('adminNotifications.channel') }}</label>
          <div class="channel-row">
            <button v-for="c in CHANNELS" :key="c.value"
                    class="channel-chip" :class="{ active: form.channel === c.value }"
                    @click="form.channel = c.value" :title="c.hint">
              {{ c.label }}
            </button>
          </div>
          <span class="channel-hint">{{ CHANNELS.find(c => c.value === form.channel)?.hint }}</span>
        </div>

        <div class="field" v-if="form.channel !== 'center'">
          <label>{{ t('adminNotifications.ttl') }}</label>
          <div class="channel-row">
            <button v-for="t in BUBBLE_TTLS" :key="String(t.value)"
                    class="channel-chip" :class="{ active: form.bubbleTtl === t.value }"
                    @click="form.bubbleTtl = t.value">
              {{ t.label }}
            </button>
          </div>
          <span class="channel-hint">{{ t('adminNotifications.ttlHint') }}</span>
        </div>

        <!-- 预览（与用户端咕咕玻璃气泡 1:1 一致） -->
        <div class="preview-label">{{ t('adminNotifications.preview') }}</div>
        <div class="preview-bubble" :class="{ 'pv-bare': !form.title }">
          <button class="pv-close" tabindex="-1">
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <line x1="1.5" y1="1.5" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5"/>
            </svg>
          </button>
          <div v-if="form.title || !form.content" class="pv-head">
            <span class="pv-dot" />
            <div class="pv-title">{{ form.title || t('adminNotifications.defaultTitle') }}</div>
          </div>
          <div v-if="form.content" class="pv-content md-nb" v-html="renderMarkdown(form.content)" />
        </div>

        <div v-if="err" class="err-msg">{{ err }}</div>

        <button class="send-btn" :disabled="sending || (!form.title.trim() && !form.content.trim())" @click="send">
          <svg v-if="sending" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="spinning-inf"><path d="M12 7A5 5 0 1 1 7 2"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2L2 8l4 2 2 4 2-6z"/></svg>
          {{ t('adminNotifications.sendAll') }}
        </button>
      </div>

      <!-- 历史 -->
      <div class="history-card">
        <div class="history-header">
          <span class="compose-title">{{ t('adminNotifications.history') }}</span>
          <RefreshButton :loading="refreshingHistory" :disabled="loadingHistory" @click="loadHistory" :title="t('adminNotifications.refresh')" />
        </div>

        <div v-if="!history.length && !loadingHistory" class="empty-hint">{{ t('adminNotifications.empty') }}</div>

        <div class="history-list">
          <div v-for="n in history" :key="n.id" class="history-row">
            <div class="hr-dot" />
            <div class="hr-body">
              <div class="hr-title">{{ n.title }}</div>
              <div v-if="n.content" class="hr-content">{{ n.content }}</div>
              <div class="hr-meta">{{ fmtTime(n.created_at) }} · {{ n.target === 'all' ? t('adminNotifications.allUsers') : n.target }}</div>
            </div>
            <button class="del-btn" @click="deleteRecord(n.id)" :title="t('adminNotifications.delete')">
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <line x1="1.5" y1="1.5" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import { showAppNotice } from '@/composables/core/useAppToast'
import { renderMarkdown } from '@/utils/markdown'
import { fmtLocalDateTime } from '@/utils/dateAttribution'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'

const admin = useAdminStore()
const { t } = useI18n()

const CHANNELS = computed(() => [
  { value: 'both', label: t('adminNotifications.both'), hint: t('adminNotifications.bothHint') },
  { value: 'bubble', label: t('adminNotifications.bubble'), hint: t('adminNotifications.bubbleHint') },
  { value: 'center', label: t('adminNotifications.center'), hint: t('adminNotifications.centerHint') },
])
// 气泡时限：过了这个时间，再登录的用户不再补弹（永久=只要没被更新的气泡顶掉就一直能补弹）
const BUBBLE_TTLS = computed(() => [
  { value: null, label: t('adminNotifications.permanent') },
  { value: 24, label: t('adminNotifications.days', { count: 1 }) },
  { value: 72, label: t('adminNotifications.days', { count: 3 }) },
  { value: 168, label: t('adminNotifications.days', { count: 7 }) },
])
const form = reactive({ title: '', content: '', channel: 'both', bubbleTtl: 24 as number | null })
const sending = ref(false)
const err = ref('')
const history = ref<any[]>([])
const loadingHistory = ref(false)
const refreshingHistory = ref(false)

async function send() {
  if (!form.title.trim() && !form.content.trim()) return
  err.value = ''
  sending.value = true
  try {
    const res = await admin.authFetch('/api/v1/admin/notifications/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title, content: form.content, target: 'all',
        bubble:  form.channel !== 'center',   // both / bubble → 弹气泡
        persist: form.channel !== 'bubble',   // both / center → 进通知中心
        bubble_ttl_hours: form.channel !== 'center' ? form.bubbleTtl : null,  // 时限只对气泡有意义
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    showAppNotice(t('adminNotifications.sent'))
    form.title = ''
    form.content = ''
    await loadHistory()
  } catch (e) {
    err.value = t('adminNotifications.sendFailed', { message: e instanceof Error ? e.message : e })
  } finally {
    sending.value = false
  }
}

async function loadHistory() {
  loadingHistory.value = true
  refreshingHistory.value = true
  setTimeout(() => { refreshingHistory.value = false }, 550)
  try {
    const res = await admin.authFetch('/api/v1/admin/notifications/history')
    if (!res.ok) throw new Error()
    history.value = await res.json()
  } catch {}
  finally { loadingHistory.value = false }
}

async function deleteRecord(id: number) {
  try {
    await admin.authFetch(`/api/v1/admin/notifications/history/${id}`, { method: 'DELETE' })
    history.value = history.value.filter(n => n.id !== id)
  } catch {}
}

function fmtTime(iso: string) {
  return fmtLocalDateTime(iso).replace(/^(\d{4})-0?(\d+)-0?(\d+) /, '$2/$3 ')
}

onMounted(loadHistory)
</script>

<style scoped>
.notif-page { min-height: 100%; padding-bottom: 56px; font-family: var(--font-sans, sans-serif); }

.page-header {
  padding: 32px 36px 0;
  display: flex; align-items: flex-start; justify-content: space-between;
}
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.content-grid {
  display: grid; grid-template-columns: 380px minmax(0, 1fr);
  gap: 20px; padding: 24px 36px; align-items: start;
}

.compose-card, .history-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 22px 22px 18px; min-width: 0;
}
.compose-title {
  font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.7);
  margin-bottom: 18px;
}

.field { margin-bottom: 16px; }
.field label {
  display: block; font-size: 11px; font-weight: 600;
  color: rgba(255,255,255,0.35); text-transform: uppercase; letter-spacing: 0.06em;
  margin-bottom: 7px;
}
.opt { font-weight: 400; text-transform: none; letter-spacing: 0; color: rgba(255,255,255,0.2); }
.text-input {
  width: 100%; box-sizing: border-box;
  background: var(--input-bg); border: 1px solid var(--input-border);
  border-radius: 10px; padding: 9px 12px;
  font-size: 13px; color: var(--input-fg); font-family: inherit;
  outline: none; caret-color: var(--action-primary);
  box-shadow: var(--input-hover-shadow), 0 0 0 0 transparent;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard), color var(--motion-hover-control) var(--motion-ease-standard);
}
.text-input:hover:not(:disabled) { background: var(--input-bg-hover); border-color: var(--input-border-hover); }
.text-input:focus:not(:disabled) { background: var(--input-bg-focus); border-color: var(--input-border-focus); box-shadow: var(--input-hover-shadow), var(--input-focus-shadow); }
.text-input::placeholder { color: var(--input-placeholder); opacity: .82; }
.textarea { resize: none; line-height: 1.6; }

/* 发布渠道选择 */
.channel-row { display: flex; gap: 8px; flex-wrap: wrap; }
.channel-chip {
  padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; font-family: inherit;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.6); transition: all 0.12s; outline: none;
}
.channel-chip:hover { border-color: rgba(123,127,178,0.5); color: rgba(255,255,255,0.85); }
.channel-chip.active {
  background: rgba(123,127,178,0.25); border-color: rgba(123,127,178,0.7); color: #fff; font-weight: 600;
}
.channel-hint { display: block; margin-top: 7px; font-size: 11px; color: rgba(255,255,255,0.35); }

.preview-label {
  font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.25);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px;
}
/* 与用户端 NotificationBubble 1:1 一致的玻璃气泡：纵向布局、✕ 右上角、内容占满整宽 */
.preview-bubble {
  display: flex; flex-direction: column; gap: 4px;
  padding: 13px 15px 15px;
  background: rgba(255,255,255,0.9);
  backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255,255,255,0.65);
  border-radius: 20px; position: relative; overflow: hidden; margin-bottom: 18px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.9);
}
.pv-close {
  position: absolute; top: 9px; right: 9px; z-index: 1;
  width: 26px; height: 26px; border-radius: 7px;
  border: none; background: none; color: rgba(40,44,62,0.55);
  display: flex; align-items: center; justify-content: center; padding: 0;
  cursor: default; pointer-events: none;
}
.pv-close svg { display: block; }
.pv-head { display: flex; align-items: center; gap: 8px; padding-right: 28px; }
.pv-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}
.pv-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 700; color: #2b2d3c; line-height: 1.3; }
.pv-content { font-size: 12px; color: rgba(40,44,62,0.62); line-height: 1.5; word-break: break-word; overflow-wrap: break-word; }
.pv-bare .pv-content::before { content: ''; float: right; width: 30px; height: 22px; }

/* 预览气泡内的 markdown 排版（与用户端 NotificationBubble 一致，深色文字配浅色玻璃） */
.pv-content.md-nb { font-size: 12px; line-height: 1.5; color: rgba(40,44,62,0.62); word-break: break-word; }
.md-nb :deep(> :first-child) { margin-top: 0; }
.md-nb :deep(> :last-child)  { margin-bottom: 0; }
.md-nb :deep(p) { margin: 0 0 6px; }
.md-nb :deep(h1), .md-nb :deep(h2), .md-nb :deep(h3),
.md-nb :deep(h4), .md-nb :deep(h5), .md-nb :deep(h6) { margin: 8px 0 4px; font-weight: 700; line-height: 1.3; color: #2b2d3c; }
.md-nb :deep(h1) { font-size: 14px; } .md-nb :deep(h2) { font-size: 13.5px; } .md-nb :deep(h3) { font-size: 13px; }
.md-nb :deep(h4), .md-nb :deep(h5), .md-nb :deep(h6) { font-size: 12px; }
.md-nb :deep(strong) { font-weight: 700; color: #2b2d3c; }
.md-nb :deep(em) { font-style: italic; }
.md-nb :deep(a) { color: #6266c4; text-decoration: underline; text-underline-offset: 2px; }
.md-nb :deep(ul), .md-nb :deep(ol) { margin: 4px 0 6px; padding-left: 18px; }
.md-nb :deep(li) { margin: 2px 0; }
.md-nb :deep(li > p) { margin: 0; }
.md-nb :deep(code) { font-family: var(--font-family-mono); font-size: 11px; background: rgba(123,127,178,0.15); color: #5256ab; padding: 1px 5px; border-radius: 5px; }
.md-nb :deep(pre) { margin: 6px 0; padding: 9px 11px; border-radius: 9px; background: rgba(20,22,40,0.07); overflow-x: auto; }
.md-nb :deep(pre code) { background: none; color: #2b2d3c; padding: 0; font-size: 11px; line-height: 1.5; }
.md-nb :deep(blockquote) { margin: 6px 0; padding: 2px 0 2px 10px; border-left: 2.5px solid rgba(123,127,178,0.45); color: rgba(40,44,62,0.5); }
.md-nb :deep(hr) { border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: 8px 0; }
.md-nb :deep(table) { border-collapse: collapse; margin: 6px 0; font-size: 11px; width: 100%; }
.md-nb :deep(th), .md-nb :deep(td) { border: 1px solid rgba(0,0,0,0.14); padding: 4px 7px; text-align: left; }
.md-nb :deep(th) { background: rgba(123,127,178,0.12); font-weight: 600; }
.md-nb :deep(img) { max-width: 100%; border-radius: 8px; margin: 4px 0; }

.err-msg { color: #e07070; font-size: 12px; margin-bottom: 12px; }

.send-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px 0; border: none; border-radius: 10px;
  background: var(--action-primary-bg); color: var(--content-on-accent);
  font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit;
  box-shadow: none; transition: background-color 0.15s;
}
.send-btn:hover:not(:disabled) { background: var(--action-primary-bg-hover); opacity: 1; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 历史 */
.history-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */

.empty-hint { font-size: 12px; color: rgba(255,255,255,0.2); padding: 16px 0; }

.history-list { display: flex; flex-direction: column; gap: 10px; }
.history-row {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
  transition: background 0.12s;
}
.history-row:hover { background: rgba(255,255,255,0.06); }
.hr-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 4px; background: linear-gradient(135deg, #7b7fb2, #9590c4); }
.hr-body { flex: 1; min-width: 0; }
.hr-title { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.75); }
.hr-content { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hr-meta { font-size: 11px; color: rgba(255,255,255,0.22); margin-top: 5px; }
.del-btn {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px;
  border: none; background: transparent; color: rgba(255,255,255,0.2);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; padding: 0;
}
.del-btn:hover { background: rgba(200,80,80,0.15); color: rgba(220,100,100,0.8); }

/* Spinner */
@keyframes spin { to { transform: rotate(360deg); } }
.spinning-inf { animation: spin 0.8s linear infinite; }   /* 发送中持续转；刷新按钮用全局 .icon-btn.spinning（转一圈） */

</style>
