<template>
  <div class="invite-page">

    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">邀请码管理</h2>
        <p class="page-desc">生成并发放邀请码，用于控制注册权限</p>
      </div>
      <div class="header-stats">
        <div class="stat-item">
          <span class="stat-num">{{ validCount }}</span>
          <span class="stat-label">可用</span>
        </div>
        <div class="stat-divider" />
        <div class="stat-item">
          <span class="stat-num used">{{ usedCount }}</span>
          <span class="stat-label">已用</span>
        </div>
      </div>
    </div>

    <!-- 生成面板 -->
    <div class="generate-bar">
      <div class="gen-left">
        <input
          class="gen-input"
          v-model="genNote"
          placeholder="备注（可选，如：朋友 / 测试）"
          @keydown.enter="generate"
        />
        <div class="count-picker">
          <button class="count-btn" @click="genCount > 1 && genCount--">−</button>
          <span class="count-num">{{ genCount }}</span>
          <button class="count-btn" @click="genCount < 20 && genCount++">+</button>
          <span class="count-label">个</span>
        </div>
      </div>
      <button class="btn-generate" :class="{ loading: generating }" :disabled="generating" @click="generate">
        <svg v-if="!generating" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M7 2v10M2 7h10"/>
        </svg>
        <svg v-else class="spin-icon" width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>
        </svg>
        {{ generating ? '生成中…' : '生成邀请码' }}
      </button>
    </div>

    <!-- 新生成的码高亮展示 -->
    <div v-if="freshCodes.length" class="fresh-banner">
      <div class="fresh-header">
        <span class="fresh-title">刚刚生成</span>
        <button class="btn-copy-all" @click="copyAll">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <rect x="4" y="4" width="8" height="8" rx="1.5"/>
            <path d="M2 10V3a1 1 0 011-1h7"/>
          </svg>
          全部复制
        </button>
      </div>
      <div class="fresh-codes">
        <div
          v-for="c in freshCodes"
          :key="c.code"
          class="fresh-code-item"
          @click="copyCode(c.code)"
          title="点击复制"
        >
          <code>{{ c.code }}</code>
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <rect x="4" y="4" width="8" height="8" rx="1.5"/>
            <path d="M2 10V3a1 1 0 011-1h7"/>
          </svg>
        </div>
      </div>
    </div>

    <!-- 码列表 -->
    <div class="codes-card">
      <div class="card-head-row">
        <div class="filter-tabs">
          <button class="filter-btn" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
          <button class="filter-btn" :class="{ active: filter === 'valid' }" @click="filter = 'valid'">可用</button>
          <button class="filter-btn" :class="{ active: filter === 'used' }" @click="filter = 'used'">已用</button>
        </div>
        <button class="btn-refresh" :class="{ spinning: refreshing }" @click="load(true)" title="刷新">
          <PhArrowClockwise :size="15" weight="bold" />
        </button>
      </div>

      <div v-if="loading" class="list-loading">加载中…</div>
      <div v-else-if="filtered.length === 0" class="list-empty">
        {{ filter === 'valid' ? '暂无可用邀请码' : filter === 'used' ? '暂无已用邀请码' : '暂无邀请码，点击上方生成' }}
      </div>
      <div v-else class="code-list">
        <div
          v-for="code in filtered"
          :key="code.id"
          class="code-row"
          :class="{ used: code.used }"
        >
          <div class="code-main">
            <code class="code-text" :class="{ faded: code.used }">{{ code.code }}</code>
            <span v-if="code.note" class="code-note">{{ code.note }}</span>
          </div>
          <div class="code-meta">
            <span v-if="code.used" class="badge-used">
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>
              已使用 · {{ code.used_at }}
            </span>
            <span v-else class="badge-valid">可用</span>
          </div>
          <div class="code-actions">
            <button
              v-if="!code.used"
              class="action-btn copy-btn"
              @click="copyCode(code.code)"
              title="复制"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <rect x="4" y="4" width="8" height="8" rx="1.5"/>
                <path d="M2 10V3a1 1 0 011-1h7"/>
              </svg>
            </button>
            <button class="action-btn delete-btn" @click="deleteCode(code)" title="删除">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 4h10M5 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4M6 7v3M8 7v3M3 4l1 8h6l1-8"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 复制成功 Toast -->
    <Transition name="toast">
      <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
    </Transition>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { PhArrowClockwise } from '@phosphor-icons/vue'

