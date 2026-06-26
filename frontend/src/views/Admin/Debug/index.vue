<template>
  <div class="debug-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">Debug 日志</h2>
        <p class="page-desc">实时 tail 三个日志文件 · {{ liveCount }} 条</p>
      </div>
    </div>

    <div class="toolbar">
      <AdminSelect v-model="filterSource" :options="sourceOptions" style="width:140px" />
      <AdminSelect v-model="filterLevel"  :options="levelOptions"  style="width:130px" />
      <button class="icon-btn" :class="{ active: autoScroll }" @click="autoScroll = !autoScroll" title="自动滚动">
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M7.5 2v11M4 10l3.5 3.5L11 10"/>
        </svg>
      </button>
      <button class="icon-btn" @click="clearLines" title="清空显示">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h10M5 3V2h4v1M3.5 3l.5 9h6l.5-9"/>
        </svg>
      </button>
      <span class="live-dot" :class="{ connected }"></span>
      <span class="toolbar-count">{{ connected ? '实时' : '断开' }}</span>
    </div>

    <div class="log-table-wrap" ref="tableWrap">
      <div class="log-table">
        <div class="lt-head">
          <span class="col-src">来源</span>
          <span class="col-time">时间</span>
          <span class="col-msg">日志</span>
        </div>

        <div v-if="!filtered.length" class="lt-empty">暂无日志</div>

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

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useAdminStore } from '@/stores/admin'
import AdminSelect from '@/components/AdminSelect.vue'

const adminStore = useAdminStore()

const lines      = ref([])
const filterSource = ref('')
const filterLevel  = ref('')
const autoScroll   = ref(true)
const connected    = ref(false)
const tableWrap    = ref(null)
let   sse          = null
let   uid          = 0

const sourceOptions = [
  { label: '全部来源',   value: '' },
  { label: 'web',        value: 'web' },
  { label: 'worker',     value: 'worker' },
  { label: 'supervisor', value: 'supervisor' },
]
const levelOptions = [
  { label: '全部级别', value: '' },
  { label: 'ERROR',   value: 'error' },
  { label: 'WARNING', value: 'warning' },
  { label: 'INFO',    value: 'info' },
]

function rowLevel(line) {
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
  return list
})

const liveCount = computed(() => filtered.value.length)

function clearLines() { lines.value = [] }

function parseTime(line) {
  // app logger 格式：06-26 08:03:21 INFO ...  → 取 HH:MM:SS
  const m = line.match(/^\d{2}-\d{2} (\d{2}:\d{2}:\d{2})/)
  if (m) return m[1]
  return new Date().toTimeString().slice(0, 8)
}

function addLine(source, line) {
  lines.value.push({ id: uid++, source, line, time: parseTime(line) })
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
    for (const { source, line } of (data.lines ?? [])) addLine(source, line)
  } catch {}
}

function startSSE() {
  if (sse) { sse.close(); sse = null }
  const token = localStorage.getItem('admin_token')
  sse = new EventSource(`/api/v1/admin/debug/logs/stream?token=${token}`)
  sse.onopen = () => { connected.value = true }
  sse.onmessage = (e) => {
    try {
      const { source, line } = JSON.parse(e.data)
      addLine(source, line)
    } catch {}
  }
  sse.onerror = () => {
    connected.value = false
    sse?.close()
    setTimeout(startSSE, 3000)
  }
}

watch(autoScroll, (v) => {
  if (v && tableWrap.value) tableWrap.value.scrollTop = tableWrap.value.scrollHeight
})

onMounted(async () => {
  await loadTail()
  startSSE()
})

onUnmounted(() => { sse?.close() })
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

.icon-btn {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.icon-btn:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.8); }
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
  font-size: 12px; font-family: 'SF Mono','Fira Code','Consolas',monospace;
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
.src-supervisor { background: rgba(200,140,80,0.12); color: rgba(220,170,100,0.9); }
</style>
