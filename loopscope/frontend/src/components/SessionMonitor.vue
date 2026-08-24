<template>
  <div class="session-monitor">
    <aside class="run-list" @scroll="onRunListScroll">
      <div class="run-list-head">
        <span class="eyebrow">RUNS</span>
        <div class="run-list-actions">
          <button
            class="export-button"
            :class="{ active: selectionMode }"
            :aria-pressed="selectionMode"
            title="选择多个 Run"
            @click="toggleSelectionMode"
          >{{ selectionMode ? '完成' : '多选' }}</button>
          <button
            v-if="selectedRunIds.size"
            class="export-button"
            title="导出选中的 Run"
            @click="emit('export-runs', [...selectedRunIds])"
          >导出 ({{ selectedRunIds.size }})</button>
        </div>
      </div>
      <div v-for="run in runs" :key="run.id" class="run-item">
        <button
        class="run-row"
        :class="{ active: run.id === selectedId, selected: selectedRunIds.has(run.id) }"
        @click="handleRunClick(run.id)"
        >
          <span class="run-dot" :data-status="run.status"></span>
          <span class="run-main"><b>{{ shortRun(run.id) }}</b><small>{{ runTime(run.started_at) }}</small></span>
          <em>{{ fmtMs(run.duration_ms) }}</em>
        </button>
      </div>
      <div v-if="!runs.length" class="empty-run">这个 Session 还没有 Trace。</div>
      <div v-else-if="loadingMore" class="loading-more">正在加载更早 Run…</div>
    </aside>

    <section ref="runDetailEl" class="run-detail">
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
          <div class="run-header-actions">
            <button class="export-button" title="导出当前 Run" @click="emit('export-runs', [selected.id])">导出 Run</button>
            <div class="duration"><small>Duration</small><b>{{ fmtMs(selected.duration_ms) }}</b></div>
          </div>
        </header>

        <section class="usage-grid">
          <div class="usage-card"><span>Input</span><b>{{ fmtTokens(usage.input) }}</b><small>{{ usageSourceLabel }}</small></div>
          <div class="usage-card"><span>Output</span><b>{{ fmtTokens(usage.output) }}</b><small>generated</small></div>
          <div class="usage-card cached"><span>Cache read</span><b>{{ fmtTokens(usage.cache_read) }}</b><small>{{ cachePercent }} of input<span v-if="usage.cache_write"> · write {{ fmtTokens(usage.cache_write) }}</span></small></div>
          <div class="usage-card"><span>Fresh input</span><b>{{ fmtTokens(usage.fresh_input) }}</b><small>not from cache</small></div>
          <div class="usage-card total"><span>Total</span><b>{{ fmtTokens(usage.total) }}</b><small>input + output</small></div>
        </section>

        <div v-if="usage.input" class="cache-bar" title="缓存命中占本轮输入 token 的比例">
          <span class="cache-hit" :style="{ width: `${Math.min(cacheRatio * 100, 100)}%` }"></span>
        </div>
        <div v-if="usage.input" class="cache-legend"><span>cached {{ fmtTokens(usage.cache_read) }}</span><span>fresh {{ fmtTokens(usage.fresh_input) }}</span></div>
        <div v-if="cacheMode === 'passive'" class="cache-hint">
          💡 本轮使用被动前缀缓存，服务端可能已缓存前缀，但 API 不返回缓存命中统计
        </div>
        <div v-if="cacheMode === 'none'" class="cache-hint">
          ℹ️ 当前模型不支持缓存机制
        </div>

        <section v-if="selectedLoaded" class="diagnostic-grid">
          <div class="diagnostic-card">
            <span>Canonical events</span>
            <b>{{ canonicalStats.count ?? '—' }}</b>
            <small>{{ canonicalTypeSummary }}</small>
          </div>
          <div class="diagnostic-card">
            <span>Schema digest</span>
            <b>{{ canonicalStats.schema_digests ? canonicalStats.schema_digests.length : '—' }}</b>
            <small v-if="canonicalStats.schema_digests?.length" class="digest-list">
              <code v-for="digest in canonicalStats.schema_digests" :key="digest">{{ digest }}</code>
            </small>
            <small v-else>本 Run 未发现 Schema digest</small>
          </div>
          <div class="diagnostic-card">
            <span>Adapter calls</span>
            <b>{{ adapterStats.count ?? '—' }}</b>
            <small>{{ adapterCallSummary }}</small>
          </div>
        </section>

        <section class="span-section">
          <header class="span-section-head">
            <div><span class="eyebrow">AGENT LOOP</span><strong>{{ selectedLoaded ? `${selected.spans?.length ?? 0} spans` : '详情加载中…' }}</strong></div>
            <div class="span-actions">
              <span class="hint">{{ selectedLoaded ? 'Input / Output / Source 可分别展开' : '正在按需读取 Span' }}</span>
              <button v-if="selectedLoaded && hasMoreSpans" class="load-spans" @click="emit('load-more-spans')">加载更多</button>
            </div>
          </header>
          <div v-if="injectionSpans.length" class="injection-overview">
            <div class="injection-overview-head"><span class="eyebrow">INJECTION</span><span>本 Run 已注入的工具与 Skill</span></div>
            <div class="injection-list">
              <div v-for="item in injectionSpans" :key="item.id" class="injection-item">
                <strong>{{ injectionLabel(item) }}</strong>
                <span>{{ injectionSummary(item) }}</span>
              </div>
            </div>
          </div>
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
import type { AdapterCallStats, CanonicalEventStats, TraceRun, TokenUsage } from '../types'
import TraceSpanCard from './TraceSpanCard.vue'

