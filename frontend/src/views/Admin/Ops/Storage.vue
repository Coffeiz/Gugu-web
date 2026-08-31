<template>
  <div class="ops-page">
    <div class="ops-head">
      <div>
        <h2 class="ops-title">{{ t('adminStorageUi.title') }}</h2>
        <p class="ops-sub">{{ t('adminStorageUi.description') }}</p>
      </div>
      <button class="icon-btn" :class="{ spinning: refreshing }" @click="load(true)" :disabled="loading" :title="t('adminStorageUi.refresh')">
        <Icon name="action.refresh" size="sm" />
      </button>
    </div>

    <div v-if="err" class="ops-err">{{ err }}</div>
    <div v-else-if="loading && !liveLoaded" class="ops-empty">{{ t('adminStorageUi.loading') }}</div>

    <template v-else>
      <!-- 概览卡片：SQL 类实时查（不依赖快照），视频缓存用最新一次清理快照，
           磁盘剩余（仅 Local 后端） -->
      <div class="ops-cards">
        <div v-for="cat in CATEGORIES" :key="cat.key" class="ops-card">
          <div class="oc-label">{{ t(`adminStorageUi.${cat.labelKey}`) }}</div>
          <div class="oc-value">{{ cardMB(cat.key) }}<i>MB</i></div>
          <div class="oc-hint">{{ t('adminStorageUi.objects', { count: cardCount(cat.key) }) }}{{ cat.key === 'video_cache' ? t('adminStorageUi.afterCleanup') : '' }}</div>
        </div>
        <div v-if="disk" class="ops-card" :class="{ warn: diskUsedPct >= 85 }">
          <div class="oc-label">{{ t('adminStorageUi.localDisk') }}</div>
          <div class="oc-value">{{ fmtGB(disk.free_bytes) }}<i>GB</i></div>
          <div class="oc-hint">{{ t('adminStorageUi.used', { percent: diskUsedPct, size: fmtGB(disk.total_bytes) }) }}</div>
        </div>
      </div>

      <div class="ops-section">
        <div class="sec-title">{{ t('adminStorageUi.trend') }}</div>
        <div v-if="!hasTrend" class="ops-empty">{{ t('adminStorageUi.noHistory') }}</div>
        <div v-else class="chart-wrap">
          <AdminLineChart :labels="labels" :datasets="storageDatasets" unit="MB" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import AdminLineChart from '@/components/admin/AdminLineChart.vue'
import { buildStorageTrend, formatSnapshotDate, type StorageSnapshot } from './storageChart'

interface Totals { object_count: number; total_bytes: number }

const CATEGORIES = [
  { key: 'user_files', labelKey: 'userFiles', color: 'rgba(123,127,178,1)' },
  { key: 'chat_staging_draft', labelKey: 'draftAttachments', color: 'rgba(201,148,58,1)' },
  { key: 'chat_staging_attached', labelKey: 'sentAttachments', color: 'rgba(90,158,136,1)' },
  { key: 'video_cache', labelKey: 'videoCache', color: 'rgba(180,100,100,1)' },
] as const

interface DiskUsage { total_bytes: number; used_bytes: number; free_bytes: number }

const adminStore = useAdminStore()
const { t } = useI18n()
const byCategory = ref<Record<string, StorageSnapshot[]>>({})
const liveTotals = ref<Record<string, Totals>>({})
const disk = ref<DiskUsage | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const liveLoaded = ref(false)
const err = ref('')

// 趋势线要有历史快照才画得出来；概览卡片（除 video_cache 外）不依赖这个，
// 实时查即可，两者分开判断，别让"没有快照"挡住本来能立刻显示的实时数字。
const hasTrend = computed(() => Object.values(byCategory.value).some(list => list.length > 0))

const diskUsedPct = computed(() => disk.value ? Math.round(disk.value.used_bytes / disk.value.total_bytes * 100) : 0)
function fmtGB(bytes: number): string { return (bytes / 1024 / 1024 / 1024).toFixed(1) }

function latestSnapshotOf(key: string): StorageSnapshot | null {
  const list = byCategory.value[key]
  return list?.length ? list[list.length - 1] : null
}
// video_cache 没有实时接口（扫存储成本高，见 PRD-STORAGE-2），用最新一次
// 清理快照；其余类别是纯 SQL 汇总，直接用实时查询结果。
function cardMB(key: string): string {
  if (key === 'video_cache') {
    const s = latestSnapshotOf(key)
    return s ? (s.total_bytes / 1024 / 1024).toFixed(1) : '—'
  }
  const t = liveTotals.value[key]
  return t ? (t.total_bytes / 1024 / 1024).toFixed(1) : '—'
}
function cardCount(key: string): number | string {
  if (key === 'video_cache') {
    const s = latestSnapshotOf(key)
    return s ? s.object_count : '—'
  }
  const t = liveTotals.value[key]
  return t ? t.object_count : '—'
}

const trend = computed(() => buildStorageTrend(byCategory.value, CATEGORIES))
const labels = computed(() => trend.value.dates.map(formatSnapshotDate))

const storageDatasets = computed(() => CATEGORIES.map((cat, index) => ({
  label: t(`adminStorageUi.${cat.labelKey}`),
  values: trend.value.datasets[index].values,
  color: cat.color,
})))

async function load(manual = false) {
  if (manual) { refreshing.value = true; setTimeout(() => { refreshing.value = false }, 550) }
  loading.value = true
  try {
    const [liveRes, historyRes] = await Promise.all([
      adminStore.authFetch('/api/v1/admin/ops/storage-live-totals'),
      adminStore.authFetch('/api/v1/admin/ops/storage-snapshots?days=30'),
    ])
    if (!liveRes.ok) throw new Error(`加载失败 (${liveRes.status})`)
    if (!historyRes.ok) throw new Error(`加载失败 (${historyRes.status})`)
    const liveData = await liveRes.json()
    const historyData = await historyRes.json()
    liveTotals.value = liveData.categories || {}
    byCategory.value = historyData.categories || {}
    disk.value = historyData.disk || null
    err.value = ''
  } catch (e: any) {
    err.value = e.message
  } finally {
    loading.value = false
    liveLoaded.value = true
  }
}

onMounted(() => load())
</script>

<style scoped>
.ops-page { padding: 28px 32px; color: rgba(255,255,255,0.9); }
.ops-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
.ops-title { font-size: 18px; font-weight: 700; margin: 0; }
.ops-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; }
.ops-err { color: #e08a8a; font-size: 13px; margin-bottom: 12px; }
.ops-empty { font-size: 13px; color: rgba(255,255,255,0.3); padding: 16px 0; }

.ops-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; margin-bottom: 22px; }
.ops-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 16px 18px;
}
.ops-card.warn { border-color: rgba(210,150,60,0.4); background: rgba(210,150,60,0.08); }
.oc-label { font-size: 12px; color: rgba(255,255,255,0.45); margin-bottom: 8px; }
.oc-value { font-size: 24px; font-weight: 700; line-height: 1; }
.oc-value i { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.5); margin-left: 2px; font-style: normal; }
.oc-hint { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.ops-section { margin-bottom: 24px; }
.sec-title { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); margin-bottom: 12px; }
.chart-wrap { height: 180px; }

.icon-btn {
  width: 30px; height: 30px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.6);
  display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s;
}
.icon-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }
.icon-btn.spinning svg { animation: spin 0.6s linear; }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
