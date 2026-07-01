<template>
  <div class="analytics-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">数据总览</h2>
        <p class="page-desc">生意好不好：活跃、漏斗、留存（怎么用的看「使用分析」）</p>
      </div>
      <div class="header-right">
        <label class="xd-toggle" :class="{ on: excludeDev }">
          <input type="checkbox" v-model="excludeDev" @change="load">
          排除开发者
        </label>
        <div class="range-tabs">
          <button v-for="r in ranges" :key="r.days"
            :class="['range-tab', { active: rangeDays === r.days }]"
            @click="setRange(r.days)">{{ r.label }}</button>
        </div>
        <button class="icon-btn" :class="{ spinning: refreshing }" @click="load" :disabled="loading" title="刷新">
          <PhArrowClockwise :size="15" weight="bold" />
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="state-msg">加载中…</div>
    <div v-else-if="err" class="state-msg err">{{ err }}</div>

    <template v-else-if="data">

      <!-- ── 活跃用户曲线（北极星）── -->
      <template v-if="vis">
        <div class="section-label">活跃用户（近 {{ rangeDays }} 天）</div>
        <div class="charts-grid one">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">
                <PhPulse :size="14" weight="bold" class="ct-icon ic-blue-raw"/>
                日活跃用户
              </div>
              <div class="chart-stats">
                <span class="cs-item">
                  <span class="cs-lbl">今日</span>
                  <span class="cs-val">{{ vis.active_users[vis.active_users.length - 1] ?? 0 }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">日均</span>
                  <span class="cs-val">{{ dailyAvg(vis.active_users) }}</span>
                </span>
                <span class="cs-sep">·</span>
                <span class="cs-item">
                  <span class="cs-lbl">WAU</span>
                  <span class="cs-val">{{ data.users.wau }}</span>
                </span>
              </div>
            </div>
            <div class="chart-wrap">
              <Line :data="activeUsersChart" :options="lineOpts(false)" :plugins="chartPlugins" />
            </div>
          </div>
        </div>
      </template>

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

      <!-- ── 留存数值指标 ── -->
      <div class="section-label">项目留存<span class="sl-hint">重复创建 = 真的在用；一周后仍在推进 = 项目黏性</span></div>
      <div class="cards-grid col3">
        <div class="card">
          <div class="card-icon ic-blue"><PhFolders :size="16" weight="bold"/></div>
          <div class="card-val">{{ rm.created_project_users ?? 0 }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">创建过项目</div>
        </div>
        <div class="card">
          <div class="card-icon ic-teal"><PhFolderPlus :size="16" weight="bold"/></div>
          <div class="card-val">{{ rm.second_project_users ?? 0 }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">创建过第 2 个项目</div>
          <div class="card-sub" v-if="rm.created_project_users">
            占比 {{ pct(rm.second_project_users / rm.created_project_users) }}%
          </div>
        </div>
        <div class="card">
          <div class="card-icon ic-amber"><PhSpinnerGap :size="16" weight="bold"/></div>
          <div class="card-val">{{ rm.week_active_project_users ?? 0 }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">注册满一周仍有进行中项目</div>
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

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler
} from 'chart.js'
import {
  PhUsers, PhUserPlus, PhPulse, PhChatsCircle, PhFolders, PhFolderPlus,
  PhClock, PhSpinnerGap, PhCheckCircle, PhChats, PhMonitor, PhDeviceMobile,
  PhArrowClockwise,
} from '@phosphor-icons/vue'
import { useAdminStore } from '@/stores/admin'
import {
  excludeDev, xdQuery, chartPlugins, mkDataset, lineOpts,
  BLUE, pct, convRate, dailyAvg,
} from './_shared'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

const admin = useAdminStore()
const data = ref<any>(null)
const trends = ref<any>(null)   // 始终保存 60 天原始数据
const chatFunnel = ref<any>(null)
const loading = ref(false)
const refreshing = ref(false)
const err = ref('')
const rangeDays = ref(30)

const ranges = [
  { days: 7,  label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 60, label: '60 天' },
]

const rm = computed(() => data.value?.retention_metrics ?? {})

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

// ── 曲线（根据 rangeDays 从末尾切片）──────────────────────────────────────
const vis = computed(() => {
  const t = trends.value
  if (!t) return null
  const n = rangeDays.value
  return {
    labels:       t.labels.slice(-n),
    active_users: (t.active_users ?? []).slice(-n),
  }
})

const activeUsersChart = computed(() => ({
  labels: vis.value?.labels ?? [],
  datasets: [mkDataset(vis.value?.active_users ?? [], BLUE)],
}))

// ── 数据加载 ───────────────────────────────────────────────────────────────
async function load() {
  loading.value = true
  refreshing.value = true
  setTimeout(() => { refreshing.value = false }, 550)
  err.value = ''
  try {
    const xd = xdQuery('&')
    const [sumRes, trdRes, cfRes] = await Promise.all([
      admin.authFetch(`/api/v1/admin/analytics/summary?_=1${xd}`),
      admin.authFetch(`/api/v1/admin/analytics/trends?days=60${xd}`),
      admin.authFetch(`/api/v1/admin/analytics/chat-funnel?_=1${xd}`),
    ])
    if (!sumRes.ok) throw new Error(`summary ${sumRes.status}`)
    if (!trdRes.ok) throw new Error(`trends ${trdRes.status}`)
    data.value = await sumRes.json()
    trends.value = await trdRes.json()
    chatFunnel.value = cfRes.ok ? await cfRes.json()
      : { chat_opened: 0, chat_msg_1: 0, chat_msg_3: 0, chat_expanded: 0 }
  } catch (e: any) {
    err.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
}

function setRange(days: number) { rangeDays.value = days }

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

/* 排除开发者开关 */
.xd-toggle {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: rgba(255,255,255,0.45); cursor: pointer;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09);
  border-radius: 8px; padding: 6px 12px; transition: all .15s; user-select: none;
}
.xd-toggle input { accent-color: #7b7fb2; cursor: pointer; margin: 0; }
.xd-toggle.on { color: rgba(170,175,225,0.95); border-color: rgba(123,127,178,0.4); background: rgba(123,127,178,0.12); }

.range-tabs { display: flex; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 3px; }
.range-tab {
  font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  color: rgba(255,255,255,0.4); background: transparent; border: none; transition: all .15s;
}
.range-tab.active { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.range-tab:hover:not(.active) { color: rgba(255,255,255,0.6); }

/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */

/* ── states ── */
.state-msg { padding: 60px 36px; text-align: center; color: rgba(255,255,255,0.3); font-size: 14px; }
.state-msg.err { color: #e07070; }

/* ── section label ── */
.section-label {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em;
  color: rgba(255,255,255,0.3); text-transform: uppercase;
  padding: 28px 36px 10px;
  display: flex; align-items: baseline; gap: 10px;
}
.sl-hint { font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none; color: rgba(255,255,255,0.22); }

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
.charts-grid.one { grid-template-columns: minmax(0, 1fr); }
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

.chart-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cs-item { display: flex; flex-direction: column; align-items: flex-end; }
.cs-lbl  { font-size: 10px; color: rgba(255,255,255,0.28); line-height: 1; }
.cs-val  { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.78); line-height: 1.3; }
.cs-sep  { color: rgba(255,255,255,0.15); font-size: 12px; }

.chart-wrap { height: 180px; position: relative; overflow: hidden; }
</style>
