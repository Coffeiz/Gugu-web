<template>
  <div class="syslog-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminLogs.systemTitle') }}</h2>
        <p class="page-desc">{{ t('adminLogs.systemDescription') }}</p>
      </div>
    </div>

    <div class="toolbar">
      <AdminSelect v-model="filterLevel" :options="levelOptions" style="width:140px" />
      <RefreshButton :loading="refreshing" @click="load(true)" :title="t('adminLogs.refresh')" />
      <span class="toolbar-count" v-if="filtered.length">{{ t('adminLogs.count', { count: filtered.length }) }}</span>
    </div>

    <div v-if="loadError" class="load-error" role="alert">{{ loadError }}</div>

    <div class="log-table-wrap">
      <div class="log-table">
        <div class="lt-head">
          <span class="col-time">{{ t('adminLogs.time') }}</span>
          <span class="col-level">{{ t('adminLogs.level') }}</span>
          <span class="col-module">{{ t('adminLogs.module') }}</span>
          <span class="col-msg">{{ t('adminLogs.message') }}</span>
        </div>

        <div v-if="loading && !items.length" class="lt-empty">{{ t('adminLogs.loading') }}</div>
        <div v-else-if="!filtered.length" class="lt-empty">{{ t('adminLogs.empty') }}</div>

        <template v-else>
          <div
            v-for="row in paginated"
            :key="row.id"
            class="lt-row"
            :class="{ expanded: expanded === row.id, 'has-tb': row.traceback }"
            @click="row.traceback ? toggle(row.id) : null"
          >
            <div class="lt-main">
              <span class="col-time">{{ fmtTime(row.created_at) }}</span>
              <span class="col-level">
                <span class="level-tag" :class="row.level.toLowerCase()">{{ row.level }}</span>
              </span>
              <span class="col-module">{{ row.module }}</span>
              <span class="col-msg">{{ firstLine(row.message) }}</span>
              <svg v-if="row.traceback" class="expand-icon" :class="{ open: expanded === row.id }"
                width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
                stroke-width="1.8" stroke-linecap="round">
                <path d="M3 4.5l3 3 3-3"/>
              </svg>
            </div>
            <div v-if="expanded === row.id && row.traceback" class="lt-traceback" @click.stop>
              <button class="tb-copy" @click.stop="copyLog(row)">
                {{ copiedId === row.id ? t('adminLogs.copied') : t('adminLogs.copy') }}
              </button>
              <pre>{{ row.traceback }}</pre>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- 分页 -->
    <div class="pagination" v-if="filtered.length > pageSize">
      <button class="pg-btn" :disabled="page <= 1" @click="page--">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"><path d="M9 11L5 7l4-4"/></svg>
      </button>
      <span class="pg-info">{{ page }} / {{ totalPages }}</span>
      <button class="pg-btn" :disabled="page >= totalPages" @click="page++">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
          stroke-width="1.6" stroke-linecap="round"><path d="M5 11l4-4-4-4"/></svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import AdminSelect from '@/components/AdminSelect.vue'
import { fmtLocalDateTime } from '@/utils/dateAttribution'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'
const { t } = useI18n()

const adminStore = useAdminStore()

const items       = ref<any[]>([])
const loading     = ref(false)
const refreshing  = ref(false)  // 仅手动点击刷新时为 true
const loadError   = ref('')
const filterLevel = ref('')
const expanded    = ref<number | null>(null)
const page        = ref(1)
const pageSize    = 50

const levelOptions = [
  { label: '全部级别', value: '' },
  { label: 'ERROR',   value: 'ERROR' },
  { label: 'WARNING', value: 'WARNING' },
  { label: 'INFO',    value: 'INFO' },
]

async function load(manual = false) {
  if (manual) {
    refreshing.value = true
    setTimeout(() => { refreshing.value = false }, 550)
  }
  loading.value = true
  loadError.value = ''
  try {
    const qs  = filterLevel.value ? `?level=${filterLevel.value}` : ''
    const res = await adminStore.authFetch(`/api/v1/admin/system-logs${qs}`)
    const body = await res.text()
    if (!res.ok) {
      let detail = ''
      try { detail = body ? (JSON.parse(body).detail || '') : '' } catch {}
      throw new Error(detail || `加载失败（${res.status}）`)
    }
    if (!body.trim()) throw new Error('系统日志接口返回空响应')
    const data = JSON.parse(body)
    items.value = data.items ?? []
    page.value  = 1
    expanded.value = null
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '加载系统日志失败'
  } finally {
    loading.value = false
  }
}

watch(filterLevel, () => load(true))

const filtered = computed(() => items.value)

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))

