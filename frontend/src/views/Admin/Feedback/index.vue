<template>
  <div class="feedback-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">用户反馈</h2>
        <p class="page-desc">来自用户的 Bug 报告、功能建议和其他反馈</p>
      </div>
      <button class="icon-btn" :class="{ spinning: refreshing }" @click="load" title="刷新">
        <Icon name="action.refresh" size="sm" />
      </button>
    </div>

    <AdminSegmentTabs
      :model-value="filter"
      :tabs="categoryTabs"
      aria-label="反馈分类"
      class="feedback-tabs"
      @update:model-value="changeFilter"
    />

    <div class="feedback-list">
      <div v-if="loading && !items.length" class="empty-hint">加载中…</div>
      <div v-else-if="!items.length" class="empty-hint">暂无反馈</div>
      <div v-for="item in items" :key="item.id" class="feedback-item">
        <div class="item-meta">
          <span class="cat-badge" :class="item.category">{{ categoryLabel(item.category) }}</span>
          <span class="item-user">{{ item.username }}</span>
          <span class="item-time">{{ fmtLocalDateTime(item.createdAt) }}</span>
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

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import { fmtLocalDateTime } from '@/utils/dateAttribution'

const categoryTabs = [
  { key: '', label: '全部' },
  { key: 'bug', label: 'Bug' },
  { key: 'suggestion', label: '建议' },
  { key: 'other', label: '其他' },
]

const items    = ref<any[]>([])
const total    = ref(0)
const page     = ref(1)
const pageSize = 30
const filter   = ref('')
const loading  = ref(false)
const refreshing = ref(false)

function changeFilter(value: string) {
  filter.value = value
  page.value = 1
  load()
}

function categoryLabel(cat: string) {
  return { bug: 'Bug', suggestion: '建议', other: '其他' }[cat] ?? cat
}

function adminToken() {
  return localStorage.getItem('admin_token') ?? ''
}

async function load() {
  loading.value = true
  refreshing.value = true
  setTimeout(() => { refreshing.value = false }, 550)
  try {
    const params = new URLSearchParams({ page: String(page.value), page_size: String(pageSize) })
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

/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */

/* ── 分类过滤 ── */
.feedback-tabs { margin-bottom: 16px; }

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
</style>
