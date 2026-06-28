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
        <button class="refresh-btn" @click="load" :disabled="loading">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ spinning: loading }">
            <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2"/>
            <polyline points="10 1 14 5 10 5"/>
          </svg>
          刷新
        </button>
      </div>
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
        <div class="card" :class="rateCard(data.overall_misperc_rate)">
          <div class="card-icon ic-amber"><PhPulse :size="16" weight="bold"/></div>
          <div class="card-val">{{ pct(data.overall_misperc_rate) }}</div>
          <div class="card-lbl">误判率（宏平均）</div>
        </div>
        <div class="card" :class="{ 'card-active': data.avg_ambiguity > 60 }">
          <div class="card-icon ic-amber"><PhBrain :size="16" weight="bold"/></div>
          <div class="card-val">{{ data.avg_ambiguity ?? '—' }}</div>
          <div class="card-lbl">平均歧义度 · 情绪 {{ data.avg_emo_strength ?? '—' }}</div>
        </div>
      </div>

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
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { PhUsers, PhChats, PhPulse, PhBrain } from '@phosphor-icons/vue'

const adminStore = useAdminStore()
const data = ref({})
const hours = ref(168)
const loading = ref(false)
const loaded = ref(false)
const err = ref('')
const ranges = [{ h: 24, label: '24h' }, { h: 168, label: '7天' }, { h: 720, label: '30天' }, { h: 0, label: '全部' }]

const intents = computed(() => data.value.intent_distribution || [])

async function load() {
  loading.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/perception?hours=${hours.value}`)
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    data.value = await res.json()
    loaded.value = true
    err.value = ''
  } catch (e) { err.value = e.message } finally { loading.value = false }
}
function setRange(h) { hours.value = h; load() }

function pct(v) { return v == null ? '—' : (v * 100).toFixed(0) + '%' }
// >25% 标红、>15% 标黄（与后端异常阈值对齐）
function rateClass(v) { return v != null && v > 0.25 ? 'bad' : (v != null && v > 0.15 ? 'warn' : '') }
function rateCard(v) { return v != null && v > 0.25 ? 'card-bad' : (v != null && v > 0.15 ? 'card-active' : '') }

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
.refresh-btn { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.55); font-size: 12px; border-radius: 8px; padding: 7px 14px; cursor: pointer; transition: all .15s; }
.refresh-btn:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); }
.refresh-btn:disabled { opacity: .4; cursor: not-allowed; }
@keyframes spin { to { transform: rotate(360deg); } }
.spinning { animation: spin .8s linear infinite; }

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
</style>