const props = defineProps<{ runs: TraceRun[]; details?: Record<string, TraceRun>; focusRunId?: string; hasMoreSpans?: boolean }>()
const emit = defineEmits<{
  select: [runId: string]
  'load-more': []
  'load-more-spans': []
  'export-runs': [runIds: string[]]
}>()
const hasMoreSpans = computed(() => Boolean(props.hasMoreSpans))
const loadingMore = ref(false)
const selectionMode = ref(false)
const selectedRunIds = ref<Set<string>>(new Set())
const runDetailEl = ref<HTMLElement | null>(null)
function getScrollTop() { return runDetailEl.value?.scrollTop ?? 0 }
function setScrollTop(value: number) { if (runDetailEl.value) runDetailEl.value.scrollTop = value }
defineExpose({ getScrollTop, setScrollTop })

const selectedId = ref('')
watch(
  () => [props.runs, props.focusRunId] as const,
  ([runs, focus]) => {
    if (!runs.length) { selectedId.value = ''; return }
    if (focus && runs.some(r => r.id === focus)) { selectRun(focus); return }
    if (!runs.some(r => r.id === selectedId.value)) selectRun(runs[runs.length - 1].id)
  },
  { immediate: true, deep: true },
)

const selected = computed(() => props.details?.[selectedId.value] ?? props.runs.find(r => r.id === selectedId.value) ?? null)
const selectedLoaded = computed(() => Boolean(props.details?.[selectedId.value]?.spans))
const usage = computed<TokenUsage>(() => resolveUsage(selected.value))
const usageSourceLabel = computed(() => hasProviderUsage(selected.value) ? 'provider reported prompt tokens' : 'local estimate')
const cacheRatio = computed(() => usage.value.input ? Math.min((usage.value.cache_read ?? 0) / usage.value.input, 1) : 0)
const cachePercent = computed(() => usage.value.input ? `${(cacheRatio.value * 100).toFixed(1)}%` : '—')
const cacheMode = computed(() => (selected.value?.attributes?.cache_mode ?? 'active') as string)
const canonicalStats = computed<CanonicalEventStats>(() => {
  const value = selected.value?.attributes?.canonical_events
  return value && typeof value === 'object' ? value as CanonicalEventStats : {}
})
const adapterStats = computed<AdapterCallStats>(() => {
  const value = selected.value?.attributes?.adapter_calls
  return value && typeof value === 'object' ? value as AdapterCallStats : {}
})
const canonicalTypeSummary = computed(() => {
  const entries = Object.entries(canonicalStats.value.by_type ?? {})
  return entries.length ? entries.map(([name, count]) => `${name} ${count}`).join(' · ') : '未记录事件类型'
})
const adapterCallSummary = computed(() => {
  const providers = Object.entries(adapterStats.value.by_provider ?? {}).map(([name, count]) => `${name} ${count}`)
  const formats = Object.entries(adapterStats.value.by_api_format ?? {}).map(([name, count]) => `${name} ${count}`)
  const rendered = adapterStats.value.canonical_render_calls ?? 0
  const success = adapterStats.value.success ?? 0
  const errors = adapterStats.value.errors ?? 0
  return `${providers.join(' · ') || 'provider —'} · 成功 ${success} · 失败 ${errors} · canonical render ${rendered}${formats.length ? ` · ${formats.join(' · ')}` : ''}`
})
const modelLabel = computed(() => {
  const a = selected.value?.attributes ?? {}
  return [a.provider, a.model].filter(Boolean).join(' / ') || 'model unknown'
})
const rootSpans = computed(() => (selected.value?.spans ?? []).filter(s => !s.parent_span_id))
const injectionSpans = computed(() => (selected.value?.spans ?? []).filter((span) => {
  const source = span.attributes?.context_source
  return source === 'tool_schema' || source === 'capability_catalog' || source === 'skill_index' || source === 'skill_body'
}))
function injectionLabel(span: any) {
  const labels: Record<string, string> = { tool_schema: '工具 Schema', capability_catalog: '能力目录', skill_index: 'Skill 索引', skill_body: 'Skill 正文' }
  return labels[String(span.attributes?.context_source)] || span.name
}
function injectionSummary(span: any) {
  const input = (span.input && typeof span.input === 'object' ? span.input : {}) as Record<string, any>
  if (span.attributes?.context_source === 'tool_schema') {
    const selected = Array.isArray(input.selected_tool_names) ? input.selected_tool_names : []
    const count = selected.length > 0 ? selected.length : Number(input.tool_count ?? 0)
    return `${count} 个工具`
  }
  if (span.attributes?.context_source === 'capability_catalog') return `${input.skill_count ?? 0} 个 Skill · ${input.catalog_count ?? 0} 项能力`
  if (span.attributes?.context_source === 'skill_index') return `${span.attributes?.skill_count ?? 0} 个 Skill 索引`
  return `${input.skill ?? span.attributes?.skill ?? 'Skill'} · ${span.attributes?.action === 'reused' ? '复用' : '首次加载'}`
}
function childrenOf(id: string) { return (selected.value?.spans ?? []).filter(s => s.parent_span_id === id) }
function selectRun(runId: string) {
  if (selectedId.value !== runId) selectedId.value = runId
  emit('select', runId)
}
function toggleRun(runId: string) {
  const next = new Set(selectedRunIds.value)
  if (next.has(runId)) next.delete(runId)
  else next.add(runId)
  selectedRunIds.value = next
}
function toggleSelectionMode() {
  selectionMode.value = !selectionMode.value
  if (!selectionMode.value) selectedRunIds.value = new Set()
}
function handleRunClick(runId: string) {
  if (selectionMode.value) toggleRun(runId)
  else selectRun(runId)
}
function onRunListScroll(event: Event) {
  const element = event.currentTarget as HTMLElement
  if (element.scrollHeight - element.scrollTop - element.clientHeight > 80 || loadingMore.value) return
  loadingMore.value = true
  emit('load-more')
  window.setTimeout(() => { loadingMore.value = false }, 500)
}

