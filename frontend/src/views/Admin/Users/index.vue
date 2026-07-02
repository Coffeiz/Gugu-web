<template>
  <div class="users-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">用户管理</h2>
        <p class="page-desc">注册用户列表与账号操作</p>
      </div>
    </div>

    <Transition name="flash-fade">
      <div v-if="flash" class="users-flash">{{ flash }}</div>
    </Transition>

    <div class="toolbar">
      <input
        v-model="search"
        class="search-input"
        placeholder="搜索用户名或邮箱…"
        @input="onSearch"
      />
      <button class="icon-btn" :class="{ spinning: refreshing }" @click="load(true)" title="刷新">
        <PhArrowClockwise :size="15" weight="bold" />
      </button>
      <span class="toolbar-count" v-if="!loading">{{ items.length }} 位用户</span>
    </div>

    <div class="table-wrap">
      <div v-if="loading && !items.length" class="state-empty">加载中…</div>
      <div v-else-if="!items.length" class="state-empty">暂无用户</div>

      <template v-else>
        <div class="user-table">
          <div class="ut-head">
            <span class="col-user">用户</span>
            <span class="col-email">邮箱</span>
            <span class="col-reg">注册时间</span>
            <span class="col-usage">Token 用量（本周）</span>
            <span class="col-storage">存储用量</span>
            <span class="col-status">状态</span>
            <span class="col-action"></span>
          </div>

          <div v-for="u in paginated" :key="u.id" class="ut-row">
            <span class="col-user">
              <span class="avatar-circle" :style="avatarStyle(u)">
                {{ avatarChar(u) }}
              </span>
              <span class="user-info">
                <span class="display-name">{{ u.display_name || u.username }}
                  <span class="dev-badge" v-if="u.is_developer" title="开发者（数据面板可一键排除）">DEV</span>
                </span>
                <span class="username" v-if="u.display_name">@{{ u.username }}</span>
              </span>
            </span>
            <span class="col-email">{{ u.email }}</span>
            <span class="col-reg">{{ fmtDate(u.created_at) }}</span>
            <span class="col-usage">
              <span class="usage-wrap">
                <span class="usage-num">{{ fmtTokens(u.tokens_week) }}</span>
                <template v-if="u.token_limit_weekly">
                  <span class="usage-bar-bg">
                    <span class="usage-bar-fill" :style="tokenBarStyle(u)"></span>
                  </span>
                  <span class="usage-limit">/ {{ fmtTokens(u.token_limit_weekly) }}</span>
                </template>
              </span>
            </span>
            <span class="col-storage">
              <span class="usage-wrap">
                <span class="usage-num">{{ fmtBytes(u.storage_used) }}</span>
                <template v-if="u.storage_limit_bytes">
                  <span class="usage-bar-bg">
                    <span class="usage-bar-fill" :style="storageBarStyle(u)"></span>
                  </span>
                  <span class="usage-limit">/ {{ fmtBytes(u.storage_limit_bytes) }}</span>
                </template>
              </span>
            </span>
            <span class="col-status">
              <span class="status-tag" :class="u.is_active ? 'active' : 'banned'">
                {{ u.is_active ? '正常' : '封禁' }}
              </span>
            </span>
            <span class="col-action">
              <button class="action-btn" :class="{ dev: u.is_developer }" @click="toggleDev(u)"
                :title="u.is_developer ? '取消开发者标记' : '标记为开发者（数据面板可一键排除）'">
                {{ u.is_developer ? '取消DEV' : 'DEV' }}
              </button>
              <button class="action-btn" @click="toggleBan(u)" :title="u.is_active ? '封禁' : '解封'">
                {{ u.is_active ? '封禁' : '解封' }}
              </button>
              <button class="action-btn danger" @click="confirmDelete(u)" title="删除">删除</button>
            </span>
          </div>
        </div>

        <div class="pagination" v-if="items.length > pageSize">
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
      </template>
    </div>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="confirm-mask" @click.self="deleteTarget = null">
        <div class="confirm-box">
          <p class="confirm-title">确认删除用户？</p>
          <p class="confirm-desc">
            将删除 <strong>{{ deleteTarget.display_name || deleteTarget.username }}</strong>
            的账号及所有数据，此操作不可恢复。
          </p>
          <div class="confirm-actions">
            <button class="btn-cancel" @click="deleteTarget = null">取消</button>
            <button class="btn-confirm-del" @click="doDelete" :disabled="deleting">
              {{ deleting ? '删除中…' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { PhArrowClockwise } from '@phosphor-icons/vue'

const adminStore = useAdminStore()

const items       = ref([])
const loading     = ref(false)
const refreshing  = ref(false)
const search      = ref('')
const page        = ref(1)
const pageSize    = 20
const deleteTarget = ref(null)
const flash = ref('')
const deleting    = ref(false)

const AVATAR_COLORS = [
  ['#5a6b9e', '#8490c4'],
  ['#5a8e7e', '#7cbfad'],
  ['#8e6a5a', '#c49078'],
  ['#6a5a8e', '#9878c4'],
  ['#5a7e8e', '#78b0bf'],
]

function avatarChar(u) {
  const name = u.display_name || u.username || '?'
  return name.charAt(0).toUpperCase()
}

function avatarStyle(u) {
  const idx = u.username.charCodeAt(0) % AVATAR_COLORS.length
  const [c1, c2] = AVATAR_COLORS[idx]
  return { background: `linear-gradient(135deg, ${c1}, ${c2})` }
}

async function load(manual = false) {
  if (manual) {
    refreshing.value = true
    setTimeout(() => { refreshing.value = false }, 550)
  }
  loading.value = true
  try {
    const qs = search.value ? `?q=${encodeURIComponent(search.value)}` : ''
    const res  = await adminStore.authFetch(`/api/v1/admin/users${qs}`)
    const data = await res.json()
    items.value = data.items ?? []
    page.value  = 1
  } finally {
    loading.value = false
  }
}

let searchTimer = null
function onSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => load(), 300)
}

