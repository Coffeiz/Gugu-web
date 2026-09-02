<template>
  <div class="debug-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminLogs.debugTitle') }}</h2>
        <p class="page-desc">{{ t('adminLogs.debugDescription', { count: liveCount }) }}</p>
      </div>
    </div>

    <div class="toolbar">
      <AdminSelect v-model="filterSource" :options="sourceOptions" style="width:140px" />
      <AdminSelect v-model="filterLevel"  :options="levelOptions"  style="width:130px" />
      <input v-model="filterText" class="debug-search" :placeholder="t('adminLogs.searchPlaceholder')" />
      <button class="icon-btn" :class="{ active: autoScroll }" @click="autoScroll = !autoScroll" :title="t('adminLogs.autoScroll')" :aria-label="t('adminLogs.autoScroll')">
        <Icon name="action.scroll-down" size="sm" />
      </button>
      <button class="icon-btn" @click="clearLines" :title="t('adminLogs.clear')" :aria-label="t('adminLogs.clear')">
        <Icon name="action.clear" size="sm" />
      </button>
      <span class="live-dot" :class="{ connected }"></span>
      <span class="toolbar-count">{{ connected ? t('adminLogs.live') : t('adminLogs.disconnected') }}</span>
    </div>

    <div class="log-table-wrap" ref="tableWrap">
      <div class="log-table">
        <div class="lt-head">
          <span class="col-src">{{ t('adminLogs.source') }}</span>
          <span class="col-time">{{ t('adminLogs.time') }}</span>
          <span class="col-msg">{{ t('adminLogs.log') }}</span>
        </div>

        <div v-if="!filtered.length" class="lt-empty">{{ t('adminLogs.empty') }}</div>

        <template v-else>
          <div
            v-for="row in filtered"
            :key="row.id"
            class="lt-row"
            :class="rowLevel(row.line)"
          >
            <div class="lt-main">
              <span class="col-src">
                <span class="src-tag" :class="`src-${row.source}`">{{ row.source }}</span>
              </span>
              <span class="col-time">{{ row.time }}</span>
              <span class="col-msg">{{ row.line }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import AdminSelect from '@/components/AdminSelect.vue'
import Icon from '@/components/common/icons/Icon.vue'
const { t } = useI18n()

const adminStore = useAdminStore()

const lines      = ref<any[]>([])
const filterSource = ref('')
const filterLevel  = ref('')
const filterText   = ref('')
const autoScroll   = ref(true)
const connected    = ref(false)
const tableWrap    = ref<HTMLElement | null>(null)
let   streamAbort: AbortController | null = null
let   streamRetry: ReturnType<typeof setTimeout> | null = null
let   streamRunning = true
let   uid          = 0

const sourceOptions = [
  { label: t('adminLogs.allSources'),   value: '' },
  { label: 'web',        value: 'web' },
  { label: 'worker',     value: 'worker' },
  { label: 'gateway', value: 'gateway' },
]
const levelOptions = [
  { label: t('adminLogs.allLevels'), value: '' },
  { label: 'ERROR',   value: 'error' },
  { label: 'WARNING', value: 'warning' },
  { label: 'INFO',    value: 'info' },
]

function rowLevel(line: any) {
  const u = line.toUpperCase()
  if (u.includes('ERROR') || u.includes('EXCEPTION') || u.includes('TRACEBACK')) return 'lvl-error'
  if (u.includes('WARNING') || u.includes('WARN')) return 'lvl-warning'
  if (u.includes('INFO')) return 'lvl-info'
  return ''
}

const filtered = computed(() => {
  let list = lines.value
  if (filterSource.value) list = list.filter(r => r.source === filterSource.value)
  if (filterLevel.value) list = list.filter(r => rowLevel(r.line) === `lvl-${filterLevel.value}`)
  const q = filterText.value.trim().toLowerCase()
  if (q) list = list.filter(r => r.line.toLowerCase().includes(q))
  return list
})

const liveCount = computed(() => filtered.value.length)

function clearLines() { lines.value = [] }

function parseTime(line: any) {
  // app logger 格式：06-26 08:03:21 INFO ...  → 取 HH:MM:SS；无行内时间戳返回空（不再用 new Date 当接收时间）
  const m = line.match(/^\d{2}-\d{2} (\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : ''
}

let lastLogTime = ''   // 续行 / uvicorn / print / traceback 无时间戳 → 沿用上一条 emit 时间，绝不用接收时间
function addLine(source: string, line: string, time: any) {
  // 优先用后端给的 emit 时间（已解析+继承+归并排序）；退到行内解析；再退到上一条；都没有才空
  const t = time || parseTime(line) || lastLogTime
  if (t) lastLogTime = t
  lines.value.push({ id: uid++, source, line, time: t })
  if (lines.value.length > 2000) lines.value.splice(0, 200)
  if (autoScroll.value) {
    nextTick(() => {
      if (tableWrap.value) tableWrap.value.scrollTop = tableWrap.value.scrollHeight
    })
  }
}

async function loadTail() {
  try {
    const res = await adminStore.authFetch('/api/v1/admin/debug/logs/tail?lines=200')
    const data = await res.json()
    lastLogTime = ''
    for (const { source, line, time } of (data.lines ?? [])) addLine(source, line, time)
  } catch {}
}

async function startSSE() {
  if (!streamRunning) return
  if (streamRetry) { clearTimeout(streamRetry); streamRetry = null }
  streamAbort?.abort()
  const controller = new AbortController()
  streamAbort = controller
  const token = localStorage.getItem('admin_token')

  try {
    const res = await fetch('/api/v1/admin/debug/logs/stream', {
      headers: {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`日志流连接失败（${res.status}）`)
    connected.value = true

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (streamRunning) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const rows = buffer.split('\n')
      buffer = rows.pop() ?? ''
      for (const row of rows) {
        if (!row.startsWith('data:')) continue
        const raw = row.slice(5).trim()
        if (!raw) continue
        try {
          const { source, line, time } = JSON.parse(raw)
          addLine(source, line, time)
        } catch {}
      }
    }
  } catch (error) {
    if ((error as { name?: string }).name !== 'AbortError') {
      connected.value = false
    }
  } finally {
    connected.value = false
    if (streamRunning && !controller.signal.aborted) {
      streamRetry = setTimeout(() => {
        streamRetry = null
        void startSSE()
      }, 3000)
    }
  }
}

watch(autoScroll, (v) => {
  if (v && tableWrap.value) tableWrap.value.scrollTop = tableWrap.value.scrollHeight
})

onMounted(async () => {
  await loadTail()
  startSSE()
})

onUnmounted(() => {
  streamRunning = false
  if (streamRetry) clearTimeout(streamRetry)
  streamAbort?.abort()
})
</script>

<style scoped>
.debug-page { min-height: 100%; display: flex; flex-direction: column; }

.page-header { padding: 32px 36px 0; flex-shrink: 0; }
.page-title  { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc   { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 36px 0; flex-shrink: 0;
}
.toolbar-count { font-size: 12px; color: rgba(255,255,255,0.3); }
.debug-search {
  width: 280px; height: 30px; padding: 0 11px;
  border-radius: 8px; font-size: 12px;
  font-family: var(--font-mono, monospace); outline: none;
}
.debug-search::placeholder { font-family: var(--font-sans); }

/* .icon-btn 基础用 Admin 全局样式（AdminApp.vue）；本页保留 active 变体（实时开关） */
.icon-btn.active { background: rgba(100,200,160,0.12); border-color: rgba(100,200,160,0.3); color: rgba(100,200,160,0.9); }

.live-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: rgba(255,255,255,0.2); transition: background 0.3s;
}
.live-dot.connected { background: rgba(100,200,160,0.9); box-shadow: 0 0 6px rgba(100,200,160,0.5); }

.log-table-wrap {
  flex: 1; padding: 14px 36px 24px; overflow-y: auto; min-height: 0;
}
.log-table {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; overflow: hidden;
}

.lt-head {
  display: grid; grid-template-columns: 96px 72px 1fr;
  padding: 10px 16px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: rgba(255,255,255,0.25);
  border-bottom: 1px solid rgba(255,255,255,0.07);
}

.lt-empty {
  padding: 48px; text-align: center;
  font-size: 13px; color: rgba(255,255,255,0.2);
}

.lt-row { border-bottom: 1px solid rgba(255,255,255,0.04); }
.lt-row:last-child { border-bottom: none; }

.lt-main {
  display: grid; grid-template-columns: 96px 72px 1fr;
  padding: 6px 16px; align-items: baseline; gap: 0;
  font-size: 12px; font-family: var(--font-family-mono);
}

.lt-row.lvl-error   .col-msg { color: rgba(240,120,120,0.9); }
.lt-row.lvl-warning .col-msg { color: rgba(230,180,80,0.9); }
.lt-row.lvl-info    .col-msg { color: rgba(255,255,255,0.7); }
.col-time { font-size: 11px; color: rgba(255,255,255,0.25); white-space: nowrap; padding-top: 1px; }
.col-msg { color: rgba(255,255,255,0.45); word-break: break-all; white-space: pre-wrap; line-height: 1.55; }

.src-tag {
  display: inline-block; padding: 1px 6px; border-radius: 5px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap;
}
.src-web        { background: rgba(80,140,255,0.12); color: rgba(120,170,255,0.9); }
.src-worker     { background: rgba(80,200,160,0.12); color: rgba(100,210,170,0.9); }
.src-gateway { background: rgba(200,140,80,0.12); color: rgba(220,170,100,0.9); }
</style>
