<template>
  <div class="analytics-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('adminAnalyticsUi.title') }}</h2>
        <p class="page-desc">{{ t('adminAnalyticsUi.description') }}</p>
      </div>
      <div class="header-right">
        <Checkbox class="data-header-control" :model-value="excludeDev" :aria-label="t('adminAnalyticsUi.excludeDevelopers')" @update:model-value="excludeDev = $event; load()">{{ t('adminAnalyticsUi.excludeDevelopers') }}</Checkbox>
        <AdminSegmentTabs
          :model-value="String(rangeDays)"
          :tabs="ranges"
          size="compact"
          class="data-header-control"
          :aria-label="t('adminAnalyticsUi.range')"
          @update:model-value="setRange"
        />
        <button class="icon-btn data-header-control" :class="{ spinning: refreshing }" @click="load" :disabled="loading" :title="t('adminAnalyticsUi.refresh')">
          <Icon name="action.refresh" size="sm" />
        </button>
      </div>
    </div>

    <div v-if="loading && !trends" class="state-msg">{{ t('adminAnalyticsUi.loading') }}</div>
    <div v-else-if="err" class="state-msg err">{{ err }}</div>

    <template v-else-if="trends">

      <!-- ── 趋势曲线 ── -->
      <template v-if="vis">
        <div class="section-label">{{ t('adminAnalyticsUi.trend', { days: rangeDays }) }}</div>
        <div class="charts-grid">

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <Icon name="file.folder-add" size="xs" class="ct-icon ic-teal-raw"/>
                {{ t('adminAnalyticsUi.newProjects') }}
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.recentDays', { days: rangeDays }) }}</span>
                  <span class="cs-val">{{ sumArr(vis.project_creations) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.dailyAverage') }}</span>
                  <span class="cs-val">{{ dailyAvg(vis.project_creations) }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="projNewChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <Icon name="status.check-circle" size="xs" class="ct-icon ic-teal-raw"/>
                {{ t('adminAnalyticsUi.projectDone') }}
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.completedTotal') }}</span>
                  <span class="cs-val">{{ summary?.projects?.done ?? 0 }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.recentDays', { days: rangeDays }) }}</span>
                  <span class="cs-val">{{ sumArr(vis.project_completions) }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="projDoneChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <Icon name="admin.robot" size="xs" class="ct-icon ic-blue-raw"/>
                {{ t('adminAnalyticsUi.agentCalls') }}
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.total') }}</span>
                  <span class="cs-val">{{ (summary?.agent?.total_calls ?? 0).toLocaleString() }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.dailyAverage') }}</span>
                  <span class="cs-val">{{ dailyAvg(vis.agent_calls) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.today') }}</span>
                  <span class="cs-val">{{ summary?.agent?.today_calls ?? 0 }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="agentCallsChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <Icon name="admin.pulse" size="xs" class="ct-icon ic-amber-raw"/>
                {{ t('adminAnalyticsUi.tokenUsage') }}
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.total') }}</span>
                  <span class="cs-val">{{ fmtTok((summary?.agent?.tokens_in ?? 0) + (summary?.agent?.tokens_out ?? 0)) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.dailyAverage') }}</span>
                  <span class="cs-val">{{ fmtTok(Math.round(sumArr(vis.agent_tokens) / rangeDays)) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.today') }}</span>
                  <span class="cs-val">{{ fmtTok((summary?.agent?.today_tokens_in ?? 0) + (summary?.agent?.today_tokens_out ?? 0)) }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="agentTokensChart" :options="lineOpts(true)" :plugins="chartPlugins" />
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <Icon name="user.settings" size="xs" class="ct-icon ic-teal-raw" />
                {{ t('adminAnalyticsUi.registrations') }}
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.totalVolume') }}</span>
                  <span class="cs-val">{{ (summary?.users?.total ?? 0).toLocaleString() }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.recentDays', { days: rangeDays }) }}</span>
                  <span class="cs-val">+{{ sumArr(vis.user_registrations) }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="userRegsChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

          <!-- 会话深度分布 -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <Icon name="communication.chat" size="xs" class="ct-icon ic-blue-raw" />
                {{ t('adminAnalyticsUi.sessionDepth') }}
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">{{ t('adminAnalyticsUi.metric') }}</span>
                  <span class="cs-val" style="font-weight:500;font-size:11px">{{ t('adminAnalyticsUi.depthMetric') }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Bar :data="depthChart" :options="barOpts" />
            </div>
          </div>

        </div>
      </template>

      <!-- ── 活跃维度 ── -->
      <div class="section-label">{{ t('adminAnalyticsUi.activeDimensions') }}<span class="sl-hint">{{ t('adminAnalyticsUi.activeHint') }}</span></div>
      <div class="cards-grid col5">
        <div class="card" v-for="d in dimensions" :key="d.key">
          <div class="card-icon ic-blue"><Icon :name="dimIcon(d.key)" size="md" /></div>
          <div class="card-val">{{ d.users }}<span class="card-unit"> {{ t('adminAnalyticsUi.person') }}</span></div>
          <div class="card-lbl">{{ d.label }}</div>
        </div>
      </div>

      <!-- ── 工具调用分布 ── -->
      <div class="section-label section-label-row" v-if="toolDist.length">
        <span>{{ t('adminAnalyticsUi.toolTop') }}</span>
        <button v-if="toolDist.length > 10" class="expand-btn" @click="toolExpanded = !toolExpanded">
          {{ toolExpanded ? t('adminAnalyticsUi.collapse') : t('adminAnalyticsUi.viewAll', { count: toolDist.length }) }}
          <Icon name="action.down" size="xs" :class="{ open: toolExpanded }" />
        </button>
      </div>
      <div class="tool-dist" v-if="toolDist.length">
        <div class="tool-bar-row" v-for="t in visibleTools" :key="t.tool">
          <span class="tool-name">{{ t.tool }}</span>
          <div class="tool-bar-track">
            <div class="tool-bar-fill" :style="{ width: (t.calls / toolDist[0].calls * 100) + '%' }" />
          </div>
          <span class="tool-calls">{{ t.calls.toLocaleString() }}</span>
        </div>
      </div>

      <!-- ── 模型分布 ── -->
      <template v-if="usage?.by_model?.length">
        <div class="section-label">{{ t('adminAnalyticsUi.modelDistribution') }}</div>
        <div class="model-section">
          <div class="model-donut-wrap">
            <Doughnut :data="donutChart" :options="donutOpts" />
          </div>
          <div class="model-table">
            <div class="model-head">
              <span>{{ t('adminAnalyticsUi.model') }}</span>
              <span class="col-r">{{ t('adminAnalyticsUi.calls') }}</span>
              <span class="col-r">{{ t('adminAnalyticsUi.tokens') }}</span>
            </div>
            <div v-for="(m, i) in usage.by_model" :key="m.model" class="model-row">
              <span class="m-name">
                <span class="m-dot" :style="{ background: donutColors[Number(i) % donutColors.length] }"></span>
                {{ m.model }}
                <span class="m-provider">{{ m.provider }}</span>
              </span>
              <span class="col-r">{{ m.calls.toLocaleString() }}</span>
              <span class="col-r">{{ fmtTok(m.tokens_in + m.tokens_out) }}</span>
            </div>
          </div>
        </div>
      </template>

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Line, Bar, Doughnut } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, BarElement, ArcElement, Tooltip, Filler
} from 'chart.js'
import { useAdminStore } from '@/stores/admin'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import { browserTz } from '@/utils/dateAttribution'
import {
  excludeDev, xdQuery, chartPlugins, mkDataset, lineOpts, donutOpts, donutColors,
  BLUE, AMBER, TEAL, fmtTok, sumArr, dailyAvg,
} from './_shared'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Filler)

const admin = useAdminStore()
const { t } = useI18n()
const summary = ref<any>(null)
const trends = ref<any>(null)
const usage = ref<any>(null)
const depth = ref<any>(null)
const dims = ref<any>(null)
const toolDist = ref<any[]>([])
const toolExpanded = ref(false)
const loading = ref(false)
const refreshing = ref(false)
const err = ref('')
const rangeDays = ref(30)

const ranges = [
  { key: '7',  label: t('adminAnalyticsUi.recentDays', { days: 7 }) },
  { key: '30', label: t('adminAnalyticsUi.recentDays', { days: 30 }) },
  { key: '60', label: t('adminAnalyticsUi.recentDays', { days: 60 }) },
]

const visibleTools = computed(() =>
  toolExpanded.value ? toolDist.value : toolDist.value.slice(0, 10))

const dimensions = computed(() => dims.value?.dimensions ?? [])

function dimIcon(key: string) {
  return ({ chat: 'communication.chat', project: 'admin.folders', calendar: 'navigation.calendar',
            file: 'file.document', reminder: 'admin.bell' } as Record<string, string>)[key] ?? 'communication.chat'
}

const vis = computed(() => {
  const t = trends.value
  if (!t) return null
  const n = rangeDays.value
  return {
    labels:              t.labels.slice(-n),
    agent_calls:         t.agent_calls.slice(-n),
    agent_tokens:        t.agent_tokens.slice(-n),
    user_registrations:  t.user_registrations.slice(-n),
    project_completions: t.project_completions.slice(-n),
    project_creations:   (t.project_creations ?? []).slice(-n),
  }
})

const agentCallsChart  = computed(() => ({ labels: vis.value?.labels ?? [], datasets: [mkDataset(vis.value?.agent_calls ?? [], BLUE)] }))
const agentTokensChart = computed(() => ({ labels: vis.value?.labels ?? [], datasets: [mkDataset(vis.value?.agent_tokens ?? [], AMBER)] }))
const userRegsChart    = computed(() => ({ labels: vis.value?.labels ?? [], datasets: [mkDataset(vis.value?.user_registrations ?? [], TEAL)] }))
const projDoneChart    = computed(() => ({ labels: vis.value?.labels ?? [], datasets: [mkDataset(vis.value?.project_completions ?? [], TEAL)] }))
const projNewChart     = computed(() => ({ labels: vis.value?.labels ?? [], datasets: [mkDataset(vis.value?.project_creations ?? [], TEAL)] }))

const donutChart = computed(() => {
  const models = usage.value?.by_model ?? []
  return {
    labels: models.map((m: any) => m.model),
    datasets: [{
      data: models.map((m: any) => m.calls),
      backgroundColor: donutColors,
      borderColor: 'rgba(255,255,255,0.05)',
      borderWidth: 2,
      hoverOffset: 6,
    }],
  }
})

const depthChart = computed(() => {
  const buckets = depth.value?.buckets ?? []
  return {
    labels: buckets.map((b: any) => t('adminAnalyticsUi.rounds', { value: b.label })),
    datasets: [{
      data: buckets.map((b: any) => b.users),
      backgroundColor: 'rgba(123,127,178,0.55)',
      hoverBackgroundColor: 'rgba(123,127,178,0.8)',
      borderRadius: 5,
      maxBarThickness: 44,
    }],
  }
})

const barOpts = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false as const,
  plugins: {
    legend: { display: false },
    tooltip: {
      displayColors: false,
      backgroundColor: 'rgba(10,10,22,0.92)',
      borderColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
      titleColor: 'rgba(255,255,255,0.45)',
      bodyColor: 'rgba(255,255,255,0.85)',
      padding: 10,
      callbacks: { label: (ctx: any) => `${ctx.raw} 人` },
    },
  },
  scales: {
    x: {
      grid:   { display: false },
      border: { color: 'transparent' },
      ticks:  { color: 'rgba(255,255,255,0.35)', font: { size: 11 } },
    },
    y: {
      grid:   { color: 'rgba(255,255,255,0.04)' },
      border: { color: 'transparent' },
      ticks:  { color: 'rgba(255,255,255,0.25)', font: { size: 10 }, precision: 0 },
      beginAtZero: true,
    },
  },
}

async function load() {
  loading.value = true
  refreshing.value = true
  setTimeout(() => { refreshing.value = false }, 550)
  err.value = ''
  try {
    const xd = xdQuery('&')
    const [sumRes, trdRes, useRes, dpRes, dimRes, tdRes] = await Promise.all([
      admin.authFetch(`/api/v1/admin/analytics/summary?_=1&timezone=${encodeURIComponent(browserTz())}${xd}`),
      admin.authFetch(`/api/v1/admin/analytics/trends?days=60&timezone=${encodeURIComponent(browserTz())}${xd}`),
      admin.authFetch(`/api/v1/admin/agent/usage?timezone=${encodeURIComponent(browserTz())}`),
      admin.authFetch(`/api/v1/admin/analytics/session-depth?_=1${xd}`),
      admin.authFetch(`/api/v1/admin/analytics/active-dimensions?_=1${xd}`),
      admin.authFetch(`/api/v1/admin/analytics/tool-distribution?_=1${xd}`),
    ])
    if (!trdRes.ok) throw new Error(`trends ${trdRes.status}`)
    trends.value = await trdRes.json()
    summary.value = sumRes.ok ? await sumRes.json() : null
    usage.value = useRes.ok ? await useRes.json() : null
    depth.value = dpRes.ok ? await dpRes.json() : null
    dims.value = dimRes.ok ? await dimRes.json() : null
    toolDist.value = tdRes.ok ? await tdRes.json() : []
  } catch (e: any) {
    err.value = t('adminAnalyticsUi.loadFailed', { message: e.message })
  } finally {
    loading.value = false
  }
}

function setRange(days: string) { rangeDays.value = Number(days) }

onMounted(load)
</script>

<style scoped>
.analytics-page { min-height: 100%; padding-bottom: 56px; }

.page-header {
  padding: 32px 36px 0;
  display: flex; align-items: flex-start; justify-content: space-between;
}
.page-title-block { display: flex; flex-direction: column; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.header-right { display: flex; align-items: center; gap: 10px; min-height: 32px; margin-top: 4px; }
.header-right > .data-header-control { height: 32px; box-sizing: border-box; }

.state-msg { padding: 60px 36px; text-align: center; color: rgba(255,255,255,0.3); font-size: 14px; }
.state-msg.err { color: #e07070; }

.section-label {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em;
  color: rgba(255,255,255,0.3); text-transform: uppercase;
  padding: 28px 36px 10px;
  display: flex; align-items: baseline; gap: 10px;
}
.sl-hint { font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none; color: rgba(255,255,255,0.22); }
.section-label-row { justify-content: space-between; padding-right: 36px; }
.expand-btn {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; color: rgba(149,144,196,0.8);
  background: none; border: none; cursor: pointer; padding: 2px 0;
  font-family: var(--font-sans); transition: color 0.15s;
  letter-spacing: 0;
}
.expand-btn:hover { color: rgba(149,144,196,1); }
.expand-btn svg { transform: rotate(-90deg); transition: transform 0.2s; }
.expand-btn svg.open { transform: rotate(0deg); }

.cards-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 0 36px;
}
.cards-grid.col5 { grid-template-columns: repeat(5, 1fr); }

.card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 18px 18px 14px; position: relative;
}
.card-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 12px;
}
.ic-blue { background: rgba(123,127,178,0.18); color: rgba(150,155,210,0.9); }
.card-val  { font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.card-unit { font-size: 13px; font-weight: 400; color: rgba(255,255,255,0.35); }
.card-lbl  { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 7px; }

.charts-grid {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; padding: 0 36px;
}
.chart-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 18px 18px 14px;
}
.chart-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; margin-bottom: 14px; flex-wrap: wrap;
}
.chart-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7);
}
.ct-icon { flex-shrink: 0; }
.ic-blue-raw  { color: rgba(150,155,210,0.9); }
.ic-amber-raw { color: rgba(215,165,75,0.9); }
.ic-teal-raw  { color: rgba(100,175,150,0.9); }

.chart-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cs-item { display: flex; flex-direction: column; align-items: flex-end; }
.cs-lbl  { font-size: 10px; color: rgba(255,255,255,0.28); line-height: 1; }
.cs-val  { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.78); line-height: 1.3; }
.cs-sep  { color: rgba(255,255,255,0.15); font-size: 12px; }

.chart-wrap { height: 180px; position: relative; overflow: hidden; }

.tool-dist { padding: 0 36px; display: flex; flex-direction: column; gap: 8px; }
.tool-bar-row { display: flex; align-items: center; gap: 10px; }
.tool-name {
  width: 160px; flex-shrink: 0; font-size: 12px; color: rgba(255,255,255,0.55);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tool-bar-track { flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.06); }
.tool-bar-fill  { height: 100%; border-radius: 3px; background: rgba(123,127,178,0.7); transition: width 0.3s; }
.tool-calls { width: 44px; flex-shrink: 0; text-align: right; font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.5); }

.model-section { display: flex; gap: 24px; align-items: flex-start; padding: 0 36px; }
.model-donut-wrap { width: 160px; flex-shrink: 0; }
.model-table {
  flex: 1; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; overflow: hidden;
}
.model-head {
  display: grid; grid-template-columns: 1fr 80px 90px;
  padding: 9px 14px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
  color: rgba(255,255,255,0.28); text-transform: uppercase;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.model-row {
  display: grid; grid-template-columns: 1fr 80px 90px;
  padding: 11px 14px; font-size: 13px; color: rgba(255,255,255,0.65);
  border-bottom: 1px solid rgba(255,255,255,0.04); align-items: center;
}
.model-row:last-child { border-bottom: none; }
.col-r { text-align: right; }
.m-name { display: flex; align-items: center; gap: 7px; font-size: 12px; color: rgba(255,255,255,0.75); }
.m-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.m-provider { font-size: 10px; color: rgba(255,255,255,0.25); }
</style>
