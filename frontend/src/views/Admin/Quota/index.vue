<template>
  <div class="quota-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">配额管理</h2>
        <p class="page-desc">设置全局默认用量上限，或为单个用户覆盖配额</p>
      </div>
    </div>

    <!-- 全局默认配额 -->
    <div class="section-wrap">
      <div class="section-head">
        <span class="section-label">全局默认</span>
        <span class="section-desc">适用于未单独设置配额的所有用户</span>
      </div>

      <div class="global-card">
        <div class="quota-fields">
          <div class="quota-field">
            <label class="qf-label">6 小时 Token 上限
              <span class="qf-hint">滑动窗口，防突发</span>
            </label>
            <div class="qf-input-row">
              <input v-model.number="globalDraft.token6h" class="qf-input" type="number" min="0" placeholder="不限制" />
              <span class="qf-unit">tokens</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="globalDraft.token6h = null">不限制</button>
              <button class="preset-chip" @click="globalDraft.token6h = 50000">5 万</button>
              <button class="preset-chip" @click="globalDraft.token6h = 100000">10 万</button>
              <button class="preset-chip" @click="globalDraft.token6h = 300000">30 万</button>
            </div>
          </div>

          <div class="quota-field">
            <label class="qf-label">每周 Token 上限
              <span class="qf-hint">周一重置</span>
            </label>
            <div class="qf-input-row">
              <input v-model.number="globalDraft.tokenWeek" class="qf-input" type="number" min="0" placeholder="不限制" />
              <span class="qf-unit">tokens</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="globalDraft.tokenWeek = null">不限制</button>
              <button class="preset-chip" @click="globalDraft.tokenWeek = 200000">20 万</button>
              <button class="preset-chip" @click="globalDraft.tokenWeek = 500000">50 万</button>
              <button class="preset-chip" @click="globalDraft.tokenWeek = 1000000">100 万</button>
            </div>
          </div>

          <div class="quota-field">
            <label class="qf-label">存储空间上限</label>
            <div class="qf-input-row">
              <input v-model.number="globalDraft.storageGB" class="qf-input" type="number" min="0" placeholder="不限制" />
              <span class="qf-unit">GB</span>
            </div>
            <div class="qf-presets">
              <button class="preset-chip" @click="globalDraft.storageGB = null">不限制</button>
              <button class="preset-chip" @click="globalDraft.storageGB = 5">5 GB</button>
              <button class="preset-chip" @click="globalDraft.storageGB = 20">20 GB</button>
              <button class="preset-chip" @click="globalDraft.storageGB = 50">50 GB</button>
              <button class="preset-chip" @click="globalDraft.storageGB = 100">100 GB</button>
            </div>
          </div>
        </div>

        <div class="global-footer">
          <span class="save-hint" v-if="globalSaved">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round"><path d="M2 6l2.5 2.5 5.5-5"/></svg>
            已保存
          </span>
          <span v-else />
          <button class="btn-save" :class="{ loading: globalSaving }" :disabled="globalSaving" @click="saveGlobal">
            {{ globalSaving ? '保存中…' : '保存全局配额' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 用户配额覆盖 -->
    <div class="section-wrap">
      <div class="section-head">
        <span class="section-label">用户覆盖</span>
        <span class="section-desc">单独设置配额的用户，优先级高于全局默认</span>
        <button class="icon-btn" :class="{ spinning: refreshing }" @click="loadUsers(true)" title="刷新">
          <PhArrowClockwise :size="14" weight="bold" />
        </button>
      </div>

      <div class="users-card">
        <div v-if="loading" class="state-empty">加载中…</div>
        <div v-else-if="!overrideUsers.length" class="state-empty">
          暂无用户单独设置配额
        </div>
        <template v-else>
          <div class="ut-head">
            <span class="col-user">用户</span>
            <span class="col-token">Token 限额 / 本周用量</span>
            <span class="col-storage">存储上限 / 已用</span>
            <span class="col-action"></span>
          </div>
          <div v-for="u in overrideUsers" :key="u.id" class="ut-row">
            <span class="col-user">
              <span class="avatar-circle" :style="avatarStyle(u)">{{ avatarChar(u) }}</span>
              <span class="user-info">
                <span class="display-name">{{ u.display_name || u.username }}</span>
                <span class="username-sub" v-if="u.display_name">@{{ u.username }}</span>
              </span>
            </span>
            <span class="col-token">
              <span class="quota-cell">
                <span class="quota-limit">{{ fmtTokens(u.token_limit_weekly) || '—' }}</span>
                <span class="usage-bar-bg" v-if="u.token_limit_weekly">
                  <span class="usage-bar-fill token-fill" :style="tokenBarStyle(u)"></span>
                </span>
                <span class="quota-used">{{ fmtTokens(u.tokens_week) }} 已用</span>
              </span>
            </span>
            <span class="col-storage">
              <span class="quota-cell">
                <span class="quota-limit">{{ fmtBytes(u.storage_limit_bytes) }}</span>
                <span class="usage-bar-bg" v-if="u.storage_limit_bytes">
                  <span class="usage-bar-fill storage-fill" :style="storageBarStyle(u)"></span>
                </span>
                <span class="quota-used">{{ fmtBytes(u.storage_used) }} 已用</span>
              </span>
            </span>
            <span class="col-action">
              <button class="action-btn" @click="openEdit(u)">编辑</button>
              <button class="action-btn danger" @click="clearQuota(u)">清除</button>
            </span>
          </div>
        </template>
      </div>

      <!-- 所有用户 -->
      <div class="section-head" style="margin-top:20px">
        <span class="section-label">所有用户</span>
        <span class="section-desc">点击编辑为任意用户单独设置配额</span>
        <input v-model="search" class="search-input" placeholder="搜索…" @input="onSearch" />
      </div>
      <div class="users-card">
        <div v-if="loading" class="state-empty">加载中…</div>
        <div v-else-if="!allUsers.length" class="state-empty">暂无用户</div>
        <template v-else>
          <div class="ut-head">
            <span class="col-user">用户</span>
            <span class="col-token">Token 用量（本月）</span>
            <span class="col-storage">存储用量</span>
            <span class="col-status">配额状态</span>
            <span class="col-action"></span>
          </div>
          <div v-for="u in allUsers" :key="u.id" class="ut-row">
            <span class="col-user">
              <span class="avatar-circle" :style="avatarStyle(u)">{{ avatarChar(u) }}</span>
              <span class="user-info">
                <span class="display-name">{{ u.display_name || u.username }}</span>
                <span class="username-sub" v-if="u.display_name">@{{ u.username }}</span>
              </span>
            </span>
            <span class="col-token">
              <span class="usage-text">{{ fmtTokens(u.tokens_month) }}</span>
            </span>
            <span class="col-storage">
              <span class="usage-text">{{ fmtBytes(u.storage_used) }}</span>
            </span>
            <span class="col-status">
              <span class="quota-badge" :class="(u.token_limit_6h || u.token_limit_weekly || u.storage_limit_bytes) ? 'custom' : 'default'">
                {{ (u.token_limit_6h || u.token_limit_weekly || u.storage_limit_bytes) ? '自定义' : '全局默认' }}
              </span>
            </span>
            <span class="col-action">
              <button class="action-btn" @click="openEdit(u)">编辑配额</button>
            </span>
          </div>
        </template>
      </div>
    </div>

    <!-- 配额编辑弹窗 -->
    <Teleport to="body">
      <div v-if="editTarget" class="modal-mask" @click.self="editTarget = null">
        <div class="modal-box">
          <p class="modal-title">编辑配额</p>
          <p class="modal-subtitle">{{ editTarget.display_name || editTarget.username }}</p>

          <div class="quota-fields quota-fields--single" style="margin-top:18px">
            <div class="quota-field">
              <label class="qf-label">6 小时 Token 上限
                <span class="qf-hint">滑动窗口，防突发</span>
              </label>
              <div class="qf-input-row">
                <input v-model.number="editForm.token6h" class="qf-input" type="number" min="0" placeholder="不限制（跟随全局）" />
                <span class="qf-unit">tokens</span>
              </div>
              <div class="qf-presets">
                <button class="preset-chip" @click="editForm.token6h = null">不限制</button>
                <button class="preset-chip" @click="editForm.token6h = 50000">5 万</button>
                <button class="preset-chip" @click="editForm.token6h = 100000">10 万</button>
                <button class="preset-chip" @click="editForm.token6h = 300000">30 万</button>
              </div>
            </div>
            <div class="quota-field">
              <label class="qf-label">每周 Token 上限
                <span class="qf-hint">周一重置</span>
              </label>
              <div class="qf-input-row">
                <input v-model.number="editForm.tokenWeek" class="qf-input" type="number" min="0" placeholder="不限制（跟随全局）" />
                <span class="qf-unit">tokens</span>
              </div>
              <div class="qf-presets">
                <button class="preset-chip" @click="editForm.tokenWeek = null">不限制</button>
                <button class="preset-chip" @click="editForm.tokenWeek = 200000">20 万</button>
                <button class="preset-chip" @click="editForm.tokenWeek = 500000">50 万</button>
                <button class="preset-chip" @click="editForm.tokenWeek = 1000000">100 万</button>
              </div>
            </div>
            <div class="quota-field">
              <label class="qf-label">存储空间上限</label>
              <div class="qf-input-row">
                <input v-model.number="editForm.storageGB" class="qf-input" type="number" min="0" placeholder="不限制（跟随全局）" />
                <span class="qf-unit">GB</span>
              </div>
              <div class="qf-presets">
                <button class="preset-chip" @click="editForm.storageGB = null">不限制</button>
                <button class="preset-chip" @click="editForm.storageGB = 5">5 GB</button>
                <button class="preset-chip" @click="editForm.storageGB = 20">20 GB</button>
                <button class="preset-chip" @click="editForm.storageGB = 50">50 GB</button>
                <button class="preset-chip" @click="editForm.storageGB = 100">100 GB</button>
              </div>
            </div>
          </div>

          <div class="modal-actions">
            <button class="btn-cancel" @click="editTarget = null">取消</button>
            <button class="btn-confirm" @click="saveEdit" :disabled="editSaving">
              {{ editSaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { useConfigStore } from '@/stores/config'
import { PhArrowClockwise } from '@phosphor-icons/vue'

const adminStore  = useAdminStore()
const configStore = useConfigStore()

// ── 全局配额 ──────────────────────────────────────────────────────────────────
const globalDraft  = reactive({ token6h: null, tokenWeek: null, storageGB: null })
const globalSaving = ref(false)
const globalSaved  = ref(false)

function _loadGlobalDraft() {
  const q = configStore.cfg?.quota || {}
  globalDraft.token6h   = q.default_token_limit_6h     ?? null
  globalDraft.tokenWeek = q.default_token_limit_weekly  ?? null
  globalDraft.storageGB = q.default_storage_limit_bytes != null
    ? +(q.default_storage_limit_bytes / 1073741824).toFixed(2) : null
}

async function saveGlobal() {
  globalSaving.value = true
  globalSaved.value  = false
  try {
    await configStore.saveConfig({
      quota: {
        default_token_limit_6h:      globalDraft.token6h   != null ? Number(globalDraft.token6h)   : null,
        default_token_limit_weekly:  globalDraft.tokenWeek != null ? Number(globalDraft.tokenWeek) : null,
        default_storage_limit_bytes: globalDraft.storageGB != null ? Math.round(Number(globalDraft.storageGB) * 1073741824) : null,
      },
    })
    globalSaved.value = true
    setTimeout(() => { globalSaved.value = false }, 3000)
  } finally {
    globalSaving.value = false
  }
}

// ── 用户列表 ──────────────────────────────────────────────────────────────────
const allItems   = ref([])
const loading    = ref(false)
const refreshing = ref(false)
const search     = ref('')

const overrideUsers = computed(() =>
  allItems.value.filter(u => u.token_limit_6h != null || u.token_limit_weekly != null || u.storage_limit_bytes != null)
)

const allUsers = computed(() => {
  const q = search.value.toLowerCase()
  if (!q) return allItems.value
  return allItems.value.filter(u =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.email    || '').toLowerCase().includes(q)
  )
})

async function loadUsers(manual = false) {
  if (manual) {
    refreshing.value = true
    setTimeout(() => { refreshing.value = false }, 550)
  }
  loading.value = true
  try {
    const res  = await adminStore.authFetch('/api/v1/admin/users')
    const data = await res.json()
    allItems.value = data.items ?? []
  } finally {
    loading.value = false
  }
}

let searchTimer = null
function onSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {}, 0)
}

// ── 编辑弹窗 ─────────────────────────────────────────────────────────────────
const editTarget = ref(null)
const editSaving = ref(false)
const editForm   = reactive({ token6h: null, tokenWeek: null, storageGB: null })

function openEdit(u) {
  editTarget.value = u
  editForm.token6h   = u.token_limit_6h    ?? null
  editForm.tokenWeek = u.token_limit_weekly ?? null
  editForm.storageGB = u.storage_limit_bytes != null
    ? +(u.storage_limit_bytes / 1073741824).toFixed(2) : null
}

async function saveEdit() {
  if (!editTarget.value) return
  editSaving.value = true
  try {
    const body = {
      token_limit_6h:      editForm.token6h   != null ? Number(editForm.token6h)   : null,
      token_limit_weekly:  editForm.tokenWeek != null ? Number(editForm.tokenWeek) : null,
      storage_limit_bytes: editForm.storageGB != null ? Math.round(Number(editForm.storageGB) * 1073741824) : null,
    }
    const res  = await adminStore.authFetch(`/api/v1/admin/users/${editTarget.value.id}/quota`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    editTarget.value.token_limit_6h      = data.token_limit_6h
    editTarget.value.token_limit_weekly  = data.token_limit_weekly
    editTarget.value.storage_limit_bytes = data.storage_limit_bytes
    editTarget.value = null
  } finally {
    editSaving.value = false
  }
}

async function clearQuota(u) {
  await adminStore.authFetch(`/api/v1/admin/users/${u.id}/quota`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token_limit_6h: null, token_limit_weekly: null, storage_limit_bytes: null }),
  })
  u.token_limit_6h      = null
  u.token_limit_weekly  = null
  u.storage_limit_bytes = null
}

