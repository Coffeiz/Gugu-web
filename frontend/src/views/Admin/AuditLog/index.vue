<template>
  <div class="audit-log">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminAudit.title') }}</h2>
        <p class="page-desc">{{ t('adminAudit.description') }}</p>
      </div>
    </div>

    <AdminSegmentTabs
      :model-value="view"
      :tabs="auditTabs"
      :aria-label="t('adminAudit.title')"
      size="compact"
      class="audit-tabs"
      @update:model-value="view = $event as 'ops' | 'security'"
    />

    <!-- 筛选栏 -->
    <div v-if="view === 'ops'" class="filter-bar">
      <div class="filter-group">
        <AdminSelect v-model="filter.action" :options="actionOptions" :placeholder="t('adminAudit.allActions')" />
        <input
          v-model="filter.keyword"
          class="filter-input"
          :placeholder="t('adminAudit.search')"
        />
        <div class="date-range">
          <AdminDatePicker v-model="filter.dateFrom" :placeholder="t('adminAudit.startDate')" />
          <span class="date-sep">—</span>
          <AdminDatePicker v-model="filter.dateTo" :placeholder="t('adminAudit.endDate')" />
        </div>
      </div>
      <div class="filter-actions">
        <button class="btn-export" @click="exportCsv" :disabled="!filtered.length">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {{ t('adminAudit.export') }}
        </button>
        <RefreshButton :loading="refreshing" @click="load(true)" :title="t('adminAudit.refresh')" />
      </div>
    </div>

    <!-- 日志表格 -->
    <div v-if="view === 'ops'" class="log-table-wrap">
      <div v-if="loading" class="state-center">
        <div class="spinner" />
      </div>
      <div v-else-if="!filtered.length" class="state-center empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
          stroke-linecap="round" stroke-linejoin="round" style="opacity:.3">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <path d="M7 9h10M7 13h6"/>
        </svg>
        <span>{{ t('adminAudit.empty') }}</span>
      </div>
      <template v-else>
        <table class="log-table">
          <thead>
            <tr>
              <th style="width:160px">{{ t('adminAudit.time') }}</th>
              <th style="width:120px">{{ t('adminAudit.operator') }}</th>
              <th style="width:100px">{{ t('adminAudit.actionType') }}</th>
              <th>{{ t('adminAudit.descriptionCol') }}</th>
              <th style="width:130px">{{ t('adminAudit.ip') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in paginated" :key="row.id">
              <td class="col-time">{{ formatTime(row.created_at) }}</td>
              <td class="col-user">{{ row.username }}</td>
              <td>
                <span class="tag" :class="`tag-${row.action}`">{{ actionLabel(row.action) }}</span>
              </td>
              <td class="col-desc">{{ row.description }}</td>
              <td class="col-ip">{{ row.ip ?? '—' }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 分页 -->
        <div class="pagination">
          <span class="page-info">{{ t('adminAudit.count', { count: filtered.length }) }}</span>
          <div class="page-btns">
            <button class="page-btn" :disabled="page <= 1" @click="page--">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M10 3L5 8l5 5"/>
              </svg>
            </button>
            <span class="page-num">{{ page }} / {{ totalPages }}</span>
            <button class="page-btn" :disabled="page >= totalPages" @click="page++">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3l5 5-5 5"/>
              </svg>
            </button>
          </div>
          <select v-model="pageSize" class="filter-select" style="height:30px;font-size:12px">
            <option :value="20">{{ t('adminAudit.perPage', { count: 20 }) }}</option>
            <option :value="50">{{ t('adminAudit.perPage', { count: 50 }) }}</option>
            <option :value="100">{{ t('adminAudit.perPage', { count: 100 }) }}</option>
          </select>
        </div>
      </template>
    </div>

    <div v-else class="security-events">
      <div class="security-toolbar">
        <AdminSelect v-model="securityFilter.action" :options="securityActionOptions" :placeholder="t('adminAudit.allActionsShort')" />
        <AdminSelect v-model="securityFilter.eventType" :options="securityEventOptions" :placeholder="t('adminAudit.allEvents')" />
        <AdminSelect v-model="securitySinceMinutes" :options="securitySinceOptions" />
        <RefreshButton :loading="securityLoading" @click="loadSecurity" :title="t('adminAudit.refreshSecurity')" />
      </div>
      <div class="log-table-wrap">
        <div v-if="securityLoading" class="state-center"><div class="spinner" /></div>
        <div v-else-if="!securityRows.length" class="state-center empty">{{ t('adminAudit.noSecurity') }}</div>
        <table v-else class="log-table security-table">
          <thead><tr><th>{{ t('adminAudit.time') }}</th><th>{{ t('adminAudit.userFingerprint') }}</th><th>{{ t('adminAudit.event') }}</th><th>{{ t('adminAudit.resource') }}</th><th>{{ t('adminAudit.actionType') }}</th><th>{{ t('adminAudit.sourceFingerprint') }}</th></tr></thead>
          <tbody>
            <tr v-for="row in securityRows" :key="row.id">
              <td class="col-time">{{ formatTime(row.occurred_at) }}</td>
              <td><code>{{ shortFingerprint(row.user_id) }}</code></td>
              <td>{{ row.event_type }}</td>
              <td>{{ row.resource_type }} <code>{{ shortFingerprint(row.resource_fingerprint) }}</code></td>
              <td><span class="tag" :class="`tag-${row.action}`">{{ securityActionLabel(row.action) }}</span></td>
              <td><code>{{ shortFingerprint(row.ip_fingerprint || row.client_fingerprint || row.user_agent_fingerprint) }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import AdminDatePicker from '@/components/AdminDatePicker.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'
import { fmtLocalDateTime, localDayKey } from '@/utils/dateAttribution'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const actionOptions = computed(() => [
  { value: '', label: t('adminAudit.allActions') },
  { value: 'login', label: t('adminAudit.login') },
  { value: 'config', label: t('adminAudit.config') },
  { value: 'agent', label: t('adminAudit.agent') },
  { value: 'prompt', label: t('adminAudit.prompt') },
  { value: 'user', label: t('adminAudit.user') },
])
const securityActionOptions = computed(() => [
  { value: '', label: t('adminAudit.allActionsShort') },
  { value: 'logged', label: t('adminAudit.logged') },
  { value: 'throttled', label: t('adminAudit.throttled') },
  { value: 'suspended', label: t('adminAudit.suspended') },
])
const securityEventOptions = computed(() => [
  { value: '', label: t('adminAudit.allEvents') },
  { value: 'ownership.denied', label: t('adminAudit.ownershipDenied') },
])
const securitySinceOptions = computed(() => [
  { value: '60', label: t('adminAudit.lastHour') },
  { value: '1440', label: t('adminAudit.lastDay') },
  { value: '10080', label: t('adminAudit.last7Days') },
  { value: '129600', label: t('adminAudit.last90Days') },
])
const auditTabs = computed(() => [
  { key: 'ops', label: t('adminAudit.operations') },
  { key: 'security', label: t('adminAudit.security') },
])

const BASE  = import.meta.env.VITE_API_URL ?? '/api/v1'
const token = localStorage.getItem('admin_token')

const loading   = ref(false)
const refreshing = ref(false)
const rows     = ref<any[]>([])
const page     = ref(1)
const pageSize = ref(20)
const filter   = ref({ action: '', keyword: '', dateFrom: '', dateTo: '' })
const view = ref<'ops' | 'security'>('ops')
const securityRows = ref<any[]>([])
const securityLoading = ref(false)
const securityFilter = ref({ action: '', eventType: '', sinceMinutes: 1440 })
const securitySinceMinutes = computed({
  get: () => String(securityFilter.value.sinceMinutes),
  set: value => { securityFilter.value.sinceMinutes = Number(value) },
})

watch(filter, () => { page.value = 1 }, { deep: true })
watch(pageSize, () => { page.value = 1 })
watch(securityFilter, loadSecurity, { deep: true })

const filtered = computed(() => {
  let list = rows.value
  if (filter.value.action)
    list = list.filter(r => r.action === filter.value.action)
  if (filter.value.keyword) {
    const kw = filter.value.keyword.toLowerCase()
    list = list.filter(r =>
      r.description?.toLowerCase().includes(kw) ||
      r.username?.toLowerCase().includes(kw)
    )
  }
  if (filter.value.dateFrom)
    list = list.filter(r => r.created_at >= filter.value.dateFrom)
  if (filter.value.dateTo)
    list = list.filter(r => r.created_at <= filter.value.dateTo + 'T23:59:59')
  return list
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
const paginated  = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

async function load(manual = false) {
  if (manual) {
    refreshing.value = true
    setTimeout(() => { refreshing.value = false }, 550)
  }
  loading.value = true
  try {
    const res  = await fetch(`${BASE}/admin/audit-log`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    rows.value = data.items ?? []
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function loadSecurity() {
  securityLoading.value = true
  try {
    const params = new URLSearchParams({
      since_minutes: String(securityFilter.value.sinceMinutes),
      limit: '500',
    })
    if (securityFilter.value.action) params.set('action', securityFilter.value.action)
    if (securityFilter.value.eventType) params.set('event_type', securityFilter.value.eventType)
    const res = await fetch(`${BASE}/admin/audit-log/security-events?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    securityRows.value = (await res.json().catch(() => ({}))).items ?? []
  } catch {
    securityRows.value = []
  } finally {
    securityLoading.value = false
  }
}

function exportCsv() {
  const header = ['时间', '操作者', '操作类型', '描述', 'IP']
  const csvRows = [
    header.join(','),
    ...filtered.value.map(r => [
      formatTime(r.created_at),
      r.username ?? '',
      actionLabel(r.action),
      `"${(r.description ?? '').replace(/"/g, '""')}"`,
      r.ip ?? '',
    ].join(',')),
  ]
  const blob = new Blob(['﻿' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = `audit-log-${localDayKey(new Date())}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function formatTime(ts: any) {
  return fmtLocalDateTime(ts, { seconds: true }) || '—'
}

function actionLabel(action: string) {
  const map = { login: t('adminAudit.login'), config: t('adminAudit.config'), agent: t('adminAudit.agent'), prompt: t('adminAudit.prompt'), user: t('adminAudit.user') }
  return map[action as keyof typeof map] ?? action
}

function securityActionLabel(action: string) {
  return ({ logged: t('adminAudit.logged'), throttled: t('adminAudit.throttled'), suspended: t('adminAudit.suspended') } as Record<string, string>)[action] ?? action
}

function shortFingerprint(value: string | null | undefined) {
  return value ? value.slice(0, 16) : '—'
}

onMounted(() => { load(); loadSecurity() })
</script>

<style scoped>
.audit-log { min-height: 100%; }
.audit-tabs { margin: 22px 36px 0; }
.security-events { padding: 18px 36px 32px; }
.security-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
.security-table code { color: rgba(180,190,230,.75); font-size: 11px; }
.security-events > .log-table-wrap { margin: 14px 0 32px; }
.security-table { table-layout: fixed; }
.security-table th:nth-child(1), .security-table td:nth-child(1) { width: 13%; }
.security-table th:nth-child(2), .security-table td:nth-child(2) { width: 15%; }
.security-table th:nth-child(3), .security-table td:nth-child(3) { width: 17%; }
.security-table th:nth-child(4), .security-table td:nth-child(4) { width: 23%; }
.security-table th:nth-child(5), .security-table td:nth-child(5) { width: 13%; }
.security-table th:nth-child(6), .security-table td:nth-child(6) { width: 19%; }
.security-table td { overflow-wrap: anywhere; }

.page-header      { padding: 32px 36px 0; }
.page-title-block { display: flex; flex-direction: column; }
.page-title       { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc        { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

/* 筛选栏 */
.filter-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 36px 0; gap: 12px; flex-wrap: wrap;
}
.filter-group  { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.filter-actions { display: flex; align-items: center; gap: 8px; }

.filter-select,
.filter-input {
  height: 34px; border-radius: 9px;
  font-size: 13px; padding: 0 12px; outline: none;
}
.filter-select { cursor: pointer; }
.filter-input  { width: 180px; }

.date-range { display: flex; align-items: center; gap: 6px; }
.date-sep   { color: rgba(255,255,255,0.25); font-size: 12px; }

.btn-export {
  display: flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 14px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.6); font-size: 13px; cursor: pointer;
  transition: all 0.15s;
}
.btn-export:hover:not(:disabled) { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.85); }
.btn-export:disabled { opacity: 0.35; cursor: default; }

/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue）；spin 保留给下方 .spinner */
@keyframes spin { to { transform: rotate(360deg); } }

/* 表格 */
.log-table-wrap {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; overflow: hidden;
  margin: 14px 36px 32px;
}

.state-center {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 60px 0; color: rgba(255,255,255,0.3); font-size: 13px;
}
.spinner {
  width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.1);
  border-top-color: rgba(255,255,255,0.4);
  animation: spin 0.5s ease-out;
}

.log-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.log-table thead tr { border-bottom: 1px solid rgba(255,255,255,0.07); }
.log-table th {
  padding: 11px 16px; text-align: left;
  color: rgba(255,255,255,0.3); font-weight: 600;
  font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
}
.log-table td {
  padding: 11px 16px; color: rgba(255,255,255,0.65);
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.log-table tbody tr:last-child td { border-bottom: none; }
.log-table tbody tr:hover td { background: rgba(255,255,255,0.03); }

.col-time { color: rgba(255,255,255,0.35); white-space: nowrap; font-size: 12px; }
.col-user { color: rgba(255,255,255,0.8); font-weight: 500; }
.col-desc { color: rgba(255,255,255,0.55); }
.col-ip   { color: rgba(255,255,255,0.3); font-size: 12px; font-family: var(--font-family-mono); }

.tag {
  display: inline-block; padding: 2px 8px; border-radius: 20px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
}
.tag-login  { background: rgba(100,180,100,0.15); color: rgba(120,210,120,0.9); }
.tag-config { background: rgba(120,140,220,0.15); color: rgba(150,170,240,0.9); }
.tag-agent  { background: rgba(160,100,220,0.15); color: rgba(190,140,240,0.9); }
.tag-user   { background: rgba(80,170,200,0.15);  color: rgba(100,200,230,0.9); }
.tag-prompt { background: rgba(220,120,160,0.15); color: rgba(235,150,185,0.9); }

/* 分页 */
.pagination {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.07);
}
.page-info { font-size: 12px; color: rgba(255,255,255,0.3); flex: 1; }
.page-btns { display: flex; align-items: center; gap: 8px; }
.page-btn {
  width: 28px; height: 28px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; display: flex;
  align-items: center; justify-content: center; transition: all 0.15s;
}
.page-btn:hover:not(:disabled) { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.8); }
.page-btn:disabled { opacity: 0.25; cursor: default; }
.page-num { font-size: 13px; color: rgba(255,255,255,0.5); min-width: 60px; text-align: center; }
</style>
