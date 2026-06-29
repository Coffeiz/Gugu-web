<template>
  <div class="analytics-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">数据分析</h2>
        <p class="page-desc">用户旅程、活跃度、Agent 用量</p>
      </div>
      <div class="header-right">
        <div class="range-tabs">
          <button v-for="r in ranges" :key="r.days"
            :class="['range-tab', { active: rangeDays === r.days }]"
            @click="setRange(r.days)">{{ r.label }}</button>
        </div>
        <button class="refresh-btn" @click="load" :disabled="loading">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            :class="{ spinning: loading }">
            <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2"/>
            <polyline points="10 1 14 5 10 5"/>
          </svg>
          刷新
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="state-msg">加载中…</div>
    <div v-else-if="err" class="state-msg err">{{ err }}</div>

    <template v-else-if="data">

      <!-- ── 漏斗 ── -->
      <div class="section-label">用户旅程漏斗</div>
      <div class="funnel-strip">
        <template v-for="(step, i) in funnelSteps" :key="step.key">
          <div class="funnel-box">
            <div class="f-num">{{ step.value.toLocaleString() }}</div>
            <div class="f-lbl">{{ step.label }}</div>
            <div class="f-rate">{{ i > 0 ? convRate(funnelSteps[i-1].value, step.value) : '' }}</div>
          </div>
          <div class="funnel-arr" v-if="i < funnelSteps.length - 1">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8h10M9 4l4 4-4 4"/>
            </svg>
          </div>
        </template>
        <!-- 留存率：接在完成项目后 -->
        <div class="funnel-arr">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 8h10M9 4l4 4-4 4"/>
          </svg>
        </div>
        <div class="funnel-box">
          <div class="f-num">{{ pct(data.funnel.retention_7d ?? 0) }}<span style="font-size:16px;font-weight:500">%</span></div>
          <div class="f-lbl">7 日留存</div>
          <div class="f-rate">{{ data.funnel.retained_7d ?? 0 }} / {{ data.funnel.cohort_7d ?? 0 }} 人</div>
        </div>
        <div class="funnel-arr">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 8h10M9 4l4 4-4 4"/>
          </svg>
        </div>
        <div class="funnel-box">
          <div class="f-num">{{ pct(data.funnel.retention_30d ?? 0) }}<span style="font-size:16px;font-weight:500">%</span></div>
          <div class="f-lbl">30 日留存</div>
          <div class="f-rate">{{ data.funnel.retained_30d ?? 0 }} / {{ data.funnel.cohort_30d ?? 0 }} 人</div>
        </div>
      </div>

      <!-- ── 咕咕行为漏斗 ── -->
      <div class="section-label">咕咕行为漏斗</div>
      <div class="funnel-strip">
        <template v-for="(step, i) in chatFunnelSteps" :key="step.key">
          <div class="funnel-box">
            <div class="f-num">{{ step.value.toLocaleString() }}</div>
            <div class="f-lbl">{{ step.label }}</div>
            <div class="f-rate">{{ i > 0 ? convRate(chatFunnelSteps[i-1].value, step.value) : '' }}</div>
          </div>
          <div class="funnel-arr" v-if="i < chatFunnelSteps.length - 1">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8h10M9 4l4 4-4 4"/>
            </svg>
          </div>
        </template>
        <div class="funnel-extra">
          大窗展开 <strong>{{ chatFunnel?.chat_expanded ?? 0 }}</strong> 人
        </div>
      </div>

      <!-- ── 对话 ── -->
      <div class="section-label">对话</div>
      <div class="cards-grid col3">
        <div class="card">
          <div class="card-icon ic-blue"><PhChats :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.sessions.total.toLocaleString() }}</div>
          <div class="card-lbl">总量</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhMonitor :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.sessions.web.toLocaleString() }}</div>
          <div class="card-lbl">网页对话</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhDeviceMobile :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.sessions.im.toLocaleString() }}</div>
          <div class="card-lbl">IM 对话</div>
        </div>
      </div>

      <!-- ── 概览卡片 ── -->
      <div class="section-label">用户 · 项目</div>
      <div class="cards-grid">
        <div class="card">
          <div class="card-icon ic-blue"><PhUsers :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.users.total.toLocaleString() }}</div>
          <div class="card-lbl">注册用户</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhUserPlus :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.users.new_30d }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">新增（30 天）</div>
          <div class="card-sub">7 天内 +{{ data.users.new_7d }} 人</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhPulse :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.users.wau }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">周活跃（WAU）</div>
          <div class="card-sub">30 天活跃 {{ data.users.active_30d }} 人</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhChatsCircle :size="16" weight="bold"/></div>
          <div class="card-val">{{ pct(data.im_bots.adoption_rate) }}<span class="card-unit">%</span></div>
          <div class="card-lbl">IM 接入率</div>
          <div class="card-sub">{{ data.im_bots.users_with_bot }} 人已接入</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhFolders :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.projects.total.toLocaleString() }}</div>
          <div class="card-lbl">项目总量</div>
        </div>
        <div class="card">
          <div class="card-icon ic-muted"><PhClock :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.projects.pending }}</div>
          <div class="card-lbl">待开始</div>
        </div>
        <div class="card card-active">
          <div class="card-icon ic-amber"><PhSpinnerGap :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.projects.active }}</div>
          <div class="card-lbl">进行中</div>
        </div>
        <div class="card card-done">
          <div class="card-icon ic-teal"><PhCheckCircle :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.projects.done }}</div>
          <div class="card-lbl">已完成</div>
          <div class="card-sub" v-if="data.projects.total">
            完成率 {{ pct(data.projects.done / data.projects.total) }}%
          </div>
        </div>
      </div>

      <!-- ── 折线图 ── -->
      <template v-if="vis">
        <div class="section-label">趋势（近 {{ rangeDays }} 天）</div>
        <div class="charts-grid">

          <!-- Agent 调用 -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <PhRobot :size="14" weight="bold" class="ct-icon ic-blue-raw"/>
                Agent 调用
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">总计</span>
                  <span class="cs-val">{{ data.agent.total_calls.toLocaleString() }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">日均</span>
                  <span class="cs-val">{{ dailyAvg(vis?.agent_calls) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">今日</span>
                  <span class="cs-val">{{ data.agent.today_calls }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="agentCallsChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

          <!-- Token 消耗 -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <PhLightning :size="14" weight="bold" class="ct-icon ic-amber-raw"/>
                Token 消耗
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">总计</span>
                  <span class="cs-val">{{ fmtTok(data.agent.tokens_in + data.agent.tokens_out) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">日均</span>
                  <span class="cs-val">{{ fmtTok(Math.round(sumArr(vis?.agent_tokens) / rangeDays)) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">今日</span>
                  <span class="cs-val">{{ fmtTok(data.agent.today_tokens_in + data.agent.today_tokens_out) }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="agentTokensChart" :options="lineOpts(true)" :plugins="chartPlugins" />
            </div>
          </div>

          <!-- 用户注册 -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <PhUserPlus :size="14" weight="bold" class="ct-icon ic-teal-raw"/>
                用户注册
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">总量</span>
                  <span class="cs-val">{{ data.users.total.toLocaleString() }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">近{{ rangeDays }}天</span>
                  <span class="cs-val">+{{ sumArr(vis?.user_registrations) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">日均</span>
                  <span class="cs-val">{{ dailyAvg(vis?.user_registrations) }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="userRegsChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

          <!-- 项目完成 -->
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <PhCheckCircle :size="14" weight="bold" class="ct-icon ic-teal-raw"/>
                项目完成
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">累计完成</span>
                  <span class="cs-val">{{ data.projects.done }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">近{{ rangeDays }}天</span>
                  <span class="cs-val">{{ sumArr(vis?.project_completions) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">完成率</span>
                  <span class="cs-val">{{ data.projects.total ? pct(data.projects.done / data.projects.total) + '%' : '—' }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="projDoneChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>

        </div>
      </template>

      <!-- ── 工具调用分布 ── -->
      <div class="section-label section-label-row" v-if="toolDist.length">
        <span>工具调用 Top 10</span>
        <button v-if="toolDist.length > 10" class="expand-btn" @click="toolExpanded = !toolExpanded">
          {{ toolExpanded ? '收起' : `查看全部 ${toolDist.length} 个` }}
          <PhCaretDown :size="11" weight="bold" :class="{ 'caret-up': toolExpanded }" />
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
        <div class="section-label">模型分布</div>
        <div class="model-section">
          <div class="model-donut-wrap">
            <Doughnut :data="donutChart" :options="donutOpts" />
          </div>
          <div class="model-table">
            <div class="model-head">
              <span>模型</span>
              <span class="col-r">调用</span>
              <span class="col-r">Token</span>
            </div>
            <div v-for="(m, i) in usage.by_model" :key="m.model" class="model-row">
              <span class="m-name">
                <span class="m-dot" :style="{ background: donutColors[i % donutColors.length] }"></span>
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

<script setup>
import { ref, computed, onMounted } from 'vue'
import { Line, Doughnut } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, ArcElement, Tooltip, Filler
} from 'chart.js'
import {
  PhUsers, PhUserPlus, PhPulse, PhChatsCircle, PhFolders,
  PhClock, PhSpinnerGap, PhCheckCircle, PhRobot, PhLightning,
  PhChats, PhMonitor, PhDeviceMobile, PhCaretDown
} from '@phosphor-icons/vue'
import { useAdminStore } from '@/stores/admin'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ArcElement, Tooltip, Filler)

const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    if (!chart.tooltip?._active?.length) return
    const { ctx, scales: { y } } = chart
    const x = chart.tooltip._active[0].element.x
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, y.top)
    ctx.lineTo(x, y.bottom)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.setLineDash([])
    ctx.stroke()
    ctx.restore()
  }
}

const chartPlugins = [crosshairPlugin]

const admin   = useAdminStore()
const data      = ref(null)
const usage     = ref(null)
const trends    = ref(null)   // 始终保存 60 天原始数据
const loading    = ref(false)
const err        = ref('')
const rangeDays    = ref(30)
const chatFunnel = ref(null)
const toolDist    = ref([])
const toolExpanded = ref(false)

const visibleTools = computed(() =>
  toolExpanded.value ? toolDist.value : toolDist.value.slice(0, 10)
)

const ranges = [
  { days: 7,  label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 60, label: '60 天' },
]

// ── 漏斗 ──────────────────────────────────────────────────────────────────
const funnelSteps = computed(() => {
  if (!data.value) return []
  const f = data.value.funnel
  return [
    { key: 'registered',        label: '注册',       value: f.registered },
    { key: 'created_project',   label: '创建项目',   value: f.created_project },
    { key: 'completed_project', label: '完成项目',   value: f.completed_project },
  ]
})

const chatFunnelSteps = computed(() => {
  const f = chatFunnel.value ?? {}
  return [
    { key: 'opened', label: '打开咕咕', value: f.chat_opened ?? 0 },
    { key: 'msg1',   label: '发消息',   value: f.chat_msg_1  ?? 0 },
    { key: 'msg3',   label: '≥ 3 轮',   value: f.chat_msg_3  ?? 0 },
  ]
})

// ── 工具函数 ──────────────────────────────────────────────────────────────
function convRate(prev, curr) {
  if (!prev) return '—'
  return (curr / prev * 100).toFixed(1) + '%'
}
function pct(rate) {
  return (rate * 100).toFixed(1)
}
function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}
function sumArr(arr) { return arr?.reduce((a, b) => a + b, 0) ?? 0 }
function dailyAvg(arr) {
  if (!arr?.length) return '0'
  return (sumArr(arr) / arr.length).toFixed(1)
}

// ── Chart.js 配置 ─────────────────────────────────────────────────────────
const BLUE   = 'rgba(123,127,178,1)'
const AMBER  = 'rgba(201,148,58,1)'
const TEAL   = 'rgba(90,158,136,1)'

function mkDataset(data, color) {
  return {
    data,
    borderColor: color,
    backgroundColor(ctx) {
      const chart = ctx.chart
      const { chartArea, ctx: c } = chart
      if (!chartArea) return color.replace(',1)', ',0.15)')
      const grad = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
      grad.addColorStop(0, color.replace(',1)', ',0.28)'))
      grad.addColorStop(0.6, color.replace(',1)', ',0.08)'))
      grad.addColorStop(1, color.replace(',1)', ',0.0)'))
      return grad
    },
    fill: true,
    tension: 0.45,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointBackgroundColor: color,
    pointBorderColor: 'rgba(14,14,28,0.85)',
    pointBorderWidth: 1.5,
    borderWidth: 1.5,
  }
}

function lineOpts(isTok) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: 'index',
        intersect: false,
        displayColors: false,
        backgroundColor: 'rgba(10,10,22,0.92)',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        titleColor: 'rgba(255,255,255,0.45)',
        bodyColor: 'rgba(255,255,255,0.85)',
        padding: 10,
        callbacks: isTok ? { label: ctx => fmtTok(ctx.raw) } : { label: ctx => String(ctx.raw) },
      },
    },
    scales: {
      x: {
        grid:   { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'transparent' },
        ticks:  { color: 'rgba(255,255,255,0.25)', font: { size: 10 }, maxTicksLimit: 8 },
      },
      y: {
        grid:   { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'transparent' },
        ticks:  {
          color: 'rgba(255,255,255,0.25)', font: { size: 10 },
          callback: isTok ? v => fmtTok(v) : undefined,
        },
        beginAtZero: true,
      },
    },
  }
}

// 根据 rangeDays 从末尾切片，Chart.js 就地更新 → 平滑过渡
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
  }
})

const agentCallsChart = computed(() => ({
  labels: vis.value?.labels ?? [],
  datasets: [mkDataset(vis.value?.agent_calls ?? [], BLUE)],
}))

const agentTokensChart = computed(() => ({
  labels: vis.value?.labels ?? [],
  datasets: [mkDataset(vis.value?.agent_tokens ?? [], AMBER)],
}))

const userRegsChart = computed(() => ({
  labels: vis.value?.labels ?? [],
  datasets: [mkDataset(vis.value?.user_registrations ?? [], TEAL)],
}))

const projDoneChart = computed(() => ({
  labels: vis.value?.labels ?? [],
  datasets: [mkDataset(vis.value?.project_completions ?? [], TEAL)],
}))

const donutColors = [
  'rgba(123,127,178,0.85)',
  'rgba(90,158,136,0.85)',
  'rgba(201,148,58,0.85)',
  'rgba(180,100,100,0.85)',
  'rgba(100,160,210,0.85)',
  'rgba(160,130,200,0.85)',
]

const donutChart = computed(() => {
  const models = usage.value?.by_model ?? []
  return {
    labels: models.map(m => m.model),
    datasets: [{
      data: models.map(m => m.calls),
      backgroundColor: donutColors,
      borderColor: 'rgba(255,255,255,0.05)',
      borderWidth: 2,
      hoverOffset: 6,
    }],
  }
})

const donutOpts = {
  responsive: true,
  maintainAspectRatio: true,
  cutout: '68%',
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: 'rgba(15,15,30,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      titleColor: 'rgba(255,255,255,0.6)',
      bodyColor: 'rgba(255,255,255,0.85)',
      padding: 10,
    },
  },
}

// ── 数据加载 ───────────────────────────────────────────────────────────────
async function load() {
  loading.value = true
  err.value = ''
  try {
    const [sumRes, useRes, trdRes, cfRes, tdRes] = await Promise.all([
      admin.authFetch('/api/v1/admin/analytics/summary'),
      admin.authFetch('/api/v1/admin/agent/usage'),
      admin.authFetch('/api/v1/admin/analytics/trends?days=60'),
      admin.authFetch('/api/v1/admin/analytics/chat-funnel'),
      admin.authFetch('/api/v1/admin/analytics/tool-distribution'),
    ])
    if (!sumRes.ok) throw new Error(`summary ${sumRes.status}`)
    if (!useRes.ok) throw new Error(`usage ${useRes.status}`)
    if (!trdRes.ok) throw new Error(`trends ${trdRes.status}`)
    data.value      = await sumRes.json()
    usage.value     = await useRes.json()
    trends.value    = await trdRes.json()
    chatFunnel.value = cfRes.ok ? await cfRes.json() : { chat_opened: 0, chat_msg_1: 0, chat_msg_3: 0, chat_expanded: 0 }
    toolDist.value   = tdRes.ok ? await tdRes.json() : []
  } catch (e) {
    err.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
}

function setRange(days) {
  rangeDays.value = days
}

onMounted(load)
</script>

<style scoped>
.analytics-page { min-height: 100%; padding-bottom: 56px; }

/* ── header ── */
.page-header {
  padding: 32px 36px 0;
  display: flex; align-items: flex-start; justify-content: space-between;
}
.page-title-block { display: flex; flex-direction: column; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.header-right { display: flex; align-items: center; gap: 10px; margin-top: 4px; }

.range-tabs { display: flex; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 3px; }
.range-tab {
  font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  color: rgba(255,255,255,0.4); background: transparent; border: none; transition: all .15s;
}
.range-tab.active { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.range-tab:hover:not(.active) { color: rgba(255,255,255,0.6); }

.refresh-btn {
  display: flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.55); font-size: 12px; border-radius: 8px;
  padding: 7px 14px; cursor: pointer; transition: all .15s;
}
.refresh-btn:hover  { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); }
.refresh-btn:disabled { opacity: .4; cursor: not-allowed; }
@keyframes spin { to { transform: rotate(360deg); } }
.spinning { animation: spin .8s linear infinite; }

/* ── states ── */
.state-msg { padding: 60px 36px; text-align: center; color: rgba(255,255,255,0.3); font-size: 14px; }
.state-msg.err { color: #e07070; }

/* ── section label ── */
.section-label {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em;
  color: rgba(255,255,255,0.3); text-transform: uppercase;
  padding: 28px 36px 10px;
}

/* ── funnel ── */
.funnel-strip {
  display: flex; align-items: center; padding: 0 36px; overflow-x: auto; gap: 0;
}
.funnel-box {
  flex: 1; min-width: 110px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 16px 12px 12px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.f-num  { font-size: 26px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.f-lbl  { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 5px; }
.f-rate {
  font-size: 10px; font-weight: 600; margin-top: 6px;
  color: rgba(150,155,210,0.8);
  min-height: 1.2em;
}
.funnel-arr { flex-shrink: 0; color: rgba(255,255,255,0.18); padding: 0 6px; }
.funnel-extra {
  flex-shrink: 0; margin-left: 20px; padding: 0 16px;
  font-size: 12px; color: rgba(255,255,255,0.35); white-space: nowrap;
}
.funnel-extra strong { color: rgba(255,255,255,0.7); font-weight: 600; }

/* ── section label row variant ── */
.section-label-row {
  display: flex; align-items: center; justify-content: space-between;
  padding-right: 36px;
}
.expand-btn {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; color: rgba(149,144,196,0.8);
  background: none; border: none; cursor: pointer; padding: 2px 0;
  font-family: var(--font-sans); transition: color 0.15s;
  letter-spacing: 0;
}
.expand-btn:hover { color: rgba(149,144,196,1); }
.expand-btn .caret-up { transform: rotate(180deg); }
.expand-btn svg { transition: transform 0.2s; }

/* ── tool distribution ── */
.tool-dist { padding: 0 36px; display: flex; flex-direction: column; gap: 8px; }
.tool-bar-row { display: flex; align-items: center; gap: 10px; }
.tool-name {
  width: 160px; flex-shrink: 0; font-size: 12px; color: rgba(255,255,255,0.55);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tool-bar-track {
  flex: 1; height: 6px; border-radius: 3px;
  background: rgba(255,255,255,0.06);
}
.tool-bar-fill {
  height: 100%; border-radius: 3px;
  background: rgba(123,127,178,0.7);
  transition: width 0.3s;
}
.tool-calls {
  width: 44px; flex-shrink: 0; text-align: right;
  font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.5);
}

/* ── cards ── */
.cards-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 0 36px;
}
.cards-grid.col3 { grid-template-columns: repeat(3, 1fr); }

.card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 18px 18px 14px; position: relative;
}
.card-icon {
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 12px;
}
.ic-blue  { background: rgba(123,127,178,0.18); color: rgba(150,155,210,0.9); }
.ic-muted { background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.4); }
.ic-amber { background: rgba(201,148,58,0.18);  color: rgba(215,165,75,0.9); }
.ic-teal  { background: rgba(90,158,136,0.18);  color: rgba(100,175,150,0.9); }

.card-val  { font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.card-unit { font-size: 13px; font-weight: 400; color: rgba(255,255,255,0.35); }
.card-lbl  { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 7px; }
.card-sub  { font-size: 11px; color: rgba(255,255,255,0.22); margin-top: 3px; }

.card-active { border-color: rgba(201,148,58,0.25); }
.card-active .card-val { color: #c9943a; }
.card-done   { border-color: rgba(90,158,136,0.25); }
.card-done .card-val   { color: #5a9e88; }

/* ── charts ── */
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

/* ── model section ── */
.model-section {
  display: flex; gap: 24px; align-items: flex-start; padding: 0 36px;
}
.model-donut-wrap {
  width: 160px; flex-shrink: 0;
}
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
.m-name {
  display: flex; align-items: center; gap: 7px;
  font-size: 12px; color: rgba(255,255,255,0.75);
}
.m-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.m-provider { font-size: 10px; color: rgba(255,255,255,0.25); }
</style>
