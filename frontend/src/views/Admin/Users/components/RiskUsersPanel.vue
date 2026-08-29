<template>
  <section class="risk-panel">
    <div class="risk-toolbar">
      <span class="risk-summary">近 {{ windowMinutes }} 小时触发过，策略按 5 分钟窗口计算</span>
      <button class="icon-btn" :class="{ spinning: loading }" title="刷新风险用户" @click="load">
        <Icon name="action.refresh" size="sm" />
      </button>
    </div>

    <div v-if="loading && !items.length" class="state-empty">加载中…</div>
    <div v-else-if="!items.length" class="state-empty">暂无风险用户</div>
    <div v-else class="risk-list">
      <article v-for="user in items" :key="user.id" class="risk-row">
        <div class="risk-identity">
          <span class="avatar-circle">{{ (user.display_name || user.username || '?').charAt(0).toUpperCase() }}</span>
          <span class="risk-user-text">
            <strong>{{ user.display_name || user.username }}</strong>
            <small>{{ user.email }}</small>
          </span>
        </div>
        <span class="risk-status" :class="user.account_status">
          {{ user.account_status === 'suspended' ? '临时冻结' : user.risk_action === 'throttled' ? '已限流' : '近期触发' }}
        </span>
        <span class="risk-count">{{ user.recent_event_count }} 次</span>
        <span class="risk-time">{{ formatDate(user.last_event_at) }}</span>
        <div class="risk-actions">
          <button class="action-btn" @click="toggleEvents(user)">{{ expanded === user.id ? '收起事件' : '查看事件' }}</button>
          <button v-if="user.account_status === 'suspended' || !user.is_active" class="action-btn" @click="unsuspend(user)">解封</button>
          <button v-else class="action-btn danger" @click="suspendTarget = user">冻结</button>
        </div>
        <div v-if="expanded === user.id" class="event-detail">
          <div v-if="eventLoading" class="event-muted">加载中…</div>
          <div v-else-if="!events.length" class="event-muted">暂无事件详情</div>
          <div v-for="event in events" :key="event.id" class="event-item">
            <span>{{ event.event_type }}</span>
            <code>{{ event.resource_fingerprint.slice(0, 16) }}</code>
            <time>{{ formatDate(event.occurred_at) }}</time>
          </div>
        </div>
      </article>
    </div>

    <Teleport to="body">
      <div v-if="suspendTarget" class="confirm-mask" @click.self="suspendTarget = null">
        <div class="confirm-box">
          <h3>确认冻结用户？</h3>
          <p>冻结后该用户将暂时无法访问服务，默认冻结 30 分钟。</p>
          <div class="confirm-actions">
            <button class="btn-cancel" @click="suspendTarget = null">取消</button>
            <button class="btn-confirm" :disabled="saving" @click="suspend">{{ saving ? '处理中…' : '确认冻结' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminStore } from '@/stores/admin'

const adminStore = useAdminStore()
const items = ref<any[]>([])
const events = ref<any[]>([])
const loading = ref(false)
const eventLoading = ref(false)
const saving = ref(false)
const expanded = ref<string | null>(null)
const suspendTarget = ref<any | null>(null)
const windowMinutes = 24

async function load() {
  loading.value = true
  try {
    const response = await adminStore.authFetch(`/api/v1/admin/users/risk?window_minutes=${windowMinutes * 60}`)
    items.value = (await response.json()).items ?? []
  } finally {
    loading.value = false
  }
}

async function toggleEvents(user: any) {
  if (expanded.value === user.id) {
    expanded.value = null
    return
  }
  expanded.value = user.id
  eventLoading.value = true
  try {
    const response = await adminStore.authFetch(`/api/v1/admin/users/${user.id}/security-events`)
    events.value = (await response.json()).items ?? []
  } finally {
    eventLoading.value = false
  }
}

async function suspend() {
  if (!suspendTarget.value) return
  saving.value = true
  try {
    await adminStore.authFetch(`/api/v1/admin/users/${suspendTarget.value.id}/suspend`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_seconds: 1800, reason: 'admin_manual_suspend', confirm: true }),
    })
    suspendTarget.value = null
    await load()
  } finally {
    saving.value = false
  }
}

async function unsuspend(user: any) {
  await adminStore.authFetch(`/api/v1/admin/users/${user.id}/unsuspend`, { method: 'POST' })
  await load()
}

function formatDate(value: string | null) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

onMounted(load)
</script>

<style scoped>
.risk-panel { margin: 18px 36px 32px; }
.risk-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.risk-summary, .risk-time, .event-muted { color: rgba(255,255,255,0.42); font-size: 12px; }
.risk-list { display: flex; flex-direction: column; gap: 8px; }
.risk-row { display: grid; grid-template-columns: minmax(190px, 1.5fr) 90px 70px 120px auto; gap: 14px; align-items: center; padding: 14px 16px; border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; background: rgba(255,255,255,0.035); }
.risk-row:hover { border-color: rgba(150,170,220,0.42); background: rgba(255,255,255,0.06); }
.risk-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.avatar-circle { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex: 0 0 auto; background: rgba(130,145,190,0.32); color: rgba(255,255,255,0.8); }
.risk-user-text { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.risk-user-text strong { color: rgba(255,255,255,0.82); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.risk-user-text small { color: rgba(255,255,255,0.35); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.risk-status { width: max-content; padding: 3px 8px; border-radius: 6px; font-size: 11px; color: #e4c47b; background: rgba(210,165,70,0.14); }
.risk-status.suspended { color: #ef9a9a; background: rgba(220,80,80,0.14); }
.risk-count { color: rgba(255,255,255,0.68); font-size: 12px; }
.risk-actions { display: flex; gap: 6px; justify-content: flex-end; }
.action-btn { padding: 4px 9px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.65); cursor: pointer; font-size: 12px; }
.action-btn:hover { border-color: rgba(150,170,220,0.5); background: rgba(255,255,255,0.1); }
.action-btn.danger { color: #e99a9a; border-color: rgba(220,80,80,0.25); }
.event-detail { grid-column: 1 / -1; padding: 10px 0 0 40px; border-top: 1px solid rgba(255,255,255,0.07); }
.event-item { display: grid; grid-template-columns: 150px 1fr 120px; gap: 10px; padding: 5px 0; color: rgba(255,255,255,0.6); font-size: 12px; }
.event-item code { color: rgba(180,190,230,0.8); }
.event-item time { color: rgba(255,255,255,0.35); }
.state-empty { padding: 60px; text-align: center; color: rgba(255,255,255,0.25); font-size: 13px; }
.confirm-mask { position: fixed; inset: 0; z-index: 9100; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); backdrop-filter: blur(4px); }
.confirm-box { width: 360px; padding: 24px; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; background: rgba(24,25,42,0.97); box-shadow: 0 12px 42px rgba(0,0,0,0.35); }
.confirm-box h3 { margin: 0 0 10px; color: rgba(255,255,255,0.9); font-size: 16px; }
.confirm-box p { margin: 0 0 22px; color: rgba(255,255,255,0.5); font-size: 13px; line-height: 1.6; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn-cancel, .btn-confirm { padding: 7px 14px; border-radius: 7px; cursor: pointer; font-size: 12px; }
.btn-cancel { border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.6); }
.btn-confirm { border: 0; background: rgba(180,82,92,0.85); color: white; }
.btn-confirm:disabled { opacity: 0.5; }
@media (max-width: 900px) { .risk-row { grid-template-columns: 1fr auto; } .risk-count, .risk-time { display: none; } .risk-actions { grid-column: 2; } }
</style>
