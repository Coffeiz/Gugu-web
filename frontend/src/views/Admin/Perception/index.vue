<template>
  <div class="perc-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">{{ t('perception.title') }}</h2>
        <p class="page-desc">{{ t('perception.description') }}</p>
      </div>
      <div class="header-right">
        <Checkbox class="data-header-control" :model-value="excludeDev" :aria-label="t('perception.excludeDevelopers')" @update:model-value="excludeDev = $event; load()">{{ t('perception.excludeDevelopers') }}</Checkbox>
        <AdminSegmentTabs
          :model-value="String(hours)"
          :tabs="ranges"
          size="compact"
          class="data-header-control"
          :aria-label="t('perception.range')"
          @update:model-value="setRange"
        />
        <button class="dl-btn data-header-control" @click="exportData" :disabled="exporting">{{ exporting ? t('perception.exporting') : t('perception.export') }}</button>
        <button class="icon-btn data-header-control" :class="{ spinning: refreshing }" @click="load" :disabled="loading" :title="t('perception.refresh')" :aria-label="t('perception.refresh')">
          <Icon name="action.refresh" size="sm" />
        </button>
      </div>
    </div>

    <!-- 阈值条：只改「怎么看」这屏数据（口径 + 标红线），不动系统行为 -->
    <div class="ctrl-bar">
      <span class="ctrl-grp">
        <label>{{ t('perception.activeThreshold') }}</label>
        <input type="number" min="1" step="1" v-model.number="minEvents" @change="load">
        <span class="ctrl-u">{{ t('perception.rounds') }}</span>
      </span>
      <span class="ctrl-grp">
        <label>{{ t('perception.misreadThreshold') }}</label>
        <input type="number" min="0" max="100" step="5" v-model.number="rateHiPct" @change="load">
        <span class="ctrl-u">%</span>
      </span>
      <span class="ctrl-grp">
        <label>{{ t('perception.ambiguityThreshold') }}</label>
        <input type="number" min="0" max="100" step="5" v-model.number="ambigHi" @change="load">
      </span>
      <span class="ctrl-grp">
        <label>{{ t('perception.minSample') }}</label>
        <input type="number" min="1" step="1" v-model.number="minN" @change="load">
      </span>
      <button v-if="!isDefault" class="ctrl-reset" @click="resetThresholds">{{ t('perception.reset') }}</button>
      <span class="ctrl-note">{{ t('perception.thresholdHint') }}</span>
    </div>

    <div v-if="loading && !loaded" class="state-msg">{{ t('perception.loading') }}</div>
    <div v-else-if="err" class="state-msg err">{{ err }}</div>
    <div v-else-if="!data.active_users" class="state-msg">{{ data.note || t('perception.noActiveUsers') }}</div>

    <template v-else>
      <!-- 异常标红 -->
      <div v-if="data.flag_items?.length || data.flags?.length" class="flag-strip">
        <div v-for="(f, i) in localizedFlags" :key="i" class="flag-item"><span class="flag-dot">!</span>{{ f }}</div>
      </div>

      <section class="data-section">
        <div class="section-head"><h3>{{ t('perception.overview') }}</h3></div>
        <div class="cards-grid">
        <div class="card">
          <div class="card-icon ic-blue"><Icon name="communication.team" size="md" /></div>
          <div class="card-val">{{ data.active_users }}</div>
          <div class="card-lbl">{{ t('perception.activeUsers', { count: data.min_events }) }}</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><Icon name="communication.chat" size="md" /></div>
          <div class="card-val">{{ data.perc_total }}</div>
          <div class="card-lbl">{{ t('perception.observations', { count: data.misperc_total }) }}</div>
        </div>
        <div class="card" :class="rateCard(data.perception_misperc_rate)">
          <div class="card-icon ic-amber"><Icon name="admin.pulse" size="md" /></div>
          <div class="card-val">{{ pct(data.perception_misperc_rate) }}</div>
          <div class="card-lbl">{{ t('perception.misreadRate') }}</div>
        </div>
        <div class="card" :class="{ 'card-active': (data.avg_ambiguity ?? 0) > ambigHi }">
          <div class="card-icon ic-amber"><Icon name="admin.brain" size="md" /></div>
          <div class="card-val">{{ data.avg_ambiguity ?? '—' }}</div>
          <div class="card-lbl">{{ t('perception.ambiguity', { value: data.avg_emo_strength ?? '—' }) }}</div>
        </div>
        </div>
      </section>

      <template v-if="data.misperc_by_kind && data.misperc_by_kind.length">
        <section class="data-section">
          <div class="section-head"><h3>{{ t('perception.correction') }}</h3><p>{{ t('perception.correctionHint') }}</p></div>
          <div class="chart-frame compact-chart">
            <AdminBarChart :labels="kindChart.labels" :values="kindChart.values" :unit="t('perception.countUnit')" :max="kindChart.max" />
          </div>
        </section>
      </template>

      <section class="data-section">
        <div class="section-head"><h3>{{ t('perception.intent') }}</h3><p>{{ t('perception.intentHint') }}</p></div>
        <div v-if="!intents.length" class="state-msg sm-sm">{{ t('perception.noData') }}</div>
        <IntentDistribution v-else :items="intents" :rate-high="rateHiPct / 100" />
      </section>

      <template v-if="data.by_model && data.by_model.length">
        <section class="data-section">
          <div class="section-head"><h3>{{ t('perception.byModel') }}</h3></div>
          <div class="chart-frame">
            <AdminBarChart :labels="modelChart.labels" :values="modelChart.values" :unit="t('perception.countUnit')" :max="modelChart.max" :height="modelChart.height" />
          </div>
        </section>
      </template>

      <template v-if="data.emotion_distribution && data.emotion_distribution.length">
        <section class="data-section">
          <div class="section-head"><h3>{{ t('perception.emotion') }}</h3></div>
          <div class="chart-frame compact-chart">
            <AdminBarChart :labels="emotionChart.labels" :values="emotionChart.values" :unit="t('perception.countUnit')" :max="emotionChart.max" />
          </div>
        </section>
      </template>

      <section class="data-section">
        <div class="section-head"><h3>{{ t('perception.feedback') }}</h3><p>{{ t('perception.feedbackHint') }}</p></div>
        <div v-if="!data.feedback_distribution?.length" class="state-msg sm-sm">{{ t('perception.noFeedback') }}</div>
        <div v-else class="chart-frame compact-chart">
          <AdminBarChart :labels="feedbackChart.labels" :values="feedbackChart.values" :unit="t('perception.countUnit')" :max="feedbackChart.max" />
        </div>
      </section>
    </template>

    <!-- 错读案例预览（独立于活跃用户统计，始终显示） -->
    <section class="data-section">
      <div class="section-head"><div><h3>{{ t('perception.misreadCases') }}</h3><p>{{ t('perception.misreadHint', { count: misread.length }) }}</p></div>
        <button class="dl-btn" @click="downloadMisread" :disabled="dling">{{ dling ? t('perception.downloading') : t('perception.download') }}</button>
      </div>
      <div v-if="!misread.length" class="state-msg sm-sm">{{ t('perception.noMisread') }}（{{ t('perception.sampleRound') }}）</div>
      <div v-else class="mr-list">
        <div v-for="(c, i) in misread" :key="i" class="mr-row">
          <span class="mr-time">{{ fmtTs(c.ts) }}</span>
          <span class="mr-flow"><b>{{ c.miss?.read_as || '—' }}</b><i>→</i><b>{{ c.miss?.actual || '—' }}</b></span>
          <span class="mr-pattern">{{ c.miss?.pattern || '—' }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import Checkbox from '@/components/common/controls/Checkbox.vue'
import AdminSegmentTabs from '@/components/admin/AdminSegmentTabs.vue'
import AdminBarChart from '@/components/admin/AdminBarChart.vue'
import IntentDistribution from './components/IntentDistribution.vue'
const { t } = useI18n()

interface PerceptionData {
  active_users?: number
  note?: string
  flags?: string[]
  flag_items?: Array<{ kind: 'intent' | 'ambiguity' | 'emotion_zero' | 'model'; intent?: string; rate?: number; count?: number; value?: number; model?: string; overall_rate?: number }>
  min_events?: number
  perc_total?: number
  misperc_total?: number
  perception_misperc_rate?: number
  avg_ambiguity?: number
  avg_emo_strength?: number
  misperc_by_kind?: { kind: string; count: number }[]
  overall_misperc_rate?: number
  intent_distribution?: { intent: string; pct: number; misperc_rate: number; count: number }[]
  by_model?: { model: string; count: number; misperc_rate: number }[]
  emotion_distribution?: { emotion: string; count: number }[]
  feedback_distribution?: { feedback: string; count: number }[]
  feedback_total?: number
}

const adminStore = useAdminStore()
const data = ref<PerceptionData>({})
const hours = ref(168)
const loading = ref(false)
const refreshing = ref(false)
const loaded = ref(false)
const err = ref('')
const ranges = [
  { key: '24', label: '24h' },
  { key: '168', label: '7天' },
  { key: '720', label: '30天' },
  { key: '0', label: '全部' },
]

// 可调阈值（默认即后端原常量）：活跃门槛 / 标红误判率(%) / 歧义偏高线 / 最小样本
const DEFAULTS = { minEvents: 1, rateHiPct: 25, ambigHi: 60, minN: 10 }
const minEvents = ref(DEFAULTS.minEvents)
const rateHiPct = ref(DEFAULTS.rateHiPct)
const ambigHi = ref(DEFAULTS.ambigHi)
const minN = ref(DEFAULTS.minN)
const isDefault = computed(() =>
  minEvents.value === DEFAULTS.minEvents && rateHiPct.value === DEFAULTS.rateHiPct &&
  ambigHi.value === DEFAULTS.ambigHi && minN.value === DEFAULTS.minN)
function resetThresholds() {
  minEvents.value = DEFAULTS.minEvents; rateHiPct.value = DEFAULTS.rateHiPct
  ambigHi.value = DEFAULTS.ambigHi; minN.value = DEFAULTS.minN; load()
}

const intents = computed(() => data.value.intent_distribution || [])
const kindChart = computed(() => {
  const rows = data.value.misperc_by_kind || []
  const values = rows.map(r => r.count)
  return { labels: rows.map(r => r.kind), values, max: Math.max(...values, 1) }
})
const modelChart = computed(() => {
  const rows = data.value.by_model || []
  const values = rows.map(r => r.count)
  return { labels: rows.map(r => r.model), values, max: Math.max(...values, 1), height: Math.max(196, rows.length * 34 + 48) }
})
const emotionChart = computed(() => {
  const rows = data.value.emotion_distribution || []
  const values = rows.map(r => r.count)
  return { labels: rows.map(r => r.emotion), values, max: Math.max(...values, 1) }
})
const feedbackChart = computed(() => {
  const rows = data.value.feedback_distribution || []
  const values = rows.map(r => r.count)
  return { labels: rows.map(r => r.feedback), values, max: Math.max(...values, 1) }
})

const misread = ref<any[]>([])
const dling = ref(false)
const excludeDev = ref(false)
const localizedFlags = computed(() => {
  const items = data.value.flag_items || []
  if (items.length) return items.map(item => {
    if (item.kind === 'intent') return t('perception.flagIntent', { intent: item.intent, rate: pct(item.rate), count: item.count })
    if (item.kind === 'ambiguity') return t('perception.flagAmbiguity', { value: item.value })
    if (item.kind === 'emotion_zero') return t('perception.flagEmotionZero')
    return t('perception.flagModel', { model: item.model, rate: pct(item.rate), overall: pct(item.overall_rate) })
  })
  return data.value.flags || []
})

async function load() {
  loading.value = true
  refreshing.value = true
  setTimeout(() => { refreshing.value = false }, 550)
  loadMisread()   // 错读案例独立拉取（不受活跃用户/阈值影响），刷新时一并更新
  try {
    const me = Math.max(1, minEvents.value || 1)
    const rate = Math.min(1, Math.max(0, (rateHiPct.value || 0) / 100))
    const amb = Math.max(0, ambigHi.value || 0)
    const mn = Math.max(1, minN.value || 1)
    const q = `hours=${hours.value}&min_events=${me}&rate_hi=${rate}&ambig_hi=${amb}&min_n=${mn}&exclude_dev=${excludeDev.value}`
    const res = await adminStore.authFetch(`/api/v1/admin/perception?${q}`)
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    data.value = await res.json()
    loaded.value = true
    err.value = ''
  } catch (e) { err.value = e instanceof Error ? e.message : '加载失败' } finally { loading.value = false }
}
function setRange(h: string) { hours.value = Number(h); load() }

function pct(v: number | null | undefined) { return v == null ? '—' : (v * 100).toFixed(0) + '%' }
// 标红线 = 当前 rateHiPct；标黄 = 其 0.6 倍（随面板阈值联动）
function rateCard(v: number | null | undefined) { const hi = rateHiPct.value / 100, mid = hi * 0.6; return v != null && v > hi ? 'card-bad' : (v != null && v > mid ? 'card-active' : '') }

async function loadMisread() {
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/perception/misread/recent?n=30&exclude_dev=${excludeDev.value}`)
    if (res.ok) misread.value = (await res.json()).cases || []
  } catch (e) { /* 预览失败不打断主面板 */ }
}

const exporting = ref(false)
async function exportData() {
  exporting.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/perception/export?hours=${hours.value}`)
    if (!res.ok) throw new Error()
    const blob = new Blob([await res.text()], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `perception_events_${hours.value || 'all'}h.json`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  } catch (e) { /* 忽略 */ } finally { exporting.value = false }
}