function resolveUsage(run: TraceRun | null): TokenUsage {
  if (!run) return {}
  const candidates = [run.usage, run.attributes?.tokens]
  for (const candidate of candidates) {
    const normalized = normalizeUsage(candidate)
    if (Object.keys(normalized).length) return normalized
  }

  const total = (run.spans ?? []).reduce<TokenUsage>((sum, span) => {
    const usage = normalizeUsage(span.usage)
    const impact = span.token_impact ?? {}
    sum.input = (sum.input ?? 0) + (usage.input ?? Number(impact.prompt_tokens_estimate ?? impact.estimated_input_tokens ?? 0))
    sum.output = (sum.output ?? 0) + (usage.output ?? Number(impact.output_tokens_estimate ?? 0))
    sum.cache_read = (sum.cache_read ?? 0) + (usage.cache_read ?? 0)
    sum.cache_write = (sum.cache_write ?? 0) + (usage.cache_write ?? 0)
    return sum
  }, {})
  if (total.input || total.output || total.cache_read || total.cache_write) {
    total.fresh_input = Math.max((total.input ?? 0) - (total.cache_read ?? 0), 0)
    total.total = (total.input ?? 0) + (total.output ?? 0)
    total.cache_ratio = total.input ? (total.cache_read ?? 0) / total.input : 0
  }
  return total
}