const paginated = computed(() => {
  const start = (page.value - 1) * pageSize
  return filtered.value.slice(start, start + pageSize)
})

function toggle(id: number) {
  expanded.value = expanded.value === id ? null : id
}

const copiedId = ref<number | null>(null)
async function copyLog(row: any) {
  const text = [
    `[${fmtTime(row.created_at)}] ${row.level} ${row.module}`,
    row.message,
    row.traceback || '',
  ].join('\n').trim()
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 降级：clipboard 不可用（非 https 等）时用 execCommand
    const ta = document.createElement('textarea')
    ta.value = text; document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
  copiedId.value = row.id
  setTimeout(() => { if (copiedId.value === row.id) copiedId.value = null }, 1500)
}

function fmtTime(iso: string) {
  return fmtLocalDateTime(iso, { seconds: true })
}

function firstLine(msg: string) {
  return msg ? msg.split('\n')[0] : ''
}

onMounted(load)
</script>

<style scoped>
.syslog-page { min-height: 100%; display: flex; flex-direction: column; }

.page-header { padding: 32px 36px 0; flex-shrink: 0; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 36px 0; flex-shrink: 0;
}
.toolbar-count { font-size: 12px; color: rgba(255,255,255,0.3); margin-left: 4px; }
.load-error {
  margin: 12px 36px 0;
  padding: 9px 12px;
  border: 1px solid rgba(220, 100, 100, 0.28);
  border-radius: 8px;
  background: rgba(220, 80, 80, 0.1);
  color: rgba(245, 150, 150, 0.95);
  font-size: 12px;
}

.log-table-wrap {
  flex: 1; padding: 14px 36px 0; overflow: hidden;
}
.log-table {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px;
  overflow: hidden;
}

.lt-head {
  display: grid;
  grid-template-columns: 150px 80px 200px 1fr;
  padding: 10px 16px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: rgba(255,255,255,0.25);
  border-bottom: 1px solid rgba(255,255,255,0.07);
}

.lt-empty {
  padding: 48px; text-align: center;
  font-size: 13px; color: rgba(255,255,255,0.2);
}

.lt-row {
  border-bottom: 1px solid rgba(255,255,255,0.05);
  transition: background 0.12s;
}
.lt-row:last-child { border-bottom: none; }
.lt-row.has-tb { cursor: pointer; }
.lt-row.has-tb:hover { background: rgba(255,255,255,0.03); }
.lt-row.expanded { background: rgba(255,255,255,0.04); }

.lt-main {
  display: grid;
  grid-template-columns: 150px 80px 200px 1fr 18px;
  padding: 10px 16px;
  align-items: center;
  gap: 0;
  font-size: 12px;
}

.col-time   { color: rgba(255,255,255,0.3); font-variant-numeric: tabular-nums; }
.col-module { color: rgba(255,255,255,0.45); font-family: var(--font-family-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-msg    { color: rgba(255,255,255,0.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.level-tag {
  display: inline-block; padding: 2px 7px; border-radius: 5px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.level-tag.error   { background: rgba(220,80,80,0.15);  color: rgba(240,120,120,0.95); }
.level-tag.warning { background: rgba(210,160,60,0.15); color: rgba(230,180,80,0.95); }
.level-tag.info    { background: rgba(80,180,140,0.12); color: rgba(100,200,160,0.9); }
.level-tag.debug   { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.3); }

.expand-icon {
  color: rgba(255,255,255,0.25); transform: rotate(-90deg);
  transition: transform 0.18s; justify-self: end;
}
.expand-icon.open { transform: rotate(0deg); color: rgba(255,255,255,0.5); }

.lt-traceback {
  padding: 0 16px 14px 16px;
  position: relative;
}
.tb-copy {
  position: absolute; top: 6px; right: 24px; z-index: 1;
  padding: 3px 10px; border-radius: 6px;
  background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
  color: rgba(255,255,255,0.7); font-size: 11px; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.tb-copy:hover { background: rgba(255,255,255,0.16); color: rgba(255,255,255,0.95); }
.lt-traceback pre {
  margin: 0; padding: 12px 14px; border-radius: 8px;
  background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.07);
  font-family: var(--font-family-mono);
  font-size: 11px; line-height: 1.6;
  color: rgba(240,120,120,0.85);
  overflow-x: auto; white-space: pre;
}

.pagination {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 16px 36px 24px;
}
.pg-btn {
  width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.09); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.pg-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.pg-btn:disabled { opacity: 0.3; cursor: default; }
.pg-info { font-size: 12px; color: rgba(255,255,255,0.35); min-width: 60px; text-align: center; }
</style>
