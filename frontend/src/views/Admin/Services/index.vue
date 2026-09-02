<template>
  <div class="svc-page">
    <div class="svc-head">
      <div>
        <h2 class="svc-title">{{ t('adminServices.title') }}</h2>
        <p class="svc-sub">{{ t('adminServices.description') }}</p>
      </div>
      <div class="svc-head-right">
        <span class="svc-deps">
          <span class="dep" :class="deps.redis ? 'ok' : 'bad'">Redis {{ deps.redis ? t('adminServices.connected') : t('adminServices.disconnected') }}</span>
          <span class="dep" :class="deps.db ? 'ok' : 'bad'">DB {{ deps.db ? t('adminServices.connected') : t('adminServices.disconnected') }}</span>
        </span>
        <RefreshButton :loading="refreshing" :disabled="loading" @click="load(true)" :title="t('adminServices.refresh')" />
      </div>
    </div>

    <div v-if="err" class="svc-err">{{ err }}</div>

    <div v-if="queue.length != null" class="svc-queue">
      <span class="q-label">{{ t('adminServices.queue') }}</span>
      <span class="q-stat" :title="t('adminServices.queueLength')">
        <b>{{ queue.length }}</b><i>{{ t('adminServices.queueLength') }}</i>
      </span>
      <span class="q-stat" :class="{ warn: (queue.lag || 0) > 20 }" :title="t('adminServices.queued')">
        <b>{{ queue.lag ?? '—' }}</b><i>{{ t('adminServices.queued') }}</i>
      </span>
      <span class="q-stat" :class="{ warn: (queue.pending || 0) > 10 }" :title="t('adminServices.processing')">
        <b>{{ queue.pending ?? '—' }}</b><i>{{ t('adminServices.processing') }}</i>
      </span>
    </div>

    <div class="svc-grid">
      <div v-for="s in services" :key="s.name" class="svc-card">
        <div class="svc-card-top">
          <span class="svc-dot" :class="s.status"></span>
          <span class="svc-name">{{ s.label }}</span>
          <span class="svc-status" :class="s.status">{{ statusText(s.status) }}</span>
        </div>

        <div class="svc-meta">
          <div v-if="s.name === 'web'"><span>{{ t('adminServices.running') }}</span>{{ fmtDur(s.uptime_secs) }}</div>
          <div v-else-if="s.last_seen_secs != null"><span>{{ t('adminServices.heartbeat') }}</span>{{ t('adminServices.secondsAgo', { count: s.last_seen_secs }) }}</div>
          <div v-if="s.name === 'gateway'"><span>{{ t('adminServices.gateway') }}</span>{{ t('adminServices.count', { count: s.extra?.count ?? 0 }) }}</div>
        </div>

        <div v-if="s.name === 'gateway' && s.extra?.gateways?.length" class="svc-gateways">
          <div v-for="g in s.extra.gateways" :key="g.key" class="svc-gw">
            <span class="svc-gw-plat">{{ g.platform }}</span>
          </div>
        </div>

        <div v-if="s.name === 'worker' && s.extra?.jobs?.length" class="svc-jobs">
          <span class="svc-jobs-count">{{ t('adminServices.scheduledJobs') }} {{ t('adminServices.count', { count: s.extra.jobs.length }) }}</span>
        </div>

        <div class="svc-card-actions">
          <button v-if="s.restartable" class="svc-restart" :disabled="restarting === s.name" @click="restart(s)">
            {{ restarting === s.name ? t('adminServices.restarting') : t('adminServices.restart') }}
          </button>
          <span v-else class="svc-self">{{ t('adminServices.currentProcess') }}</span>
        </div>
        <div v-if="msg[s.name]" class="svc-msg" :class="{ bad: !msgOk[s.name] }">{{ msg[s.name] }}</div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useI18n } from 'vue-i18n'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'

const adminStore = useAdminStore()
const { t } = useI18n()
const services = ref<any[]>([])
const deps = ref({ redis: false, db: false })
const queue = ref<{ length?: number; lag?: number; pending?: number }>({})
const loading = ref(false)
const refreshing = ref(false)
const err = ref('')
const restarting = ref('')
const msg: Record<string, string> = reactive({})
const msgOk: Record<string, boolean> = reactive({})
let timer: ReturnType<typeof setTimeout> | null = null