function hasProviderUsage(run: TraceRun | null): boolean {
  const runInput = number(run?.usage?.input)
  if (runInput !== undefined && runInput > 0) return true
  return Boolean((run?.spans ?? []).some(span => {
    const input = number(span.usage?.input)
    return span.kind === 'llm' && input !== undefined && input > 0
  }))
}

function normalizeUsage(value: Record<string, any> | undefined): TokenUsage {
  if (!value || typeof value !== 'object') return {}
  const input = number(value.input ?? value.input_tokens ?? value.prompt_tokens)
  const output = number(value.output ?? value.output_tokens ?? value.completion_tokens)
  const cacheRead = number(value.cache_read ?? value.cache_read_input_tokens ?? value.prompt_cache_hit_tokens)
  const cacheWrite = number(value.cache_write ?? value.cache_write_input_tokens)
  const fresh = number(value.fresh_input)
  const total = number(value.total)
  if (![input, output, cacheRead, cacheWrite, fresh, total].some(v => v !== undefined)) return {}
  return {
    input, output, cache_read: cacheRead, cache_write: cacheWrite,
    fresh_input: fresh ?? (input !== undefined ? Math.max(input - (cacheRead ?? 0), 0) : undefined),
    total: total ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined),
    cache_ratio: input ? (cacheRead ?? 0) / input : 0,
  }
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

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
.run-list-head { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:0 7px 8px; }
.run-list-actions { display:flex; align-items:center; gap:4px; }
.run-item { min-width:0; }
.eyebrow { font-size:8px; letter-spacing:.12em; color:var(--content-tertiary); font-weight:600; }
.run-row { width:100%; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:7px; align-items:center; padding:8px; border:1px solid transparent; border-radius:10px; background:transparent; text-align:left; color:var(--content-secondary); }
.run-row:hover,.run-row.active { background:var(--surface-raised); border-color:var(--border-subtle); }
.run-row.active { box-shadow:var(--elevation-card); color:var(--content-primary); }
.run-row.selected { border-color:var(--action-primary); background:color-mix(in srgb,var(--action-primary) 12%,var(--surface-raised)); }
.export-button { border:1px solid var(--border-subtle); border-radius:7px; padding:4px 7px; background:var(--surface-soft); color:var(--content-secondary); font-size:9px; white-space:nowrap; }
.export-button:hover:not(:disabled) { color:var(--content-primary); border-color:var(--border-default); background:var(--surface-raised); }
.export-button.active { color:var(--content-primary); border-color:var(--border-default); background:var(--surface-raised); }
.export-button:disabled { cursor:not-allowed; opacity:.45; }
.run-dot { width:6px; height:6px; border-radius:50%; background:var(--status-success); }
.run-dot[data-status="error"] { background:var(--status-danger); }
.run-main { min-width:0; }
.run-main b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:9px var(--font-mono); }
.run-main small { display:block; margin-top:2px; color:var(--content-tertiary); font-size:8px; }
.run-row em { font-style:normal; font:8px var(--font-mono); color:var(--content-tertiary); }
.empty-run { padding:28px 10px; color:var(--content-tertiary); font-size:10px; text-align:center; }
.loading-more { padding:8px; color:var(--content-tertiary); font-size:9px; text-align:center; }
.run-detail { min-width:0; min-height:0; overflow:auto; padding:22px 24px 48px; }
.monitor-empty { height:100%; min-height:320px; display:grid; place-items:center; align-content:center; gap:7px; color:var(--content-secondary); }
.monitor-empty span { font-size:11px; }
.run-header { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; }
.run-header h2 { margin:3px 0 5px; font:600 14px var(--font-mono); }
.run-sub { display:flex; gap:7px; color:var(--content-tertiary); font-size:9px; }
.duration { text-align:right; }
.run-header-actions { display:flex; align-items:flex-start; gap:14px; }
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
.cache-hint { margin-top:8px; padding:6px 10px; border-radius:var(--radius-md); background:var(--surface-soft); color:var(--content-tertiary); font-size:10px; line-height:1.5; }
.diagnostic-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-top:12px; }
.diagnostic-card { min-width:0; padding:10px 12px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-card); }
.diagnostic-card > span { display:block; color:var(--content-tertiary); font-size:8px; text-transform:uppercase; letter-spacing:.08em; }
.diagnostic-card > b { display:block; margin:4px 0 3px; font:600 16px var(--font-mono); }
.diagnostic-card > small { display:block; color:var(--content-tertiary); font-size:9px; line-height:1.45; overflow-wrap:anywhere; }
.digest-list { display:flex !important; flex-wrap:wrap; gap:4px; }
.digest-list code { color:var(--content-secondary); font:9px var(--font-mono); }
.span-section { margin-top:24px; }
.span-section-head { display:flex; justify-content:space-between; align-items:end; gap:12px; margin-bottom:9px; }
.span-section-head strong { display:block; margin-top:3px; font-size:11px; }
.injection-overview { margin:0 0 10px; padding:10px 12px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-soft); }
.injection-overview-head { display:flex; align-items:center; gap:8px; color:var(--content-secondary); font-size:9px; }
.injection-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.injection-item { display:flex; align-items:center; gap:6px; padding:5px 7px; border:1px solid var(--border-subtle); border-radius:var(--radius-pill); background:var(--surface-card); font-size:9px; }
.injection-item strong { color:var(--content-primary); font-weight:600; }
.injection-item span { color:var(--content-tertiary); font-family:var(--font-mono); }
.span-actions { display:flex; align-items:center; gap:8px; }
.load-spans { border:1px solid var(--border-subtle); border-radius:7px; padding:4px 7px; background:var(--surface-soft); color:var(--content-secondary); font-size:9px; }
.load-spans:hover { color:var(--content-primary); border-color:var(--border-default); }
.hint { color:var(--content-tertiary); font-size:9px; }
.span-list { display:grid; gap:8px; width:100%; }
.child-spans { display:grid; gap:6px; }
@media(max-width:1050px){ .usage-grid{grid-template-columns:repeat(3,1fr)} }
@media(max-width:1050px){ .diagnostic-grid{grid-template-columns:1fr} }
@media(max-width:760px){ .session-monitor{grid-template-columns:1fr}.run-list{display:flex;gap:6px;border-right:0;border-bottom:1px solid var(--border-subtle);overflow:auto}.run-list-head{display:none}.run-row{min-width:150px}.usage-grid{grid-template-columns:repeat(2,1fr)} }
</style>