// ── 格式化 ────────────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  ['#5a6b9e', '#8490c4'], ['#5a8e7e', '#7cbfad'],
  ['#8e6a5a', '#c49078'], ['#6a5a8e', '#9878c4'], ['#5a7e8e', '#78b0bf'],
]
function avatarChar(u) { return (u.display_name || u.username || '?').charAt(0).toUpperCase() }
function avatarStyle(u) {
  const [c1, c2] = AVATAR_COLORS[u.username.charCodeAt(0) % AVATAR_COLORS.length]
  return { background: `linear-gradient(135deg, ${c1}, ${c2})` }
}
function fmtTokens(n) {
  if (n == null) return '—'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K'
  return String(n)
}
function fmtBytes(n) {
  if (!n) return '—'
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
  if (n >= 1048576)    return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024)       return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}
function tokenBarStyle(u) {
  const pct = u.token_limit_weekly ? Math.min(100, (u.tokens_week / u.token_limit_weekly) * 100) : 0
  const color = pct >= 90 ? 'rgba(220,80,80,0.85)' : pct >= 70 ? 'rgba(220,160,60,0.85)' : 'rgba(80,160,200,0.75)'
  return { width: pct + '%', background: color }
}
function storageBarStyle(u) {
  const pct = u.storage_limit_bytes ? Math.min(100, (u.storage_used / u.storage_limit_bytes) * 100) : 0
  const color = pct >= 90 ? 'rgba(220,80,80,0.85)' : pct >= 70 ? 'rgba(220,160,60,0.85)' : 'rgba(80,200,140,0.75)'
  return { width: pct + '%', background: color }
}