const adminStore = useAdminStore()

const codes      = ref([])
const loading    = ref(false)
const refreshing = ref(false)
const generating = ref(false)
const genCount   = ref(1)
const genNote    = ref('')
const freshCodes = ref([])
const filter     = ref('all')
const toastMsg   = ref('')

const validCount = computed(() => codes.value.filter(c => !c.used).length)
const usedCount  = computed(() => codes.value.filter(c => c.used).length)
const filtered   = computed(() => {
  if (filter.value === 'valid') return codes.value.filter(c => !c.used)
  if (filter.value === 'used')  return codes.value.filter(c => c.used)
  return codes.value
})

async function load(manual = false) {
  if (manual) {
    refreshing.value = true
    setTimeout(() => { refreshing.value = false }, 550)
  }
  loading.value = true
  try {
    const res  = await adminStore.authFetch('/api/v1/admin/invite-codes')
    const data = await res.json()
    codes.value = data.codes
  } finally {
    loading.value = false
  }
}

async function generate() {
  generating.value = true
  try {
    const res  = await adminStore.authFetch('/api/v1/admin/invite-codes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: genCount.value, note: genNote.value }),
    })
    const data = await res.json()
    freshCodes.value = data.codes
    await load()
    genNote.value = ''
  } finally {
    generating.value = false
  }
}

async function deleteCode(code) {
  if (code.used && !confirm(`邀请码 ${code.code} 已被使用，确认删除？`)) return
  await adminStore.authFetch(`/api/v1/admin/invite-codes/${code.id}`, { method: 'DELETE' })
  codes.value = codes.value.filter(c => c.id !== code.id)
  freshCodes.value = freshCodes.value.filter(c => c.id !== code.id)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fallback for non-HTTPS
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  }
}

async function copyCode(code) {
  const ok = await copyText(code)
  showToast(ok ? `已复制 ${code}` : '复制失败，请手动复制')
}

async function copyAll() {
  const text = freshCodes.value.map(c => c.code).join('\n')
  const ok = await copyText(text)
  showToast(ok ? `已复制 ${freshCodes.value.length} 个邀请码` : '复制失败，请手动复制')
}

function showToast(msg) {
  toastMsg.value = msg
  setTimeout(() => { toastMsg.value = '' }, 2200)
}

onMounted(load)
</script>

<style scoped>
.invite-page { min-height: 100%; display: flex; flex-direction: column; gap: 14px; padding: 32px 36px; }

/* ── 页头 ── */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
}
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.header-stats { display: flex; align-items: center; gap: 16px; }
.stat-item { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.stat-num {
  font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.85); line-height: 1;
}
.stat-num.used { color: rgba(255,255,255,0.3); }
.stat-label { font-size: 11px; color: rgba(255,255,255,0.3); }
.stat-divider { width: 1px; height: 28px; background: rgba(255,255,255,0.1); }

/* ── 生成栏 ── */
.generate-bar {
  display: flex; align-items: center; gap: 12px;
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 14px;
  padding: 16px 20px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06);
}
.gen-left { display: flex; align-items: center; gap: 10px; flex: 1; }
.gen-input {
  flex: 1; padding: 8px 12px;
  background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.09);
  border-radius: 9px; font-size: 13px; color: rgba(255,255,255,0.8);
  font-family: var(--font-sans); outline: none;
  transition: border-color 0.15s;
}
.gen-input:focus { border-color: rgba(123,127,178,0.4); }
.gen-input::placeholder { color: rgba(255,255,255,0.22); }

.count-picker { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.count-btn {
  width: 26px; height: 26px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.55); font-size: 16px; line-height: 1;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.count-btn:hover { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.85); }
.count-num { font-size: 15px; font-weight: 700; color: rgba(255,255,255,0.82); min-width: 20px; text-align: center; }
.count-label { font-size: 13px; color: rgba(255,255,255,0.35); }

.btn-generate {
  display: flex; align-items: center; gap: 7px;
  padding: 9px 20px; border-radius: 10px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: 0 2px 10px rgba(123,127,178,0.25);
  flex-shrink: 0;
}
.btn-generate:hover:not(:disabled) { opacity: 0.88; }
.btn-generate:disabled { opacity: 0.5; cursor: default; }

