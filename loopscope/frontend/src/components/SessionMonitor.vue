<template>
  <div class="session-monitor">
    <aside class="run-list">
      <div class="run-list-head">
        <span class="eyebrow">RUNS</span>
        <button class="refresh" title="刷新" @click="$emit('refresh')">↻</button>
      </div>
      <button
        v-for="run in runs"
        :key="run.id"
        class="run-row"
        :class="{ active: run.id === selectedId }"
        @click="selectedId = run.id"
      >
        <span class="run-dot" :data-status="run.status"></span>
        <span class="run-main"><b>{{ shortRun(run.id) }}</b><small>{{ runTime(run.started_at) }}</small></span>
        <em>{{ fmtMs(run.duration_ms) }}</em>
      </button>
      <div v-if="!runs.length" class="empty-run">这个 Session 还没有 Trace。</div>
    </aside>

    <section class="run-detail">
      <div v-if="!selected" class="monitor-empty">
        <strong>没有可查看的 Run</strong>
        <span>发送一条消息后，这里会出现完整 AgentLoop。</span>
      </div>
      <template v-else>
        <header class="run-header">
          <div>
            <span class="eyebrow">CURRENT RUN</span>
            <h2>{{ selected.id }}</h2>
            <div class="run-sub"><code>{{ selected.trace_id || 'no trace id' }}</code><span>·</span><span>{{ modelLabel }}</span></div>
          </div>
          <div class="duration"><small>Duration</small><b>{{ fmtMs(selected.duration_ms) }}</b></div>
        </header>

        <section class="usage-grid">
          <div class="usage-card"><span>Input</span><b>{{ fmtTokens(usage.input) }}</b><small>normalized prompt total</small></div>
          <div class="usage-card"><span>Output</span><b>{{ fmtTokens(usage.output) }}</b><small>generated</small></div>
          <div class="usage-card cached"><span>Cache read</span><b>{{ fmtTokens(usage.cache_read) }}</b><small>{{ cachePercent }} of input<span v-if="usage.cache_write"> · write {{ fmtTokens(usage.cache_write) }}</span></small></div>
          <div class="usage-card"><span>Fresh input</span><b>{{ fmtTokens(usage.fresh_input) }}</b><small>not from cache</small></div>
          <div class="usage-card total"><span>Total</span><b>{{ fmtTokens(usage.total) }}</b><small>input + output</small></div>
        </section>

        <div v-if="usage.input" class="cache-bar" title="缓存命中占本轮输入 token 的比例">
          <span class="cache-hit" :style="{ width: `${Math.min(cacheRatio * 100, 100)}%` }"></span>
        </div>
        <div v-if="usage.input" class="cache-legend"><span>cached {{ fmtTokens(usage.cache_read) }}</span><span>fresh {{ fmtTokens(usage.fresh_input) }}</span></div>

        <section class="span-section">
          <header class="span-section-head">
            <div><span class="eyebrow">AGENT LOOP</span><strong>{{ selected.spans?.length ?? 0 }} spans</strong></div>
            <span class="hint">Input / Output / Source 可分别展开</span>
          </header>
          <div class="span-list">
            <template v-for="span in rootSpans" :key="span.id">
              <TraceSpanCard :span="span" />
              <div v-if="childrenOf(span.id).length" class="child-spans">
                <TraceSpanCard v-for="child in childrenOf(span.id)" :key="child.id" :span="child" :depth="1" />
              </div>
            </template>
          </div>
        </section>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TraceRun, TokenUsage } from '../types'
import TraceSpanCard from './TraceSpanCard.vue'

const props = defineProps<{ runs: TraceRun[]; focusRunId?: string }>()
defineEmits<{ refresh: [] }>()

const selectedId = ref('')
watch(
  () => [props.runs, props.focusRunId] as const,
  ([runs, focus]) => {
    if (!runs.length) { selectedId.value = ''; return }
    if (focus && runs.some(r => r.id === focus)) { selectedId.value = focus; return }
    if (!runs.some(r => r.id === selectedId.value)) selectedId.value = runs[runs.length - 1].id
  },
  { immediate: true, deep: true },
)

const selected = computed(() => props.runs.find(r => r.id === selectedId.value) ?? null)
const usage = computed<TokenUsage>(() => selected.value?.usage ?? selected.value?.attributes?.tokens ?? {})
const cacheRatio = computed(() => usage.value.input ? Math.min((usage.value.cache_read ?? 0) / usage.value.input, 1) : 0)
const cachePercent = computed(() => usage.value.input ? `${(cacheRatio.value * 100).toFixed(1)}%` : '—')
const modelLabel = computed(() => {
  const a = selected.value?.attributes ?? {}
  return [a.provider, a.model].filter(Boolean).join(' / ') || 'model unknown'
})
const rootSpans = computed(() => (selected.value?.spans ?? []).filter(s => !s.parent_span_id))
function childrenOf(id: string) { return (selected.value?.spans ?? []).filter(s => s.parent_span_id === id) }