async function toggleBan(u) {
  const res  = await adminStore.authFetch(`/api/v1/admin/users/${u.id}/ban`, { method: 'PATCH' })
  const data = await res.json()
  u.is_active = data.is_active
}

async function toggleDev(u) {
  const res  = await adminStore.authFetch(`/api/v1/admin/users/${u.id}/developer`, { method: 'PATCH' })
  const data = await res.json()
  u.is_developer = data.is_developer
}

function confirmDelete(u) {
  deleteTarget.value = u
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    const uname = deleteTarget.value.display_name || deleteTarget.value.username
    const res = await adminStore.authFetch(`/api/v1/admin/users/${deleteTarget.value.id}`, { method: 'DELETE' })
    let removed = null
    try { removed = (await res.json())?.storage_objects_removed } catch {}
    items.value = items.value.filter(u => u.id !== deleteTarget.value.id)
    deleteTarget.value = null
    // 确认隐私政策「注销后从存储中永久删除」真执行了：展示清除的存储对象数
    flash.value = removed === -1
      ? `已删除 ${uname}（存储清理失败，请查日志手动清）`
      : `已删除 ${uname}，清除 ${removed ?? 0} 个存储对象`
    setTimeout(() => { flash.value = '' }, 4000)
  } finally {
    deleting.value = false
  }
}


const totalPages = computed(() => Math.max(1, Math.ceil(items.value.length / pageSize)))
const paginated  = computed(() => {
  const start = (page.value - 1) * pageSize
  return items.value.slice(start, start + pageSize)
})

