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
      <div class="page-nav">
        <button class="page-btn" :disabled="pageLoading || !canGoPrevious" @click="goPrevious">
          {{ t('adminLogs.previousPage') }}
        </button>
        <span class="page-label">{{ t('adminLogs.page', { page: currentPage }) }}</span>
        <button class="page-btn" :disabled="pageLoading || !canGoNext" @click="goNext">
          {{ pageLoading ? t('adminLogs.loading') : t('adminLogs.nextPage') }}
        </button>
      </div>
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
              <span class="col-msg">{{ row.message }}</span>
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
import { classifyLogLevel } from '@/utils/logLevel'
import { isUnauthorizedResponse } from '@/services/authSession'
const { t } = useI18n()

const adminStore = useAdminStore()

const lines      = ref<any[]>([])
const searchResults = ref<any[] | null>(null)
const filterSource = ref('')
const filterLevel  = ref('')
const filterText   = ref('')
const autoScroll   = ref(true)
const connected    = ref(false)
const pageLoading = ref(false)
const tableWrap    = ref<HTMLElement | null>(null)
let   streamAbort: AbortController | null = null
let   streamRetry: ReturnType<typeof setTimeout> | null = null
let   streamRunning = true
let   uid          = 0
type LogPage = { rows: any[]; nextCursor: string | null; hasMore: boolean }
const historyPages = ref<LogPage[]>([])
const searchPages = ref<LogPage[]>([])
const pageIndex = ref(0)
const searchPageIndex = ref(0)
const latestNextCursor = ref<string | null>(null)
const latestHasMore = ref(false)
let   searchTimer: ReturnType<typeof setTimeout> | null = null

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
  const level = classifyLogLevel(String(line))
  return level ? `lvl-${level}` : ''
}

const currentPage = computed(() =>
  searchResults.value !== null ? searchPageIndex.value + 1 : pageIndex.value + 1,
)

const currentRows = computed(() => {
  if (searchResults.value !== null) return searchPages.value[searchPageIndex.value]?.rows ?? []
  if (pageIndex.value === 0) return lines.value
  return historyPages.value[pageIndex.value - 1]?.rows ?? []
})

const filtered = computed(() => {
  let list = currentRows.value
  if (filterSource.value) list = list.filter(r => r.source === filterSource.value)
  if (filterLevel.value) list = list.filter(r => rowLevel(r.line) === `lvl-${filterLevel.value}`)
  const q = filterText.value.trim().toLowerCase()
  if (q) list = list.filter(r => r.line.toLowerCase().includes(q))
  return list
})

const canGoPrevious = computed(() =>
  searchResults.value !== null ? searchPageIndex.value > 0 : pageIndex.value > 0,
)

const canGoNext = computed(() => {
  if (searchResults.value !== null) return searchPages.value[searchPageIndex.value]?.hasMore === true
  if (pageIndex.value === 0) return latestHasMore.value
  return historyPages.value[pageIndex.value - 1]?.hasMore === true
})

const liveCount = computed(() => filtered.value.length)

function clearLines() { lines.value = [] }

function parseTime(line: any) {
  // app logger 格式：06-26 08:03:21 INFO ...  → 保留 MM-DD HH:MM:SS；无行内时间戳返回空
  const m = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
  return m ? m[1] : ''
}

function displayMessage(line: string) {
  // 时间已经单独展示；正文去掉行首时间戳，避免出现“时间列 + 正文时间”重叠。
  return line.replace(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*/, '')
}

let lastLogTime = ''   // 续行 / uvicorn / print / traceback 无时间戳 → 沿用上一条 emit 时间，绝不用接收时间
function addLine(source: string, line: string, time: any) {
  if (searchResults.value !== null || pageIndex.value !== 0) return
  // 优先用后端给的 emit 时间（已解析+继承+归并排序）；退到行内解析；再退到上一条；都没有才空
  const t = time || parseTime(line) || lastLogTime
  if (t) lastLogTime = t
  lines.value.push({ id: uid++, source, line, message: displayMessage(line), time: t })
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
    searchResults.value = null
    historyPages.value = []
    pageIndex.value = 0
    latestNextCursor.value = data.next_cursor ?? null
    latestHasMore.value = data.has_more === true
    lastLogTime = ''
    lines.value = []
    for (const { source, line, time } of (data.lines ?? [])) addLine(source, line, time)
  } catch {}
}

function toRows(rows: any[]) {
  return rows.map(({ source, line, time }: any) => ({
    id: uid++, source, line, message: displayMessage(line), time,
  }))
}

async function goPrevious() {
  if (pageLoading.value || !canGoPrevious.value) return
  if (searchResults.value !== null) searchPageIndex.value -= 1
  else pageIndex.value -= 1
}

