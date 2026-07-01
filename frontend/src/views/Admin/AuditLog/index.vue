<template>
  <div class="audit-log">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">操作日志</h2>
        <p class="page-desc">记录管理员的所有操作行为</p>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <div class="filter-group">
        <AdminSelect v-model="filter.action" :options="actionOptions" placeholder="全部操作" />
        <input
          v-model="filter.keyword"
          class="filter-input"
          placeholder="搜索关键词…"
        />
        <div class="date-range">
          <AdminDatePicker v-model="filter.dateFrom" placeholder="开始日期" />
          <span class="date-sep">—</span>
          <AdminDatePicker v-model="filter.dateTo" placeholder="结束日期" />
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
          导出 CSV
        </button>
        <button class="icon-btn" :class="{ spinning: refreshing }" @click="load(true)" title="刷新">
          <PhArrowClockwise :size="15" weight="bold" />
        </button>
      </div>
    </div>

    <!-- 日志表格 -->
    <div class="log-table-wrap">
      <div v-if="loading" class="state-center">
        <div class="spinner" />
      </div>
      <div v-else-if="!filtered.length" class="state-center empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"
          stroke-linecap="round" stroke-linejoin="round" style="opacity:.3">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <path d="M7 9h10M7 13h6"/>
        </svg>
        <span>暂无日志</span>
      </div>
      <template v-else>
        <table class="log-table">
          <thead>
            <tr>
              <th style="width:160px">时间</th>
              <th style="width:120px">操作者</th>
              <th style="width:100px">操作类型</th>
              <th>描述</th>
              <th style="width:130px">IP</th>
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
          <span class="page-info">共 {{ filtered.length }} 条</span>
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
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option>
            <option :value="100">100 条/页</option>
          </select>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import AdminDatePicker from '@/components/AdminDatePicker.vue'
import AdminSelect from '@/components/AdminSelect.vue'
import { PhArrowClockwise } from '@phosphor-icons/vue'

const actionOptions = [
  { value: '',       label: '全部操作' },
  { value: 'login',  label: '登录' },
  { value: 'config', label: '配置变更' },
  { value: 'invite', label: '邀请码' },
  { value: 'agent',  label: 'Agent 配置' },
  { value: 'prompt', label: '提示词' },
  { value: 'user',   label: '用户管理' },
]

const BASE  = import.meta.env.VITE_API_URL ?? '/api/v1'
const token = localStorage.getItem('admin_token')

const loading   = ref(false)
const refreshing = ref(false)
const rows     = ref([])
const page     = ref(1)
const pageSize = ref(20)
const filter   = ref({ action: '', keyword: '', dateFrom: '', dateTo: '' })

watch(filter, () => { page.value = 1 }, { deep: true })
watch(pageSize, () => { page.value = 1 })

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
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function formatTime(ts) {
  if (!ts) return '—'
  const d   = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function actionLabel(action) {
  const map = { login: '登录', config: '配置', invite: '邀请码', agent: 'Agent', prompt: '提示词', user: '用户管理' }
  return map[action] ?? action
}

onMounted(load)
</script>

<style scoped>
.audit-log { min-height: 100%; }

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
  height: 34px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.75);
  font-size: 13px; padding: 0 12px; outline: none;
  transition: border-color 0.15s;
}
.filter-select { cursor: pointer; }
.filter-input  { width: 180px; }
.filter-select:focus,
.filter-input:focus { border-color: rgba(255,255,255,0.25); }

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
.col-ip   { color: rgba(255,255,255,0.3); font-size: 12px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; }

.tag {
  display: inline-block; padding: 2px 8px; border-radius: 20px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
}
.tag-login  { background: rgba(100,180,100,0.15); color: rgba(120,210,120,0.9); }
.tag-config { background: rgba(120,140,220,0.15); color: rgba(150,170,240,0.9); }
.tag-invite { background: rgba(200,160,80,0.15);  color: rgba(220,185,100,0.9); }
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
