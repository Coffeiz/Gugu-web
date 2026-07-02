<template>
  <div class="perc-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">感知诊断</h2>
        <p class="page-desc">咕咕「读懂用户需求」健康度 · 仅活跃用户、按用户宏平均（重度用户不主导）</p>
      </div>
      <div class="header-right">
        <div class="range-tabs">
          <button v-for="r in ranges" :key="r.h"
            :class="['range-tab', { active: hours === r.h }]"
            @click="setRange(r.h)">{{ r.label }}</button>
        </div>
        <button class="icon-btn" :class="{ spinning: refreshing }" @click="load" :disabled="loading" title="刷新">
          <PhArrowClockwise :size="15" weight="bold" />
        </button>
      </div>
    </div>

    <!-- 阈值条：只改「怎么看」这屏数据（口径 + 标红线），不动系统行为 -->
    <div class="ctrl-bar">
      <span class="ctrl-grp">
        <label>活跃门槛</label>
        <input type="number" min="1" step="1" v-model.number="minEvents" @change="load">
        <span class="ctrl-u">轮</span>
      </span>
      <span class="ctrl-grp">
        <label>标红误判率</label>
        <input type="number" min="0" max="100" step="5" v-model.number="rateHiPct" @change="load">
        <span class="ctrl-u">%</span>
      </span>
      <span class="ctrl-grp">
        <label>歧义偏高线</label>
        <input type="number" min="0" max="100" step="5" v-model.number="ambigHi" @change="load">
      </span>
      <span class="ctrl-grp">
        <label>最小样本</label>
        <input type="number" min="1" step="1" v-model.number="minN" @change="load">
      </span>
      <button v-if="!isDefault" class="ctrl-reset" @click="resetThresholds">复位默认</button>
      <span class="ctrl-note">阈值只改这屏的看法（口径/标红），不影响线上行为</span>
    </div>

    <div v-if="loading && !loaded" class="state-msg">加载中…</div>
    <div v-else-if="err" class="state-msg err">{{ err }}</div>
    <div v-else-if="!data.active_users" class="state-msg">{{ data.note || '暂无活跃用户数据' }}</div>

    <template v-else>
      <!-- 异常标红 -->
      <div v-if="data.flags && data.flags.length" class="flag-strip">
        <div v-for="(f, i) in data.flags" :key="i" class="flag-item"><span class="flag-dot">!</span>{{ f }}</div>
      </div>

      <div class="section-label">总览</div>
      <div class="cards-grid">
        <div class="card">
          <div class="card-icon ic-blue"><PhUsers :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.active_users }}</div>
          <div class="card-lbl">活跃用户（≥{{ data.min_events }} 轮）</div>
        </div>
        <div class="card">
          <div class="card-icon ic-blue"><PhChats :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.perc_total }}</div>
          <div class="card-lbl">观察数 · 纠正 {{ data.misperc_total }}</div>
        </div>
        <div class="card" :class="rateCard(data.perception_misperc_rate)">
          <div class="card-icon ic-amber"><PhPulse :size="16" weight="bold"/></div>
          <div class="card-val">{{ pct(data.perception_misperc_rate) }}</div>
          <div class="card-lbl">感知误判率（仅误读·宏平均）</div>
        </div>
        <div class="card" :class="{ 'card-active': data.avg_ambiguity > ambigHi }">
          <div class="card-icon ic-amber"><PhBrain :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.avg_ambiguity ?? '—' }}</div>
          <div class="card-lbl">平均歧义度 · 情绪 {{ data.avg_emo_strength ?? '—' }}</div>
        </div>
      </div>

      <template v-if="data.misperc_by_kind && data.misperc_by_kind.length">
        <div class="section-label">纠错构成<span class="sl-hint">反思 LLM 判定 · 区分「读错需求」与「数据/执行错」</span></div>
        <div class="emo-strip">
          <span v-for="k in data.misperc_by_kind" :key="k.kind"
            :class="['kind-chip', kindCls(k.kind)]">{{ k.kind }} · {{ k.count }}</span>
          <span class="kind-chip">总纠错率 {{ pct(data.overall_misperc_rate) }}</span>
        </div>
      </template>

      <div class="section-label">需求类型分布 & 误判率<span class="sl-hint">占比=按用户宏平均 · 误判率=被下一句纠正的比例</span></div>
      <div v-if="!intents.length" class="state-msg sm-sm">暂无数据</div>
      <div v-else class="dist">
        <div v-for="r in intents" :key="r.intent" class="dist-row">
          <span class="dist-name">{{ r.intent }}</span>
          <div class="dist-track"><div class="dist-fill" :style="{ width: r.pct + '%' }"></div></div>
          <span class="dist-pct">{{ r.pct }}%</span>
          <span class="dist-rate" :class="rateClass(r.misperc_rate)">误判 {{ pct(r.misperc_rate) }}<i>n={{ r.count }}</i></span>
        </div>
      </div>

      <template v-if="data.by_model && data.by_model.length">
        <div class="section-label">按模型</div>
        <div class="dist">
          <div v-for="r in data.by_model" :key="r.model" class="dist-row">
            <span class="dist-name wide">{{ r.model }}</span>
            <span class="dist-meta">{{ r.count }} 条</span>
            <span class="dist-rate" :class="rateClass(r.misperc_rate)">误判 {{ pct(r.misperc_rate) }}</span>
          </div>
        </div>
      </template>

      <template v-if="data.emotion_distribution && data.emotion_distribution.length">
        <div class="section-label">情绪分布</div>
        <div class="emo-strip">
          <span v-for="e in data.emotion_distribution" :key="e.emotion" class="emo-chip">{{ e.emotion }} · {{ e.count }}</span>
        </div>
      </template>

      <div class="section-label">反馈信号<span class="sl-hint">学习闭环的燃料 · 用户怎么接上一轮（正:确认夸赞/顺着聊/主动分享 · 负:改写重问/无视跳开）</span></div>
      <div v-if="!data.feedback_distribution?.length" class="state-msg sm-sm">暂无反馈信号（采集器 2026-07-02 上线,聊几轮就会积累）</div>
      <div v-else class="emo-strip">
        <span v-for="f in data.feedback_distribution" :key="f.feedback"
          :class="['kind-chip', fbCls(f.feedback)]">{{ f.feedback }} · {{ f.count }}</span>
        <span class="kind-chip">共 {{ data.feedback_total }} 条</span>
      </div>
    </template>

    <!-- 错读案例预览（独立于活跃用户统计，始终显示） -->
    <div class="section-label">错读案例<span class="sl-hint">咕咕「读错需求」的脱敏反思 · 最近 {{ misread.length }} 条</span>
      <button class="dl-btn" @click="downloadMisread" :disabled="dling">{{ dling ? '下载中…' : '下载完整记录' }}</button>
    </div>
    <div v-if="!misread.length" class="state-msg sm-sm">暂无错读案例（需发生一次「误读 + 用户纠正」才记一条）</div>
    <div v-else class="mr-list">
      <div v-for="(c, i) in misread" :key="i" class="mr-row">
        <span class="mr-time">{{ fmtTs(c.ts) }}</span>
        <span class="mr-flow"><b>{{ c.miss?.read_as || '—' }}</b><i>→</i><b>{{ c.miss?.actual || '—' }}</b></span>
        <span class="mr-pattern">{{ c.miss?.pattern || '—' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { PhUsers, PhChats, PhPulse, PhBrain, PhArrowClockwise } from '@phosphor-icons/vue'

const adminStore = useAdminStore()
const data = ref({})
const hours = ref(168)
const loading = ref(false)
const refreshing = ref(false)
const loaded = ref(false)
const err = ref('')
const ranges = [{ h: 24, label: '24h' }, { h: 168, label: '7天' }, { h: 720, label: '30天' }, { h: 0, label: '全部' }]

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

const misread = ref([])
const dling = ref(false)

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
    const q = `hours=${hours.value}&min_events=${me}&rate_hi=${rate}&ambig_hi=${amb}&min_n=${mn}`
    const res = await adminStore.authFetch(`/api/v1/admin/perception?${q}`)
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    data.value = await res.json()
    loaded.value = true
    err.value = ''
  } catch (e) { err.value = e.message } finally { loading.value = false }
}
function setRange(h) { hours.value = h; load() }