async function goNext() {
  if (pageLoading.value || !canGoNext.value) return
  const searching = searchResults.value !== null
  const current = searching
    ? searchPages.value[searchPageIndex.value]
    : pageIndex.value === 0
      ? { nextCursor: latestNextCursor.value }
      : historyPages.value[pageIndex.value - 1]
  if (!current?.nextCursor) return
  pageLoading.value = true
  try {
    const params = new URLSearchParams({ lines: '200', cursor: current.nextCursor })
    if (searching) params.set('query', filterText.value.trim())
    const res = await adminStore.authFetch(`/api/v1/admin/debug/logs/tail?${params}`)
    const data = await res.json()
    const nextPage: LogPage = {
      rows: toRows(data.lines ?? []),
      nextCursor: data.next_cursor ?? null,
      hasMore: data.has_more === true,
    }
    if (searching) {
      searchPages.value = [...searchPages.value.slice(0, searchPageIndex.value + 1), nextPage]
      searchPageIndex.value += 1
    } else {
      historyPages.value = [...historyPages.value.slice(0, pageIndex.value), nextPage]
      pageIndex.value += 1
    }
  } finally {
    pageLoading.value = false
  }
}

async function searchHistory() {
  const query = filterText.value.trim()
  if (!query) {
    searchResults.value = null
    searchPages.value = []
    searchPageIndex.value = 0
    void loadTail()
    return
  }
  try {
    const params = new URLSearchParams({ lines: '200', query })
    const res = await adminStore.authFetch(`/api/v1/admin/debug/logs/tail?${params}`)
    const data = await res.json()
    searchResults.value = []
    searchPages.value = [{
      rows: toRows(data.lines ?? []),
      nextCursor: data.next_cursor ?? null,
      hasMore: data.has_more === true,
    }]
    searchPageIndex.value = 0
  } catch {
    searchResults.value = []
    searchPages.value = [{ rows: [], nextCursor: null, hasMore: false }]
    searchPageIndex.value = 0
  }
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
    if (isUnauthorizedResponse(res, 'admin')) return
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

watch(filterText, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void searchHistory() }, 300)
})

onMounted(async () => {
  await loadTail()
  startSSE()
})

onUnmounted(() => {
  streamRunning = false
  if (streamRetry) clearTimeout(streamRetry)
  if (searchTimer) clearTimeout(searchTimer)
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
  width: 280px; height: 34px; padding: 0 11px; box-sizing: border-box;
  border-radius: 8px; font-size: 12px;
  font-family: var(--font-mono, monospace); outline: none;
}
.debug-search::placeholder { font-family: var(--font-sans); }

/* .icon-btn 基础用 Admin 全局样式（AdminApp.vue）；本页保留 active 变体（实时开关） */
.icon-btn.active { background: rgba(100,200,160,0.12); border-color: rgba(100,200,160,0.3); color: rgba(100,200,160,0.9); }
.page-nav { display: flex; align-items: center; gap: 6px; }
.page-btn { height: 34px; padding: 0 10px; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.65); font-size: 12px; cursor: pointer; white-space: nowrap; }
.page-btn:disabled { opacity: 0.4; cursor: default; }
.page-label { min-width: 48px; text-align: center; font-size: 12px; color: rgba(255,255,255,0.45); white-space: nowrap; }

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
  display: grid; grid-template-columns: 72px 128px 1fr;
  padding: 10px 16px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: rgba(255,255,255,0.25);
  border-bottom: 1px solid var(--panel-divider);
}

.lt-empty {
  padding: 48px; text-align: center;
  font-size: 13px; color: rgba(255,255,255,0.2);
}

.lt-row { border-bottom: 1px solid var(--panel-divider); }
.lt-row:last-child { border-bottom: none; }

.lt-main {
  display: grid; grid-template-columns: 72px 128px 1fr;
  padding: 6px 16px; align-items: baseline; gap: 0;
  font-size: 12px; font-family: var(--font-family-mono);
}

.lt-row.lvl-error   .col-msg { color: rgba(240,120,120,0.9); }
.lt-row.lvl-warning .col-msg { color: rgba(230,180,80,0.9); }
.lt-row.lvl-info    .col-msg { color: rgba(255,255,255,0.7); }
.col-time { font-size: 11px; color: rgba(255,255,255,0.25); white-space: nowrap; overflow: hidden; padding-top: 1px; }
.col-msg { color: rgba(255,255,255,0.45); word-break: break-all; white-space: pre-wrap; line-height: 1.55; }

.src-tag {
  display: inline-block; padding: 1px 6px; border-radius: 5px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap;
}
.src-web        { background: rgba(80,140,255,0.12); color: rgba(120,170,255,0.9); }
.src-worker     { background: rgba(80,200,160,0.12); color: rgba(100,210,170,0.9); }
.src-gateway { background: rgba(200,140,80,0.12); color: rgba(220,170,100,0.9); }
</style>
