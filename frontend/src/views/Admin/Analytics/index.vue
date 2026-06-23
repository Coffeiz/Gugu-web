<template>
  <div class="analytics-page">
    <div class="page-header">
      <div class="page-title-block">
        <h2 class="page-title">数据分析</h2>
        <p class="page-desc">用户旅程、活跃度、Agent 用量</p>
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

    <div v-if="loading && !data" class="state-msg">加载中…</div>
    <div v-else-if="err" class="state-msg err">{{ err }}</div>

    <template v-else-if="data">

      <!-- ── 用户旅程漏斗 ── -->
      <div class="section-label">用户旅程漏斗</div>
      <div class="funnel-strip">
        <template v-for="(step, i) in funnelSteps" :key="step.key">
          <div class="funnel-box">
            <div class="f-num">{{ step.value.toLocaleString() }}</div>
            <div class="f-lbl">{{ step.label }}</div>
            <div class="f-rate" v-if="i > 0">
              {{ convRate(funnelSteps[i - 1].value, step.value) }}
            </div>
          </div>
          <div class="funnel-arr" v-if="i < funnelSteps.length - 1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8h10M9 4l4 4-4 4"/>
            </svg>
          </div>
        </template>
      </div>

      <!-- ── 概览卡片 ── -->
      <div class="section-label">用户 · 项目</div>
      <div class="cards-grid">
        <div class="card">
          <div class="card-val">{{ data.users.total.toLocaleString() }}</div>
          <div class="card-lbl">注册用户</div>
        </div>
        <div class="card">
          <div class="card-val">{{ data.users.new_30d }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">新增（30 天）</div>
          <div class="card-sub">7 天内 +{{ data.users.new_7d }} 人</div>
        </div>
        <div class="card">
          <div class="card-val">{{ data.users.active_30d }}<span class="card-unit"> 人</span></div>
          <div class="card-lbl">活跃用户（30 天）</div>
          <div class="card-sub">有 Agent 调用</div>
        </div>
        <div class="card">
          <div class="card-val">{{ pct(data.im_bots.adoption_rate) }}<span class="card-unit">%</span></div>
          <div class="card-lbl">IM 接入率</div>
          <div class="card-sub">{{ data.im_bots.users_with_bot }} 人已接入</div>
        </div>

        <div class="card">
          <div class="card-val">{{ data.projects.total.toLocaleString() }}</div>
          <div class="card-lbl">项目总量</div>
        </div>
        <div class="card card-pending">
          <div class="card-val">{{ data.projects.pending }}</div>
          <div class="card-lbl">待开始</div>
        </div>
        <div class="card card-active">
          <div class="card-val">{{ data.projects.active }}</div>
          <div class="card-lbl">进行中</div>
        </div>
        <div class="card card-done">
          <div class="card-val">{{ data.projects.done }}</div>
          <div class="card-lbl">已完成</div>
          <div class="card-sub" v-if="data.projects.total">
            完成率 {{ pct(data.projects.done / data.projects.total) }}%
          </div>
        </div>
      </div>

      <!-- ── 对话 + Agent ── -->
      <div class="two-col">
        <div class="two-col-item">
          <div class="section-label">对话</div>
          <div class="cards-grid col3">
            <div class="card">
              <div class="card-val">{{ data.sessions.total.toLocaleString() }}</div>
              <div class="card-lbl">总量</div>
            </div>
            <div class="card">
              <div class="card-val">{{ data.sessions.web.toLocaleString() }}</div>
              <div class="card-lbl">网页</div>
            </div>
            <div class="card">
              <div class="card-val">{{ data.sessions.im.toLocaleString() }}</div>
              <div class="card-lbl">IM</div>
            </div>
          </div>
        </div>
        <div class="two-col-item">
          <div class="section-label">Agent 调用</div>
          <div class="cards-grid col2">
            <div class="card">
              <div class="card-val">{{ data.agent.total_calls.toLocaleString() }}</div>
              <div class="card-lbl">总调用次数</div>
              <div class="card-sub">今日 {{ data.agent.today_calls }}</div>
            </div>
            <div class="card">
              <div class="card-val">{{ fmtTok(data.agent.tokens_in + data.agent.tokens_out) }}</div>
              <div class="card-lbl">总 Token</div>
              <div class="card-sub">今日 {{ fmtTok(data.agent.today_tokens_in + data.agent.today_tokens_out) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── 模型分布 ── -->
      <template v-if="usage?.by_model?.length">
        <div class="section-label">模型分布</div>
        <div class="model-table">
          <div class="model-head">
            <span>模型</span>
            <span class="col-r">调用次数</span>
            <span class="col-r">Token 消耗</span>
          </div>
          <div v-for="m in usage.by_model" :key="m.model" class="model-row">
            <span class="m-name">
              {{ m.model }}
              <span class="m-provider">{{ m.provider }}</span>
            </span>
            <span class="m-bar-wrap col-r">
              <span class="m-bar" :style="{ width: modelBarPct(m) + '%' }"></span>
              <span class="m-bar-val">{{ m.calls.toLocaleString() }}</span>
            </span>
            <span class="col-r">{{ fmtTok(m.tokens_in + m.tokens_out) }}</span>
          </div>
        </div>
      </template>

    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'

const admin  = useAdminStore()
const data   = ref(null)
const usage  = ref(null)
const loading = ref(false)
const err    = ref('')

const funnelSteps = computed(() => {
  if (!data.value) return []
  const f = data.value.funnel
  return [
    { key: 'registered',       label: '注册',       value: f.registered },
    { key: 'created_project',  label: '创建项目',   value: f.created_project },
    { key: 'completed_project',label: '完成项目',   value: f.completed_project },
    { key: 'used_agent',       label: '使用 Agent', value: f.used_agent },
    { key: 'connected_im',     label: '接入 IM',    value: f.connected_im },
  ]
})

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

const maxModelCalls = computed(() => {
  if (!usage.value?.by_model?.length) return 1
  return Math.max(...usage.value.by_model.map(m => m.calls), 1)
})

function modelBarPct(m) {
  return Math.round(m.calls / maxModelCalls.value * 100)
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    const [sumRes, useRes] = await Promise.all([
      admin.authFetch('/api/v1/admin/analytics/summary'),
      admin.authFetch('/api/v1/admin/agent/usage'),
    ])
    if (!sumRes.ok) throw new Error(`${sumRes.status}`)
    if (!useRes.ok) throw new Error(`${useRes.status}`)
    data.value  = await sumRes.json()
    usage.value = await useRes.json()
  } catch (e) {
    err.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.analytics-page { min-height: 100%; padding-bottom: 48px; }

/* ── header ── */
.page-header {
  padding: 32px 36px 0;
  display: flex; align-items: flex-start; justify-content: space-between;
}
.page-title-block { display: flex; flex-direction: column; }
.page-title { font-size: 22px; font-weight: 700; color: rgba(255,255,255,0.92); line-height: 1; }
.page-desc  { font-size: 12px; color: rgba(255,255,255,0.35); margin-top: 6px; }

.refresh-btn {
  display: flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.55); font-size: 12px; border-radius: 8px;
  padding: 7px 14px; cursor: pointer; transition: all .15s;
  margin-top: 4px;
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
  display: flex; align-items: center; gap: 0;
  padding: 0 36px; overflow-x: auto;
}
.funnel-box {
  flex: 1; min-width: 120px;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 18px 16px 14px;
  display: flex; flex-direction: column; align-items: center;
  position: relative;
}
.f-num  { font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.f-lbl  { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 6px; }
.f-rate {
  position: absolute; top: -10px; left: 50%; transform: translateX(-50%);
  background: rgba(123,127,178,0.25); border: 1px solid rgba(123,127,178,0.3);
  color: rgba(180,185,230,0.9); font-size: 10px; font-weight: 600;
  padding: 1px 7px; border-radius: 20px; white-space: nowrap;
}
.funnel-arr {
  flex-shrink: 0; color: rgba(255,255,255,0.2); padding: 0 8px;
}

/* ── cards ── */
.cards-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 12px; padding: 0 36px;
}
.cards-grid.col3 { grid-template-columns: repeat(3, 1fr); }
.cards-grid.col2 { grid-template-columns: repeat(2, 1fr); }

.card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px; padding: 20px 20px 16px;
}
.card-val  { font-size: 30px; font-weight: 700; color: rgba(255,255,255,0.88); line-height: 1; }
.card-unit { font-size: 14px; font-weight: 400; color: rgba(255,255,255,0.4); }
.card-lbl  { font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 8px; }
.card-sub  { font-size: 11px; color: rgba(255,255,255,0.25); margin-top: 4px; }

.card-pending { border-color: rgba(255,255,255,0.08); }
.card-active  { border-color: rgba(201,148,58,0.3); }
.card-active .card-val { color: #c9943a; }
.card-done    { border-color: rgba(90,158,136,0.3); }
.card-done .card-val   { color: #5a9e88; }

/* ── two-col row ── */
.two-col {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0; align-items: start;
}
.two-col-item .section-label { padding-top: 28px; }

/* ── model table ── */
.model-table {
  margin: 0 36px; background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; overflow: hidden;
}
.model-head {
  display: grid; grid-template-columns: 1fr 160px 120px;
  padding: 10px 16px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em;
  color: rgba(255,255,255,0.3); text-transform: uppercase;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.model-row {
  display: grid; grid-template-columns: 1fr 160px 120px;
  padding: 12px 16px; font-size: 13px; color: rgba(255,255,255,0.7);
  border-bottom: 1px solid rgba(255,255,255,0.04);
  align-items: center;
}
.model-row:last-child { border-bottom: none; }
.col-r { text-align: right; }
.m-name { display: flex; flex-direction: column; gap: 2px; }
.m-provider { font-size: 10px; color: rgba(255,255,255,0.25); }
.m-bar-wrap {
  display: flex; align-items: center; gap: 8px; justify-content: flex-end;
}
.m-bar {
  height: 4px; border-radius: 2px;
  background: linear-gradient(90deg, rgba(123,127,178,0.5), rgba(123,127,178,0.8));
  min-width: 2px; max-width: 80px;
}
.m-bar-val { font-size: 13px; color: rgba(255,255,255,0.7); }
</style>
