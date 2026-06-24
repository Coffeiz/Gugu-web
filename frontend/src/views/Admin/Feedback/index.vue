<template>
  <div class="feedback-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">用户反馈</h2>
        <p class="page-desc">来自用户的 Bug 报告、功能建议和其他反馈</p>
      </div>
      <button class="btn-refresh" :class="{ loading }" @click="load">
        <PhArrowClockwise :size="14" :class="{ 'spin-icon': loading }" />
        刷新
      </button>
    </div>

    <div class="filter-bar">
      <button
        v-for="c in categoryOptions" :key="c.value"
        class="cat-filter"
        :class="{ active: filter === c.value }"
        @click="filter = c.value; page = 1; load()"
      >
        <component :is="c.icon" :size="13" weight="bold" />
        {{ c.label }}
      </button>
    </div>

    <div class="feedback-list">
      <div v-if="loading && !items.length" class="empty-hint">加载中…</div>
      <div v-else-if="!items.length" class="empty-hint">暂无反馈</div>
      <div v-for="item in items" :key="item.id" class="feedback-item">
        <div class="item-meta">
          <span class="cat-badge" :class="item.category">{{ categoryLabel(item.category) }}</span>
          <span class="item-user">{{ item.username }}</span>
          <span class="item-time">{{ item.createdAt }}</span>
        </div>
        <div class="item-content">{{ item.content }}</div>
      </div>
    </div>

    <div v-if="total > pageSize" class="pagination">
      <button class="page-btn" :disabled="page === 1" @click="page--; load()">上一页</button>
      <span class="page-info">{{ page }} / {{ Math.ceil(total / pageSize) }}</span>
      <button class="page-btn" :disabled="page >= Math.ceil(total / pageSize)" @click="page++; load()">下一页</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { PhArrowClockwise, PhList, PhWarningOctagon, PhLightbulb, PhChatCircle } from '@phosphor-icons/vue'

const categoryOptions = [
  { value: '',           icon: PhList,            label: '全部' },
  { value: 'bug',        icon: PhWarningOctagon,  label: 'Bug' },
  { value: 'suggestion', icon: PhLightbulb,  label: '建议' },
  { value: 'other',      icon: PhChatCircle, label: '其他' },
]

const items    = ref([])
const total    = ref(0)
const page     = ref(1)
const pageSize = 30
const filter   = ref('')
const loading  = ref(false)

function categoryLabel(cat) {
  return { bug: 'Bug', suggestion: '建议', other: '其他' }[cat] ?? cat
}

function adminToken() {
  return localStorage.getItem('admin_token') ?? ''
}

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams({ page: page.value, page_size: pageSize })
    if (filter.value) params.set('category', filter.value)
    const res = await fetch(`/api/v1/admin/feedback?${params}`, {
      headers: { Authorization: `Bearer ${adminToken()}` },
    })
    const data = await res.json()
    items.value = data.items ?? []
    total.value = data.total ?? 0
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.feedback-page {
  min-height: 100%;
  padding: 32px 36px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── 页头 ── */
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 20px;
}
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.btn-refresh {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 500; padding: 7px 14px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s; white-space: nowrap;
  font-family: var(--font-sans, sans-serif);
}
.btn-refresh:hover:not(.loading) { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.2); color: rgba(255,255,255,0.75); }
.btn-refresh.loading { opacity: 0.5; cursor: default; }

/* ── 分类过滤 ── */
.filter-bar { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.cat-filter {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 14px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
  font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.38);
  cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s;
  font-family: var(--font-sans, sans-serif);
}
.cat-filter:hover { background: rgba(255,255,255,0.09); color: rgba(255,255,255,0.65); }
.cat-filter.active {
  background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.4);
  color: rgba(255,255,255,0.88); font-weight: 600;
}

/* ── 反馈列表 ── */
.feedback-list { display: flex; flex-direction: column; gap: 10px; flex: 1; }
.empty-hint {
  color: rgba(255,255,255,0.25); font-size: 13px;
  padding: 48px 0; text-align: center;
}

.feedback-item {
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 12px;
  padding: 14px 18px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.05);
  transition: border-color 0.15s;
}
.feedback-item:hover { border-color: rgba(255,255,255,0.14); }

.item-meta {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 9px;
}
.cat-badge {
  font-size: 11px; padding: 2px 9px; border-radius: 6px;
  font-weight: 600; white-space: nowrap;
}
.cat-badge.bug        { background: rgba(224,120,120,0.15); color: #e07878; border: 1px solid rgba(224,120,120,0.2); }
.cat-badge.suggestion { background: rgba(245,193,79,0.12);  color: #f5c14f; border: 1px solid rgba(245,193,79,0.2); }
.cat-badge.other      { background: rgba(123,127,178,0.15); color: rgba(149,144,196,0.9); border: 1px solid rgba(123,127,178,0.25); }

.item-user {
  font-size: 12px; font-weight: 600;
  color: rgba(255,255,255,0.65);
}
.item-time {
  font-size: 11px; color: rgba(255,255,255,0.25);
  margin-left: auto;
}
.item-content {
  font-size: 13px; color: rgba(255,255,255,0.72);
  line-height: 1.65; white-space: pre-wrap;
}

/* ── 分页 ── */
.pagination {
  display: flex; align-items: center; gap: 12px;
  justify-content: center; margin-top: 20px;
}
.page-btn {
  font-size: 12px; font-weight: 500; padding: 6px 16px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.45); cursor: pointer; transition: all 0.15s;
  font-family: var(--font-sans, sans-serif);
}
.page-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
.page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.page-info { font-size: 12px; color: rgba(255,255,255,0.3); min-width: 60px; text-align: center; }

@keyframes spin { to { transform: rotate(360deg); } }
.spin-icon {
  animation: spin 0.8s linear infinite;
  transform-box: fill-box;
  transform-origin: center;
}
</style>