async function downloadMisread() {
  dling.value = true
  try {
    const res = await adminStore.authFetch('/api/v1/admin/perception/misread/export')
    if (!res.ok) throw new Error()
    const blob = new Blob([await res.text()], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'misread_reflections.md'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  } catch (e) { /* 忽略 */ } finally { dling.value = false }
}
function fmtTs(ts: number) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

onMounted(load)
</script>

<style scoped>
.perc-page { min-height: 100%; padding-bottom: 56px; }

/* ── header（对齐其它后台面板）── */
.page-header { padding: 32px 36px 0; display: flex; align-items: flex-start; justify-content: space-between; }
.page-title-block { display: flex; flex-direction: column; }
.page-title { font-size: 22px; font-weight: 700; color: var(--content-primary); line-height: 1; }
.page-desc  { font-size: 12px; color: var(--content-tertiary); margin-top: 6px; }
.header-right { display: flex; align-items: center; gap: 10px; min-height: 32px; margin-top: 4px; }
.header-right > .data-header-control { height: 32px; box-sizing: border-box; }

/* 排除开发者开关（同 Admin/Analytics/index.vue） */
/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */

/* ── 阈值条 ── */
.ctrl-bar { margin: 20px 36px 0; display: flex; align-items: center; flex-wrap: wrap; gap: 16px; padding: 12px 14px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; }
.ctrl-grp { display: flex; align-items: center; gap: 6px; }
.ctrl-grp label { font-size: 11.5px; color: var(--content-secondary); }
.ctrl-grp input { width: 54px; height: 28px; min-height: 28px; line-height: 28px; padding: 0 7px; text-align: center; }
.ctrl-u { font-size: 11px; color: var(--content-tertiary); }
.ctrl-reset { background: var(--control-bg); border: 1px solid var(--control-border); color: var(--content-secondary); font-size: 11.5px; border-radius: 6px; padding: 4px 10px; cursor: pointer; transition: all .15s; }
.ctrl-reset:hover { background: var(--control-bg-hover); color: var(--content-primary); }
.ctrl-note { margin-left: auto; font-size: 10.5px; color: var(--content-tertiary); }

.state-msg { padding: 60px 36px; text-align: center; color: var(--content-tertiary); font-size: 14px; }
.state-msg.err { color: var(--status-danger); }
.state-msg.sm-sm { padding: 24px 36px; }

/* ── section ── */
.data-section { margin: 24px 36px 0; padding: 16px 18px 18px; background: var(--surface-glass); border: 1px solid var(--border-subtle); border-radius: 12px; }
.data-section:first-of-type { margin-top: 28px; }
.section-head { min-height: 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.section-head > div { min-width: 0; }
.section-head h3 { color: var(--content-secondary); font-size: 13px; font-weight: 700; line-height: 1.4; }
.section-head p { margin-top: 3px; color: var(--content-tertiary); font-size: 11px; line-height: 1.45; }
.chart-frame { width: 100%; min-width: 0; box-sizing: border-box; padding: 10px 14px 8px; background: var(--surface-soft); border: 1px solid var(--border-subtle); border-radius: 10px; }
.compact-chart { max-width: none; }

/* ── flags ── */
.flag-strip { margin: 18px 36px 0; display: flex; flex-direction: column; gap: 8px; }
.flag-item { display: flex; align-items: center; gap: 9px; background: var(--status-danger-bg); border: 1px solid color-mix(in srgb,var(--status-danger) 28%,transparent); color: var(--status-danger); border-radius: 10px; padding: 10px 14px; font-size: 12.5px; }
.flag-dot { flex-shrink: 0; width: 17px; height: 17px; border-radius: 50%; background: var(--status-danger); color: var(--content-on-accent); font-weight: 800; font-size: 12px; display: flex; align-items: center; justify-content: center; }

/* ── cards ── */
.cards-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.card { background: var(--surface-soft); border: 1px solid var(--border-subtle); border-radius: 12px; padding: 18px 18px 14px; }
.card-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; }
.ic-blue  { background: var(--action-soft); color: var(--action-primary); }
.ic-amber { background: var(--status-warning-bg); color: var(--status-warning); }
.card-val { font-size: 28px; font-weight: 700; color: var(--content-primary); line-height: 1; }
.card-lbl { font-size: 11px; color: var(--content-tertiary); margin-top: 7px; }
.card-active { border-color: color-mix(in srgb,var(--status-warning) 28%,transparent); }
.card-active .card-val { color: var(--status-warning); }
.card-bad { border-color: color-mix(in srgb,var(--status-danger) 30%,transparent); }
.card-bad .card-val { color: var(--status-danger); }

/* ── 错读案例预览 ── */
.dl-btn { margin-left: auto; background: var(--action-soft); border: 1px solid var(--action-outline); color: var(--action-primary); font-size: 11.5px; font-weight: 600; letter-spacing: 0; text-transform: none; border-radius: 7px; padding: 5px 12px; cursor: pointer; transition: all .15s; }
.dl-btn.data-header-control { height: 32px; box-sizing: border-box; padding: 0 12px; }
.dl-btn:hover:not(:disabled) { background: var(--action-soft-hover); }
.dl-btn:disabled { opacity: .5; cursor: not-allowed; }
.mr-list { display: flex; flex-direction: column; gap: 8px; }
.mr-row { display: flex; align-items: baseline; gap: 12px; font-size: 12.5px; padding: 9px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 9px; }
.mr-time { flex-shrink: 0; width: 78px; color: var(--content-tertiary); font-size: 11.5px; }
.mr-flow { flex-shrink: 0; color: var(--content-secondary); display: flex; align-items: baseline; gap: 6px; }
.mr-flow b { font-weight: 600; }
.mr-flow i { font-style: normal; color: var(--content-tertiary); }
.mr-pattern { color: var(--content-secondary); line-height: 1.5; }
</style>