function fmtDate(iso) {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

function fmtTokens(n) {
  if (n == null || n === '') return '—'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

function fmtBytes(n) {
  if (n == null || n === 0) return '—'
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB'
  if (n >= 1048576)    return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024)       return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

function tokenBarStyle(u) {
  const pct = u.token_limit_weekly ? Math.min(100, (u.tokens_week / u.token_limit_weekly) * 100) : 0
  const color = pct >= 90 ? 'rgba(220,80,80,0.8)' : pct >= 70 ? 'rgba(220,160,60,0.8)' : 'rgba(80,160,200,0.7)'
  return { width: pct + '%', background: color }
}

function storageBarStyle(u) {
  const pct = u.storage_limit_bytes ? Math.min(100, (u.storage_used / u.storage_limit_bytes) * 100) : 0
  const color = pct >= 90 ? 'rgba(220,80,80,0.8)' : pct >= 70 ? 'rgba(220,160,60,0.8)' : 'rgba(80,200,140,0.7)'
  return { width: pct + '%', background: color }
}

onMounted(load)
</script>

<style scoped>
.users-page { min-height: 100%; }

.page-header      { padding: 32px 36px 0; }
.page-title-block { display: flex; flex-direction: column; }
.page-title       { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc        { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.users-flash {
  margin: 0 0 14px; padding: 10px 14px; border-radius: 10px;
  background: rgba(90,180,120,0.12); border: 1px solid rgba(90,180,120,0.28);
  color: #8fd6a8; font-size: 13px;
}
.flash-fade-enter-active, .flash-fade-leave-active { transition: opacity 0.3s, transform 0.3s; }
.flash-fade-enter-from, .flash-fade-leave-to { opacity: 0; transform: translateY(-4px); }

.toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 36px 0;
}
.search-input {
  height: 34px; padding: 0 12px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.75); font-size: 13px; outline: none;
  width: 220px; transition: border-color 0.15s;
}
.search-input:focus { border-color: rgba(255,255,255,0.25); }
.search-input::placeholder { color: rgba(255,255,255,0.25); }
.toolbar-count { font-size: 12px; color: rgba(255,255,255,0.3); margin-left: 4px; }

/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */

.table-wrap { margin: 14px 36px 32px; }

.state-empty {
  padding: 60px; text-align: center;
  font-size: 13px; color: rgba(255,255,255,0.2);
}

.user-table {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; overflow: hidden;
}

.ut-head {
  display: grid;
  grid-template-columns: 200px 180px 96px 1fr 1fr 62px 178px;
  padding: 10px 16px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: rgba(255,255,255,0.25);
  border-bottom: 1px solid rgba(255,255,255,0.07);
}

.ut-row {
  display: grid;
  grid-template-columns: 200px 180px 96px 1fr 1fr 62px 178px;
  padding: 10px 16px;
  align-items: center;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 13px;
  transition: background 0.12s;
}
.ut-row:last-child { border-bottom: none; }
.ut-row:hover { background: rgba(255,255,255,0.03); }

.col-user {
  display: flex; align-items: center; gap: 10px; min-width: 0;
}
.avatar-circle {
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.92);
}
.user-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.display-name {
  font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.82);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.username { font-size: 11px; color: rgba(255,255,255,0.3); }

.col-email {
  font-size: 12px; color: rgba(255,255,255,0.45);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding-right: 8px;
}
.col-reg  { font-size: 12px; color: rgba(255,255,255,0.3); }

/* 用量列 */
.usage-wrap {
  display: flex; align-items: center; gap: 5px; min-width: 0;
}
.usage-num {
  font-size: 12px; color: rgba(255,255,255,0.55);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.usage-bar-bg {
  flex: 1; min-width: 30px; max-width: 60px;
  height: 3px; border-radius: 2px;
  background: rgba(255,255,255,0.08); overflow: hidden;
}
.usage-bar-fill {
  display: block; height: 100%; border-radius: 2px;
  transition: width 0.3s ease;
}
.usage-limit {
  font-size: 11px; color: rgba(255,255,255,0.25); white-space: nowrap;
}

.status-tag {
  display: inline-block; padding: 2px 8px; border-radius: 20px;
  font-size: 11px; font-weight: 600;
}
.status-tag.active { background: rgba(80,180,140,0.12); color: rgba(100,200,160,0.9); }
.status-tag.banned { background: rgba(220,80,80,0.12); color: rgba(240,120,120,0.9); }

.col-action { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
.action-btn {
  padding: 3px 10px; border-radius: 7px; font-size: 12px; cursor: pointer;
  white-space: nowrap; flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.55);
  transition: all 0.15s;
}
.action-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.action-btn.danger { border-color: rgba(220,80,80,0.2); color: rgba(220,100,100,0.7); }
.action-btn.danger:hover { background: rgba(220,80,80,0.12); color: rgba(240,120,120,0.9); }
.action-btn.dev { border-color: rgba(123,127,178,0.35); color: rgba(170,175,225,0.9); background: rgba(123,127,178,0.12); }

.dev-badge {
  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 5px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.05em; vertical-align: 1px;
  background: rgba(123,127,178,0.18); color: rgba(170,175,225,0.95);
  border: 1px solid rgba(123,127,178,0.35);
}

.pagination {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 14px 16px; border-top: 1px solid rgba(255,255,255,0.07);
}
.pg-btn {
  width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.09); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.pg-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.pg-btn:disabled { opacity: 0.3; cursor: default; }
.pg-info { font-size: 12px; color: rgba(255,255,255,0.35); min-width: 60px; text-align: center; }

/* 弹窗公共 */
.confirm-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 9100;
}
.confirm-box {
  background: rgba(18,20,36,0.96);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 16px;
  padding: 28px 28px 24px;
  width: 360px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06);
}
.confirm-title {
  font-size: 16px; font-weight: 700; color: rgba(255,255,255,0.92);
  margin-bottom: 10px;
}
.confirm-desc {
  font-size: 13px; color: rgba(255,255,255,0.45); line-height: 1.6;
  margin-bottom: 24px;
}
.confirm-desc strong { color: rgba(255,255,255,0.75); }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
.btn-cancel {
  padding: 7px 18px; border-radius: 9px; font-size: 13px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.55); transition: all 0.15s;
}
.btn-cancel:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); }
.btn-confirm-del {
  padding: 7px 18px; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer;
  border: none; background: rgba(200,60,60,0.85); color: rgba(255,255,255,0.95);
  transition: all 0.15s;
}
.btn-confirm-del:hover:not(:disabled) { background: rgba(220,70,70,0.95); }
.btn-confirm-del:disabled { opacity: 0.5; cursor: default; }
</style>