onMounted(async () => {
  await configStore.fetchConfig()
  _loadGlobalDraft()
  loadUsers()
})
</script>

<style scoped>
.quota-page { min-height: 100%; }

.page-header { padding: 32px 36px 0; }
.page-title-block { display: flex; flex-direction: column; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.section-wrap { padding: 20px 36px 0; }
.section-head {
  display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
}
.section-label {
  font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: rgba(255,255,255,0.5);
}
.section-desc { font-size: 12px; color: rgba(255,255,255,0.25); flex: 1; }

.icon-btn {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.4); cursor: pointer; transition: all 0.15s;
}
.icon-btn:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.75); }
.icon-btn.spinning svg { animation: spin 0.5s ease-out; transform-box: fill-box; transform-origin: center; }
@keyframes spin { to { transform: rotate(360deg); } }

/* 全局配额卡片 */
.global-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; overflow: hidden;
  padding: 20px 22px 16px;
}
.quota-fields {
  display: grid; grid-template-columns: 1fr 1fr; gap: 20px;
}
.quota-fields--single { grid-template-columns: 1fr; gap: 16px; }
.quota-field { display: flex; flex-direction: column; gap: 8px; }
.qf-label {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.4);
  letter-spacing: 0.04em;
}
.qf-hint {
  font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.2);
  letter-spacing: 0; text-transform: none;
}
.qf-input-row { display: flex; align-items: center; gap: 8px; }
.qf-input {
  flex: 1; height: 34px; padding: 0 12px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.8); font-size: 13px; outline: none;
  transition: border-color 0.15s;
  appearance: none; -moz-appearance: textfield;
}
.qf-input::-webkit-outer-spin-button,
.qf-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.qf-input:focus { border-color: rgba(255,255,255,0.25); }
.qf-input::placeholder { color: rgba(255,255,255,0.2); }
.qf-unit { font-size: 12px; color: rgba(255,255,255,0.3); white-space: nowrap; }
.qf-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.preset-chip {
  padding: 3px 10px; border-radius: 7px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.4); transition: all 0.12s;
}
.preset-chip:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.7); }
.global-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 18px; padding-top: 14px;
  border-top: 1px solid rgba(255,255,255,0.07);
}
.save-hint {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600; color: #5ab899;
}
.btn-save {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 18px; border-radius: 9px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: 0 2px 8px rgba(123,127,178,0.18);
}
.btn-save:hover:not(.loading) { opacity: 0.88; }
.btn-save.loading { opacity: 0.5; cursor: default; }