/* ── 新生成高亮 ── */
.fresh-banner {
  background: rgba(123,127,178,0.1);
  border: 1px solid rgba(123,127,178,0.25);
  border-radius: 14px; padding: 16px 20px;
}
.fresh-header {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
}
.fresh-title { font-size: 12px; font-weight: 600; color: rgba(149,144,196,0.8); }
.btn-copy-all {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; color: rgba(149,144,196,0.7);
  background: none; border: none; cursor: pointer;
  transition: color 0.15s;
}
.btn-copy-all:hover { color: rgba(149,144,196,1); }
.fresh-codes { display: flex; flex-wrap: wrap; gap: 8px; }
.fresh-code-item {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 14px; border-radius: 9px;
  background: rgba(123,127,178,0.15); border: 1px solid rgba(123,127,178,0.3);
  cursor: pointer; transition: all 0.15s;
}
.fresh-code-item:hover { background: rgba(123,127,178,0.25); }
.fresh-code-item code {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.88);
  letter-spacing: 0.04em;
}
.fresh-code-item svg { color: rgba(149,144,196,0.6); flex-shrink: 0; }

/* ── 列表卡片 ── */
.codes-card {
  flex: 1;
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
  padding: 18px 20px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06);
}
.card-head-row {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 14px;
}
.filter-tabs { display: flex; gap: 4px; }
.filter-btn {
  padding: 5px 14px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.04);
  font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.35);
  cursor: pointer; transition: all 0.15s;
}
.filter-btn:hover:not(.active) { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.6); }
.filter-btn.active {
  background: rgba(123,127,178,0.18); border-color: rgba(123,127,178,0.3);
  color: rgba(255,255,255,0.85); font-weight: 600;
}
.btn-refresh {
  width: 34px; height: 34px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.btn-refresh:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.8); }
.btn-refresh.spinning svg { animation: spin 0.5s ease-out; transform-box: fill-box; transform-origin: center; }

.list-loading, .list-empty {
  text-align: center; padding: 48px 0;
  font-size: 13px; color: rgba(255,255,255,0.2);
}

.code-list { display: flex; flex-direction: column; }
.code-row {
  display: flex; align-items: center; gap: 14px;
  padding: 11px 4px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  transition: background 0.15s;
}
.code-row:last-child { border-bottom: none; }
.code-row:hover { background: rgba(255,255,255,0.025); border-radius: 8px; }

.code-main { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.code-text {
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 14px; font-weight: 600; color: rgba(255,255,255,0.88);
  letter-spacing: 0.04em; flex-shrink: 0;
}
.code-text.faded { color: rgba(255,255,255,0.25); }
.code-note {
  font-size: 12px; color: rgba(255,255,255,0.3);
  background: rgba(255,255,255,0.06); border-radius: 5px;
  padding: 2px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.code-meta { flex-shrink: 0; }
.badge-valid {
  font-size: 11px; font-weight: 600; color: #5ab899;
  background: rgba(90,184,153,0.1); border: 1px solid rgba(90,184,153,0.2);
  padding: 3px 10px; border-radius: 20px;
}
.badge-used {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
  padding: 3px 10px; border-radius: 20px; white-space: nowrap;
}

.code-actions { display: flex; gap: 4px; flex-shrink: 0; }
.action-btn {
  width: 28px; height: 28px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.04);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.15s;
}
.copy-btn { color: rgba(255,255,255,0.35); }
.copy-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.75); }
.delete-btn { color: rgba(255,255,255,0.2); }
.delete-btn:hover { background: rgba(224,120,120,0.12); border-color: rgba(224,120,120,0.2); color: #e07878; }

/* ── Toast ── */
.toast {
  position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
  background: rgba(30,32,40,0.92); backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
  padding: 10px 20px; font-size: 13px; color: rgba(255,255,255,0.82);
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  pointer-events: none; white-space: nowrap; z-index: 9999;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(8px); }
.toast-leave-to   { opacity: 0; transform: translateX(-50%) translateY(8px); }

@keyframes spin { to { transform: rotate(360deg); } }
.spin-icon { animation: spin 0.8s linear infinite; }
</style>
