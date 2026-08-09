<template>
  <div class="ops-page">
    <div class="ops-head">
      <div>
        <h2 class="ops-title">存储监控</h2>
        <p class="ops-sub">分类别存储占用趋势——数据由定时任务每天落一条快照，不是实时统计（PRD-STORAGE-2）</p>
      </div>
      <button class="icon-btn" :class="{ spinning: refreshing }" @click="load(true)" :disabled="loading" title="刷新">
        <PhArrowClockwise :size="15" weight="bold" />
      </button>
    </div>

    <div v-if="err" class="ops-err">{{ err }}</div>
    <div v-else-if="loading && !hasData" class="ops-empty">加载中…</div>
    <div v-else-if="!hasData" class="ops-empty">还没有快照数据——等定时任务跑过至少一次之后再来看（草稿/已发送附件、用户文件库次日 1:15 落一次，视频转码缓存 1:00）。</div>

    <template v-else>
      <!-- 概览卡片：每个类别最新一条快照 + 磁盘剩余（仅 Local 后端） -->
      <div class="ops-cards">
        <div v-for="cat in CATEGORIES" :key="cat.key" class="ops-card">
          <div class="oc-label">{{ cat.label }}</div>
          <div class="oc-value">{{ latestMB(cat.key) }}<i>MB</i></div>
          <div class="oc-hint">{{ latestCount(cat.key) }} 个对象</div>
        </div>
        <div v-if="disk" class="ops-card" :class="{ warn: diskUsedPct >= 85 }">
          <div class="oc-label">磁盘剩余（Local 存储）</div>
          <div class="oc-value">{{ fmtGB(disk.free_bytes) }}<i>GB</i></div>
          <div class="oc-hint">已用 {{ diskUsedPct }}%（共 {{ fmtGB(disk.total_bytes) }}GB）</div>
        </div>
      </div>

      <div class="ops-section">
        <div class="sec-title">占用趋势（近 30 天，按类别分开画线）</div>
        <div class="chart-wrap">
          <Line :data="chartData" :options="chartOpts" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js'
import { PhArrowClockwise } from '@phosphor-icons/vue'
import { useAdminStore } from '@/stores/admin'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

interface Snapshot { taken_at: string; object_count: number; total_bytes: number }

const CATEGORIES = [
  { key: 'user_files', label: '用户文件库', color: 'rgba(123,127,178,1)' },
  { key: 'chat_staging_draft', label: '聊天附件·草稿', color: 'rgba(201,148,58,1)' },
  { key: 'chat_staging_attached', label: '聊天附件·已发送', color: 'rgba(90,158,136,1)' },
  { key: 'video_cache', label: '视频转码缓存', color: 'rgba(180,100,100,1)' },
] as const

interface DiskUsage { total_bytes: number; used_bytes: number; free_bytes: number }

const adminStore = useAdminStore()
const byCategory = ref<Record<string, Snapshot[]>>({})
const disk = ref<DiskUsage | null>(null)
const loading = ref(false)
const refreshing = ref(false)
const err = ref('')

const hasData = computed(() => Object.values(byCategory.value).some(list => list.length > 0))
const diskUsedPct = computed(() => disk.value ? Math.round(disk.value.used_bytes / disk.value.total_bytes * 100) : 0)
function fmtGB(bytes: number): string { return (bytes / 1024 / 1024 / 1024).toFixed(1) }

function latestOf(key: string): Snapshot | null {
  const list = byCategory.value[key]
  return list?.length ? list[list.length - 1] : null
}
function latestMB(key: string): string {
  const s = latestOf(key)
  return s ? (s.total_bytes / 1024 / 1024).toFixed(1) : '—'
}
function latestCount(key: string): number | string {
  const s = latestOf(key)
  return s ? s.object_count : '—'
}

// 以所有类别里点数最多的一条时间轴为准对齐 labels（各类别定时任务时间点不完全
// 相同，理论上天级粒度下同一天只会有一条，直接用最长的那组日期做横轴够用）
const labels = computed(() => {
  let longest: Snapshot[] = []
  for (const list of Object.values(byCategory.value)) {
    if (list.length > longest.length) longest = list
  }
  return longest.map(s => new Date(s.taken_at).toLocaleDateString('zh', { month: 'numeric', day: 'numeric' }))
})

const chartData = computed(() => ({
  labels: labels.value,
  datasets: CATEGORIES.map(cat => ({
    label: cat.label,
    data: (byCategory.value[cat.key] || []).map(s => +(s.total_bytes / 1024 / 1024).toFixed(1)),
    borderColor: cat.color,
    backgroundColor: cat.color.replace(',1)', ',0.1)'),
    fill: false,
    tension: 0.35,
    pointRadius: 2,
  })),
}))

const chartOpts = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false as const,
  interaction: { mode: 'index' as const, intersect: false },
  plugins: {
    legend: { display: true, position: 'bottom' as const, labels: { color: 'rgba(255,255,255,0.6)', boxWidth: 10, font: { size: 11 } } },
    tooltip: { mode: 'index' as const, intersect: false },
  },
  scales: {
    x: { grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.4)' } },
    y: { beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.4)', callback: (v: any) => `${v}MB` } },
  },
}

async function load(manual = false) {
  if (manual) { refreshing.value = true; setTimeout(() => { refreshing.value = false }, 550) }
  loading.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/ops/storage-snapshots?days=30')
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    const data = await res.json()
    byCategory.value = data.categories || {}
    disk.value = data.disk || null
    err.value = ''
  } catch (e: any) {
    err.value = e.message
  } finally {
    loading.value = false
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
.chart-wrap { height: 320px; }

.icon-btn {
  width: 30px; height: 30px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.6);
  display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s;
}
.icon-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }
.icon-btn.spinning svg { animation: spin 0.6s linear; }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