function pct(v) { return v == null ? '—' : (v * 100).toFixed(0) + '%' }
// 标红线 = 当前 rateHiPct；标黄 = 其 0.6 倍（随面板阈值联动）
function rateClass(v) { const hi = rateHiPct.value / 100, mid = hi * 0.6; return v != null && v > hi ? 'bad' : (v != null && v > mid ? 'warn' : '') }
function rateCard(v) { const hi = rateHiPct.value / 100, mid = hi * 0.6; return v != null && v > hi ? 'card-bad' : (v != null && v > mid ? 'card-active' : '') }
// 纠错构成配色：感知误读=红（该优化）、数据/执行错=琥珀（归数据/工具）、未判=灰
function kindCls(k) { return k === '感知误读' ? 'kc-bad' : (k === '数据或执行错' ? 'kc-warn' : 'kc-dim') }
function fbCls(v) {
  if (['确认夸赞', '顺着聊', '主动分享'].includes(v)) return 'kc-good'
  if (['改写重问', '无视跳开'].includes(v)) return 'kc-bad'
  return 'kc-dim'
}

async function loadMisread() {
  try {
    const res = await adminStore.authFetch('/api/v1/admin/perception/misread/recent?n=30')
    if (res.ok) misread.value = (await res.json()).cases || []
  } catch (e) { /* 预览失败不打断主面板 */ }
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
function fmtTs(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(load)
</script>

<style scoped>
.perc-page { min-height: 100%; padding-bottom: 56px; }

/* ── header（对齐其它后台面板）── */
.page-header { padding: 32px 36px 0; display: flex; align-items: flex-start; justify-content: space-between; }
.page-title-block { display: flex; flex-direction: column; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }
.header-right { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.range-tabs { display: flex; background: rgba(255,255,255,0.05); border-radius: 8px; padding: 3px; }
.range-tab { font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; color: rgba(255,255,255,0.4); background: transparent; border: none; transition: all .15s; }
.range-tab.active { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
.range-tab:hover:not(.active) { color: rgba(255,255,255,0.6); }
/* 刷新按钮 .icon-btn 用 Admin 全局样式（AdminApp.vue） */

/* ── 阈值条 ── */
.ctrl-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; padding: 16px 36px 0; }
.ctrl-grp { display: flex; align-items: center; gap: 6px; }
.ctrl-grp label { font-size: 11.5px; color: rgba(255,255,255,0.42); }
.ctrl-grp input { width: 54px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: rgba(255,255,255,0.85); font-size: 12px; padding: 4px 7px; text-align: right; outline: none; transition: border-color .15s; }
.ctrl-grp input:focus { border-color: rgba(150,155,210,0.55); }
.ctrl-u { font-size: 11px; color: rgba(255,255,255,0.3); }
.ctrl-reset { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.55); font-size: 11.5px; border-radius: 6px; padding: 4px 10px; cursor: pointer; transition: all .15s; }
.ctrl-reset:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); }
.ctrl-note { margin-left: auto; font-size: 10.5px; color: rgba(255,255,255,0.25); }