/* 用户表格 */
.users-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; overflow: hidden;
}
.state-empty {
  padding: 40px; text-align: center;
  font-size: 13px; color: rgba(255,255,255,0.2);
}
.ut-head {
  display: grid;
  grid-template-columns: 200px 1fr 1fr 80px 120px;
  padding: 9px 16px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: rgba(255,255,255,0.25);
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.ut-row {
  display: grid;
  grid-template-columns: 200px 1fr 1fr 80px 120px;
  padding: 10px 16px; align-items: center;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 13px; transition: background 0.12s;
}
.ut-row:last-child { border-bottom: none; }
.ut-row:hover { background: rgba(255,255,255,0.03); }

.col-user { display: flex; align-items: center; gap: 9px; min-width: 0; }
.avatar-circle {
  width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.92);
}
.user-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.display-name {
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.82);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.username-sub { font-size: 11px; color: rgba(255,255,255,0.3); }

.quota-cell { display: flex; align-items: center; gap: 7px; }
.quota-limit { font-size: 12px; color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; white-space: nowrap; }
.quota-used  { font-size: 11px; color: rgba(255,255,255,0.25); white-space: nowrap; }
.usage-bar-bg {
  width: 50px; height: 3px; border-radius: 2px; flex-shrink: 0;
  background: rgba(255,255,255,0.08); overflow: hidden;
}
.usage-bar-fill { display: block; height: 100%; border-radius: 2px; transition: width 0.3s; }

