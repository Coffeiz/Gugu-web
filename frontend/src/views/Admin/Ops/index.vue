<template>
  <div class="ops-page">
    <div class="ops-head">
      <div>
        <h2 class="ops-title">{{ t('adminOps.title') }}</h2>
        <p class="ops-sub">{{ t('adminOps.description') }}</p>
      </div>
      <div class="ops-head-right">
        <div class="ops-range">
          <button v-for="d in ranges" :key="d.v" class="range-btn" :class="{ active: days === d.v }" @click="days = d.v; load()">{{ d.label }}</button>
        </div>
        <RefreshButton :loading="refreshing" :disabled="loading" @click="load(true)" :title="t('adminOps.refresh')" />
      </div>
    </div>

    <div v-if="err" class="ops-err">{{ err }}</div>

    <!-- 安全事件横幅：正常应恒为 0，非零红色 -->
    <div class="sec-banner" :class="secTotal > 0 ? 'alert' : 'ok'">
      <Icon v-if="secTotal > 0" name="admin.alarm-warning" size="md" />
      <Icon v-else name="user.security" size="md" />
      <span v-if="secTotal > 0" class="sec-txt">
        {{ t('adminOps.securityDetected', { count: secTotal }) }}
        <span v-if="sec['ownership.denied']" class="sec-chip">{{ t('adminOps.ownershipBlocked', { count: sec['ownership.denied'] }) }}</span>
        <span v-if="sec['confirm-gate.bypassed']" class="sec-chip crit">{{ t('adminOps.confirmBypassed', { count: sec['confirm-gate.bypassed'] }) }}</span>
      </span>
      <span v-else class="sec-txt">{{ t('adminOps.noSecurity') }}</span>
    </div>

    <!-- 概览卡片 -->
    <div class="ops-cards">
      <div class="ops-card">
        <div class="oc-label">{{ t('adminOps.totalCalls') }}</div>
        <div class="oc-value">{{ summary.total_calls ?? 0 }}</div>
      </div>
      <div class="ops-card" :class="{ warn: failRatePct >= 5 }">
        <div class="oc-label">{{ t('adminOps.failureRate') }}</div>
        <div class="oc-value">{{ failRatePct }}<i>%</i></div>
        <div class="oc-hint">{{ t('adminOps.failures', { count: summary.total_fails ?? 0 }) }}</div>
      </div>
      <div class="ops-card" :class="{ warn: (summary.p99_ms ?? 0) >= 10000 }">
        <div class="oc-label">{{ t('adminOps.p99') }}</div>
        <div class="oc-value">{{ p99Text }}</div>
        <div class="oc-hint">{{ t('adminOps.p99Hint') }}</div>
      </div>
    </div>

    <!-- 延迟分布 -->
    <div class="ops-section">
      <div class="sec-title">{{ t('adminOps.latency') }}</div>
      <div v-if="latMax === 0" class="ops-empty">{{ t('adminOps.noCalls') }}</div>
      <div v-else class="lat-bars">
        <div v-for="(cnt, bucket) in summary.latency_buckets" :key="bucket" class="lat-row">
          <span class="lat-label">{{ bucketLabel(bucket) }}</span>
          <div class="lat-track"><div class="lat-fill" :style="{ width: (cnt / latMax * 100) + '%' }" /></div>
          <span class="lat-cnt">{{ cnt }}</span>
        </div>
      </div>
    </div>

    <!-- 每工具明细 -->
    <div class="ops-section">
      <div class="sec-title">{{ t('adminOps.details') }}<span class="sl-hint">（{{ t('adminOps.detailsHint') }}）</span></div>
      <div v-if="!summary.tools?.length" class="ops-empty">{{ t('adminOps.noCalls') }}</div>
      <table v-else class="ops-table">
        <thead>
          <tr><th>{{ t('adminOps.tool') }}</th><th class="num">{{ t('adminOps.calls') }}</th><th class="num">{{ t('adminOps.failed') }}</th><th class="num">{{ t('adminOps.failureRate') }}</th><th class="num">{{ t('adminOps.avgDuration') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in summary.tools" :key="t.tool">
            <td class="tool-name">{{ t.tool }}</td>
            <td class="num">{{ t.calls }}</td>
            <td class="num" :class="{ bad: t.fails > 0 }">{{ t.fails }}</td>
            <td class="num" :class="{ bad: t.fail_rate >= 0.05 }">{{ (t.fail_rate * 100).toFixed(1) }}%</td>
            <td class="num" :class="{ warn: t.avg_ms >= 5000 }">{{ fmtMs(t.avg_ms) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '@/stores/admin'

interface ToolRow { tool: string; calls: number; fails: number; fail_rate: number; avg_ms: number }
interface OpsSummary {
  days: number
  total_calls: number
  total_fails: number
  fail_rate: number
  p99_ms: number | null
  latency_buckets: Record<string, number>
  tools: ToolRow[]
  security: Record<string, number>
}

import { useI18n } from 'vue-i18n'
import RefreshButton from '@/components/common/controls/RefreshButton.vue'

const adminStore = useAdminStore()
const { t } = useI18n()
const ranges = computed(() => [
  { v: 1, label: t('adminOps.today') },
  { v: 7, label: t('adminOps.last7') },
  { v: 14, label: t('adminOps.last14') },
])
const days = ref(1)
const summary = ref<Partial<OpsSummary>>({})
const loading = ref(false)
const refreshing = ref(false)
const err = ref('')

const sec = computed<Record<string, number>>(() => summary.value.security ?? {})
const secTotal = computed(() => Object.values(sec.value).reduce((a, b) => a + (b || 0), 0))
const failRatePct = computed(() => +(((summary.value.fail_rate ?? 0) * 100).toFixed(2)))
const latMax = computed(() => Math.max(0, ...Object.values(summary.value.latency_buckets ?? {})))
const p99Text = computed(() => {
  const p = summary.value.p99_ms
  if (p == null) return summary.value.total_calls ? '>30s' : '—'
  return fmtMs(p)
})

function fmtMs(ms: number): string {
  if (ms == null) return '—'
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}
function bucketLabel(bucket: string): string {
  if (bucket === 'inf') return '> 30s'
  const n = +bucket
  return '≤ ' + (n >= 1000 ? n / 1000 + 's' : n + 'ms')
}

async function load(manual = false) {
  if (manual) { refreshing.value = true; setTimeout(() => { refreshing.value = false }, 550) }
  loading.value = true
  try {
    const res = await adminStore.authFetch(`/api/v1/admin/ops/summary?days=${days.value}`)
    if (!res.ok) throw new Error(t('adminOps.loadFailed', { status: res.status }))
    summary.value = await res.json()
    err.value = ''
  } catch (e: any) { err.value = e.message } finally { loading.value = false }
}

onMounted(load)
</script>

<style scoped>
.ops-page { padding: 28px 32px; color: rgba(255,255,255,0.9); }
.ops-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
.ops-title { font-size: 18px; font-weight: 700; margin: 0; }
.ops-sub { font-size: 12px; color: rgba(255,255,255,0.4); margin: 4px 0 0; }
.ops-head-right { display: flex; align-items: center; gap: 12px; }
.ops-range { display: flex; gap: 2px; background: rgba(255,255,255,0.05); border-radius: 9px; padding: 3px; }
.range-btn {
  font-size: 12px; padding: 5px 11px; border-radius: 7px; border: none;
  background: none; color: rgba(255,255,255,0.5); cursor: pointer; transition: all 0.15s;
}
.range-btn:hover { color: rgba(255,255,255,0.8); }
.range-btn.active { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.95); font-weight: 600; }

.ops-err { color: #e08a8a; font-size: 13px; margin-bottom: 12px; }

/* 安全横幅 */
.sec-banner {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-radius: 12px; margin-bottom: 18px;
  font-size: 13px;
}
.sec-banner.ok { background: rgba(90,180,120,0.1); border: 1px solid rgba(90,180,120,0.25); color: #7fc99a; }
.sec-banner.alert { background: rgba(210,80,80,0.12); border: 1px solid rgba(210,80,80,0.35); color: #e58a8a; }
.sec-txt b { font-weight: 700; }
.sec-chip {
  display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 20px;
  background: rgba(210,80,80,0.2); font-size: 12px; font-weight: 600;
}
.sec-chip.crit { background: rgba(210,50,50,0.4); color: #ffb0b0; }

/* 概览卡片 */
.ops-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin-bottom: 22px; }
.ops-card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px; padding: 16px 18px;
}
.ops-card.warn { border-color: rgba(210,150,60,0.4); background: rgba(210,150,60,0.08); }
.oc-label { font-size: 12px; color: rgba(255,255,255,0.45); margin-bottom: 8px; }
.oc-value { font-size: 26px; font-weight: 700; line-height: 1; }
.oc-value i { font-size: 15px; font-weight: 600; color: rgba(255,255,255,0.5); margin-left: 2px; font-style: normal; }
.oc-hint { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 6px; }

/* section */
.ops-section { margin-bottom: 24px; }
.sec-title { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); margin-bottom: 12px; }
.ops-empty { font-size: 13px; color: rgba(255,255,255,0.3); padding: 16px 0; }

/* 延迟分布 */
.lat-bars { display: flex; flex-direction: column; gap: 6px; }
.lat-row { display: flex; align-items: center; gap: 10px; }
.lat-label { width: 64px; font-size: 12px; color: rgba(255,255,255,0.5); text-align: right; flex-shrink: 0; }
.lat-track { flex: 1; height: 18px; background: rgba(255,255,255,0.05); border-radius: 5px; overflow: hidden; }
.lat-fill { height: 100%; background: linear-gradient(90deg, #7b7fb2, #9590c4); border-radius: 5px; transition: width 0.3s; }
.lat-cnt { width: 48px; font-size: 12px; color: rgba(255,255,255,0.55); flex-shrink: 0; }

/* 明细表 */
.ops-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ops-table th {
  text-align: left; font-weight: 600; color: rgba(255,255,255,0.4);
  padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 12px;
}
.ops-table th.num, .ops-table td.num { text-align: right; }
.ops-table td { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); }
.tool-name { font-family: var(--font-mono, monospace); color: rgba(255,255,255,0.85); }
.ops-table td.bad { color: #e58a8a; font-weight: 600; }
.ops-table td.warn { color: #d9a94e; }
</style>