function shortRun(id: string) { return id.length > 17 ? `${id.slice(0, 11)}…${id.slice(-4)}` : id }
function runTime(sec: number) { return new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function fmtMs(v: number | null | undefined) {
  if (v == null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`
}
function fmtTokens(v: number | null | undefined) {
  if (v == null) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k`
  return String(Math.round(v))
}
</script>

<style scoped>
.session-monitor { min-height:0; height:100%; display:grid; grid-template-columns:190px minmax(0,1fr); overflow:hidden; }
.run-list { min-height:0; overflow:auto; padding:16px 10px; border-right:1px solid var(--border-subtle); background:color-mix(in srgb,var(--surface-panel) 56%,transparent); }
.run-list-head { display:flex; align-items:center; justify-content:space-between; padding:0 7px 8px; }
.eyebrow { font-size:8px; letter-spacing:.12em; color:var(--content-tertiary); font-weight:600; }
.refresh { width:26px; height:26px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--surface-raised); color:var(--content-secondary); }
.run-row { width:100%; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:7px; align-items:center; padding:8px; border:1px solid transparent; border-radius:10px; background:transparent; text-align:left; color:var(--content-secondary); }
.run-row:hover,.run-row.active { background:var(--surface-raised); border-color:var(--border-subtle); }
.run-row.active { box-shadow:var(--elevation-card); color:var(--content-primary); }
.run-dot { width:6px; height:6px; border-radius:50%; background:var(--status-success); }
.run-dot[data-status="error"] { background:var(--status-danger); }
.run-main { min-width:0; }
.run-main b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:9px var(--font-mono); }
.run-main small { display:block; margin-top:2px; color:var(--content-tertiary); font-size:8px; }
.run-row em { font-style:normal; font:8px var(--font-mono); color:var(--content-tertiary); }
.empty-run { padding:28px 10px; color:var(--content-tertiary); font-size:10px; text-align:center; }
.run-detail { min-width:0; min-height:0; overflow:auto; padding:22px 24px 48px; }
.monitor-empty { height:100%; min-height:320px; display:grid; place-items:center; align-content:center; gap:7px; color:var(--content-secondary); }
.monitor-empty span { font-size:11px; }
.run-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; }
.run-header h2 { margin:3px 0 5px; font:600 14px var(--font-mono); }
.run-sub { display:flex; gap:7px; color:var(--content-tertiary); font-size:9px; }
.duration { text-align:right; }
.duration small { display:block; color:var(--content-tertiary); font-size:8px; text-transform:uppercase; letter-spacing:.08em; }
.duration b { font:600 16px var(--font-mono); }
.usage-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin-top:18px; }
.usage-card { padding:11px 12px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-card); }
.usage-card span,.usage-card small { display:block; color:var(--content-tertiary); font-size:8px; }
.usage-card b { display:block; margin:4px 0 2px; font:600 17px var(--font-mono); }
.usage-card.cached b { color:var(--action-primary); }
.usage-card.total { background:var(--surface-raised); box-shadow:var(--elevation-card); }
.cache-bar { height:5px; margin-top:10px; border-radius:var(--radius-pill); overflow:hidden; background:var(--surface-soft); }
.cache-hit { display:block; height:100%; border-radius:inherit; background:var(--action-primary); transition:width var(--motion-default) var(--motion-ease-standard); }
.cache-legend { display:flex; justify-content:space-between; margin-top:4px; color:var(--content-tertiary); font:8px var(--font-mono); }
.span-section { margin-top:24px; }
.span-section-head { display:flex; justify-content:space-between; align-items:end; gap:12px; margin-bottom:9px; }
.span-section-head strong { display:block; margin-top:3px; font-size:11px; }
.hint { color:var(--content-tertiary); font-size:9px; }
.span-list { display:grid; gap:8px; max-width:1080px; }
.child-spans { display:grid; gap:6px; }
@media(max-width:1050px){ .usage-grid{grid-template-columns:repeat(3,1fr)} }
@media(max-width:760px){ .session-monitor{grid-template-columns:1fr}.run-list{display:flex;gap:6px;border-right:0;border-bottom:1px solid var(--border-subtle);overflow:auto}.run-list-head{display:none}.run-row{min-width:150px}.usage-grid{grid-template-columns:repeat(2,1fr)} }
</style>