.usage-text { font-size: 12px; color: rgba(255,255,255,0.4); }

.quota-badge {
  display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;
}
.quota-badge.custom  { background: rgba(140,100,200,0.12); color: rgba(170,130,230,0.9); }
.quota-badge.default { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.3); }

.col-action { display: flex; align-items: center; gap: 6px; }
.action-btn {
  height: 28px; padding: 0 12px; border-radius: 8px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.65); transition: all 0.15s; white-space: nowrap;
}
.action-btn:hover { background: rgba(255,255,255,0.13); color: rgba(255,255,255,0.9); border-color: rgba(255,255,255,0.2); }
.action-btn.danger { border-color: rgba(220,80,80,0.25); color: rgba(220,100,100,0.75); background: rgba(220,80,80,0.06); }
.action-btn.danger:hover { background: rgba(220,80,80,0.14); color: rgba(240,120,120,0.95); border-color: rgba(220,80,80,0.4); }

.search-input {
  height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.7); outline: none; width: 160px;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: rgba(255,255,255,0.22); }
.search-input::placeholder { color: rgba(255,255,255,0.22); }

/* 弹窗 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 9100;
}
.modal-box {
  background: rgba(18,20,36,0.96);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 16px; padding: 28px 28px 24px; width: 420px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
}
.modal-title    { font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.92); margin-bottom: 6px; }
.modal-subtitle { font-size: 13px; color: rgba(255,255,255,0.35); }
.modal-actions  { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
.btn-cancel {
  padding: 7px 18px; border-radius: 9px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.55); transition: all 0.15s;
}
.btn-cancel:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); }
.btn-confirm {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 18px; border-radius: 9px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 13px; font-weight: 600;
  cursor: pointer; transition: opacity 0.15s;
  box-shadow: 0 2px 8px rgba(123,127,178,0.18);
}
.btn-confirm:hover:not(:disabled) { opacity: 0.88; }
.btn-confirm:disabled { opacity: 0.5; cursor: default; }

/* 最后一行下边距 */
.section-wrap:last-child { padding-bottom: 32px; }
</style>