.state-msg { padding: 60px 36px; text-align: center; color: rgba(255,255,255,0.3); font-size: 14px; }
.state-msg.err { color: #e07070; }
.state-msg.sm-sm { padding: 24px 36px; }

/* ── section label ── */
.section-label { font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; color: rgba(255,255,255,0.3); text-transform: uppercase; padding: 28px 36px 10px; display: flex; align-items: baseline; gap: 10px; }
.sl-hint { font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none; color: rgba(255,255,255,0.22); }

/* ── flags ── */
.flag-strip { padding: 18px 36px 0; display: flex; flex-direction: column; gap: 8px; }
.flag-item { display: flex; align-items: center; gap: 9px; background: rgba(224,112,112,0.1); border: 1px solid rgba(224,112,112,0.28); color: rgba(235,150,150,0.95); border-radius: 10px; padding: 10px 14px; font-size: 12.5px; }
.flag-dot { flex-shrink: 0; width: 17px; height: 17px; border-radius: 50%; background: rgba(224,112,112,0.85); color: #2a1414; font-weight: 800; font-size: 12px; display: flex; align-items: center; justify-content: center; }

/* ── cards ── */
.cards-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 0 36px; }
.card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 18px 18px 14px; }
.card-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-bottom: 12px; }
.ic-blue  { background: rgba(123,127,178,0.18); color: rgba(150,155,210,0.9); }
.ic-amber { background: rgba(201,148,58,0.18); color: rgba(215,165,75,0.9); }
.card-val { font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.card-lbl { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 7px; }
.card-active { border-color: rgba(201,148,58,0.25); }
.card-active .card-val { color: #c9943a; }
.card-bad { border-color: rgba(224,112,112,0.3); }
.card-bad .card-val { color: #e07070; }

/* ── distribution bars（沿用后台 tool-dist 风格）── */
.dist { padding: 0 36px; display: flex; flex-direction: column; gap: 9px; }
.dist-row { display: flex; align-items: center; gap: 12px; }
.dist-name { width: 64px; flex-shrink: 0; font-size: 12.5px; font-weight: 600; color: rgba(255,255,255,0.7); }
.dist-name.wide { width: 130px; }
.dist-track { flex: 1; height: 7px; border-radius: 4px; background: rgba(255,255,255,0.06); max-width: 320px; }
.dist-fill { height: 100%; border-radius: 4px; background: rgba(123,127,178,0.75); transition: width .3s; }
.dist-pct { width: 44px; flex-shrink: 0; text-align: right; font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.5); }
.dist-meta { font-size: 12px; color: rgba(255,255,255,0.4); }
.dist-rate { margin-left: auto; font-size: 12px; color: rgba(255,255,255,0.4); display: flex; align-items: baseline; gap: 5px; }
.dist-rate i { font-style: normal; font-size: 10.5px; color: rgba(255,255,255,0.25); }
.dist-rate.warn { color: rgba(215,165,75,0.95); }
.dist-rate.bad { color: rgba(235,150,150,0.95); font-weight: 700; }

/* ── emotion ── */
.emo-strip { padding: 0 36px; display: flex; flex-wrap: wrap; gap: 8px; }
.emo-chip { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.55); border-radius: 8px; padding: 5px 11px; font-size: 12px; }
.kind-chip { border-radius: 8px; padding: 5px 11px; font-size: 12px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.55); border: 1px solid transparent; }
.kind-chip.kc-bad  { background: rgba(224,112,112,0.12); color: rgba(235,150,150,0.95); border-color: rgba(224,112,112,0.28); }
.kind-chip.kc-warn { background: rgba(201,148,58,0.12); color: rgba(215,165,75,0.95); border-color: rgba(201,148,58,0.25); }
.kind-chip.kc-dim  { color: rgba(255,255,255,0.4); }
.kind-chip.kc-good { background: rgba(90,158,136,0.12); color: rgba(120,190,160,0.95); border-color: rgba(90,158,136,0.28); }

/* ── 错读案例预览 ── */
.dl-btn { margin-left: auto; background: rgba(123,127,178,0.16); border: 1px solid rgba(123,127,178,0.3); color: rgba(170,175,225,0.95); font-size: 11.5px; font-weight: 600; letter-spacing: 0; text-transform: none; border-radius: 7px; padding: 5px 12px; cursor: pointer; transition: all .15s; }
.dl-btn:hover:not(:disabled) { background: rgba(123,127,178,0.26); }
.dl-btn:disabled { opacity: .5; cursor: not-allowed; }
.mr-list { padding: 0 36px; display: flex; flex-direction: column; gap: 8px; }
.mr-row { display: flex; align-items: baseline; gap: 12px; font-size: 12.5px; padding: 9px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 9px; }
.mr-time { flex-shrink: 0; width: 78px; color: rgba(255,255,255,0.32); font-size: 11.5px; }
.mr-flow { flex-shrink: 0; color: rgba(255,255,255,0.7); display: flex; align-items: baseline; gap: 6px; }
.mr-flow b { font-weight: 600; }
.mr-flow i { font-style: normal; color: rgba(255,255,255,0.3); }
.mr-pattern { color: rgba(255,255,255,0.5); line-height: 1.5; }
</style>