async function load(manual = false) {
  if (manual) {
    loading.value = true
    refreshing.value = true
    setTimeout(() => { refreshing.value = false }, 550)
  }
  try {
    const res = await adminStore.authFetch('/api/v1/admin/services')
    if (!res.ok) throw new Error(t('adminServices.loadFailed'))
    const data = await res.json()
    services.value = data.services || []
    deps.value = data.deps || { redis: false, db: false }
    queue.value = data.queue || {}
    err.value = ''
  } catch (e) { err.value = (e instanceof Error ? e.message : String(e)) } finally { loading.value = false }
}

async function restart(s: any) {
  if (!await confirmDialog({ title: t('adminServices.restartTitle'), message: t('adminServices.restartMessage', { name: s.label }), tone: 'warning', confirmText: t('adminServices.restart') })) return
  restarting.value = s.name
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/services/${s.name}/restart`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    msg[s.name] = data.msg || (res.ok ? t('adminServices.sent') : t('adminServices.restartFailed', { status: res.status }))
    msgOk[s.name] = !!data.ok
  } catch (e) { msg[s.name] = (e instanceof Error ? e.message : String(e)); msgOk[s.name] = false }
  finally {
    restarting.value = ''
    setTimeout(() => load(), 2500)   // 给 systemd 拉起的时间，再刷新
  }
}

function statusText(st: string) { return st === 'online' ? t('adminServices.online') : st === 'stale' ? t('adminServices.stale') : t('adminServices.offline') }
function fmtDur(s: number) {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

onMounted(() => { load(); timer = setInterval(() => load(), 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.svc-page { padding: 28px 32px; color: rgba(255,255,255,0.9); }
.svc-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.svc-title { font-size: 18px; font-weight: 700; margin: 0; }
.svc-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; }
.svc-head-right { display: flex; align-items: center; gap: 12px; }
.svc-deps { display: flex; gap: 6px; }
.dep { font-size: 11px; padding: 3px 9px; border-radius: 6px; }
.dep.ok { color: #74c69d; background: rgba(116,198,157,0.12); }
.dep.bad { color: #e08a8a; background: rgba(224,138,138,0.14); }
/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */
.svc-err { color: #e08a8a; font-size: 13px; margin-bottom: 12px; }

.svc-queue {
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 12px 18px; margin-bottom: 16px;
}
.q-label { font-size: 12px; color: rgba(255,255,255,0.4); }
.q-stat { display: flex; align-items: baseline; gap: 6px; cursor: help; }
.q-stat b { font-size: 18px; font-weight: 600; color: rgba(255,255,255,0.92); }
.q-stat i { font-size: 11px; font-style: normal; color: rgba(255,255,255,0.4); }
.q-stat.warn b { color: #fbbf24; }
.q-stat.warn i { color: rgba(251,191,36,0.7); }

.svc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.svc-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 16px 18px;
  display: flex; flex-direction: column;   /* 等高卡片内按钮顶到底部 */
}
.svc-card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.svc-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.svc-dot.online { background: #4ade80; box-shadow: 0 0 8px rgba(74,222,128,0.6); }
.svc-dot.stale { background: #fbbf24; box-shadow: 0 0 8px rgba(251,191,36,0.6); }
.svc-dot.offline { background: #f87171; }
.svc-name { font-size: 14px; font-weight: 600; flex: 1; }
.svc-status { font-size: 11px; }
.svc-status.online { color: #4ade80; }
.svc-status.stale { color: #fbbf24; }
.svc-status.offline { color: #f87171; }

.svc-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: rgba(255,255,255,0.7); }
.svc-meta div span { color: rgba(255,255,255,0.35); margin-right: 6px; }

.svc-gateways { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 5px; }
.svc-gw {
  font-size: 10.5px; padding: 2px 7px; border-radius: 5px;
  background: rgba(123,127,178,0.16); color: rgba(180,185,225,0.95);
}


.svc-jobs { margin-top: 10px; }
.svc-jobs-count { font-size: 11px; color: rgba(255,255,255,0.4); }

.svc-card-actions { margin-top: auto; padding-top: 14px; display: flex; justify-content: flex-end; }
.svc-restart {
  font-size: 12px; padding: 5px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(224,138,138,0.3); background: rgba(224,138,138,0.1); color: #e89a9a;
}
.svc-restart:hover:not(:disabled) { background: rgba(224,138,138,0.18); }
.svc-restart:disabled { opacity: 0.5; cursor: default; }
.svc-self { font-size: 11px; color: rgba(255,255,255,0.3); }
.svc-msg { margin-top: 8px; font-size: 11.5px; color: #74c69d; }
.svc-msg.bad { color: #e08a8a; }
</style>
