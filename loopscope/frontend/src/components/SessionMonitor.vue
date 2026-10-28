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
            :title="t('monitor.selectManyTitle')"
            @click="toggleSelectionMode"
          >{{ selectionMode ? t('monitor.done') : t('monitor.multiSelect') }}</button>
          <button
            v-if="selectedRunIds.size"
            class="export-button"
            :title="t('monitor.exportSelectedTitle')"
            @click="emit('export-runs', [...selectedRunIds])"
          >{{ t('monitor.exportCount', { count: selectedRunIds.size }) }}</button>
        </div>
      </div>
      <div v-for="run in runs" :key="run.id" class="run-item">
        <button
        class="run-row"
        :class="{ active: run.id === selectedId, selected: selectedRunIds.has(run.id) }"
        @click="handleRunClick(run.id)"
        >
          <span class="run-dot" :data-status="run.status" :title="runStatus(run.status)"></span>
          <span class="run-main"><b>{{ shortRun(run.id) }}</b><small>{{ runTime(run.started_at) }} · {{ runStatus(run.status) }}</small></span>
          <em>{{ fmtMs(run.duration_ms) }}</em>
        </button>
      </div>
      <div v-if="!runs.length" class="empty-run">{{ t('monitor.emptyTrace') }}</div>
      <div v-else-if="loadingMore" class="loading-more">{{ t('monitor.loadingOlder') }}</div>
    </aside>

    <section ref="runDetailEl" class="run-detail">
      <div v-if="!selected" class="monitor-empty">
        <strong>{{ t('monitor.emptyRunTitle') }}</strong>
        <span>{{ t('monitor.sendMessage') }}</span>
      </div>
      <template v-else>
        <header class="run-header">
          <div>
            <span class="eyebrow">CURRENT RUN</span>
            <h2>{{ selected.id }}</h2>
            <div class="run-sub"><code>{{ selected.trace_id || 'no trace id' }}</code><span>·</span><span>{{ modelLabel }}</span></div>
          </div>
          <div class="run-header-actions">
            <button class="export-button" :title="t('monitor.exportRun')" @click="emit('export-runs', [selected.id])">{{ t('monitor.exportRun') }}</button>
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

        <div v-if="usage.input" class="cache-bar" :title="t('monitor.cacheRatio')">
          <span class="cache-hit" :style="{ width: `${Math.min(cacheRatio * 100, 100)}%` }"></span>
        </div>
        <div v-if="usage.input" class="cache-legend"><span>cached {{ fmtTokens(usage.cache_read) }}</span><span>fresh {{ fmtTokens(usage.fresh_input) }}</span></div>
        <div v-if="cacheMode === 'passive'" class="cache-hint">
          💡 {{ t('monitor.passiveCache') }}
        </div>
        <div v-if="cacheMode === 'none' && usage.cache_read" class="cache-hint">
          ℹ️ {{ t('monitor.passiveHit') }}
        </div>
        <div v-else-if="cacheMode === 'none'" class="cache-hint">
          ℹ️ {{ t('monitor.noCache') }}
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
            <small v-else>{{ t('monitor.noSchemaDigest') }}</small>
          </div>
          <div class="diagnostic-card">
            <span>Adapter calls</span>
            <b>{{ adapterStats.count ?? '—' }}</b>
            <small>{{ adapterCallSummary }}</small>
          </div>
        </section>

        <section class="span-section">
          <header class="span-section-head">
            <div><span class="eyebrow">AGENT LOOP</span><strong>{{ selectedLoaded ? `${selected.spans?.length ?? 0} spans` : t('monitor.spanDetailsLoading') }}</strong></div>
            <div class="span-actions">
              <span class="hint">{{ selectedLoaded ? t('monitor.inputOutputSource') : t('monitor.spanLoadHint') }}</span>
              <button v-if="selectedLoaded && hasMoreSpans" class="load-spans" @click="emit('load-more-spans')">{{ t('monitor.loadMore') }}</button>
            </div>
          </header>
          <div v-if="injectionSpans.length" class="injection-overview">
            <div class="injection-overview-head"><span class="eyebrow">INJECTION</span><span>{{ t('monitor.injected') }}</span></div>
            <div class="injection-list">
              <div v-for="item in injectionSpans" :key="item.id" class="injection-item">
                <strong>{{ injectionLabel(item) }}</strong>
                <span>{{ injectionSummary(item) }}</span>
              </div>
            </div>
          </div>
          <div class="span-list">
            <template v-for="span in rootSpans" :key="span.id">
              <TraceSpanCard :span="span" :previous-span="previousRoundSpan(span)" />
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
import { formatCompactNumber } from '../utils/formatNumber'
import { resolveMonitorSelection } from '../utils/monitorSelection'
import { useLoopScopeI18n } from '../i18n/index'

const { t } = useLoopScopeI18n()
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
let previousFocusRunId: string | undefined
watch(
  () => ({ runIds: props.runs.map(run => run.id), focusRunId: props.focusRunId }),
  ({ runIds, focusRunId }) => {
    const nextId = resolveMonitorSelection({
      runIds,
      selectedRunId: selectedId.value,
      focusRunId,
      focusChanged: focusRunId !== previousFocusRunId,
    })
    previousFocusRunId = focusRunId
    if (nextId !== selectedId.value) selectRun(nextId)
  },
  { immediate: true },
)

const selected = computed(() => props.details?.[selectedId.value] ?? props.runs.find(r => r.id === selectedId.value) ?? null)
const selectedLoaded = computed(() => Boolean(props.details?.[selectedId.value]?.spans))
const usage = computed<TokenUsage>(() => resolveUsage(selected.value))
const usageSourceLabel = computed(() => {
  if (hasProviderUsage(selected.value)) return 'provider reported prompt tokens'
  return Object.keys(usage.value).length ? 'local estimate' : 'no model usage'
})
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
  return entries.length ? entries.map(([name, count]) => `${name} ${count}`).join(' · ') : t('monitor.unrecordedEventTypes')
})
const adapterCallSummary = computed(() => {
  const providers = Object.entries(adapterStats.value.by_provider ?? {}).map(([name, count]) => `${name} ${count}`)
  const formats = Object.entries(adapterStats.value.by_api_format ?? {}).map(([name, count]) => `${name} ${count}`)
  const rendered = adapterStats.value.canonical_render_calls ?? 0
  const success = adapterStats.value.success ?? 0
  const errors = adapterStats.value.errors ?? 0
  return `${providers.join(' · ') || 'provider —'} · ${t('monitor.requestSuccess')} ${success} · ${t('monitor.requestFailure')} ${errors} · canonical render ${rendered}${formats.length ? ` · ${formats.join(' · ')}` : ''}`
})
const modelLabel = computed(() => {
  const a = selected.value?.attributes ?? {}
  const labels = [[a.provider, a.model]]
  for (const span of selected.value?.spans ?? []) {
    if (span.kind !== 'llm') continue
    labels.push([span.attributes?.provider, span.attributes?.model])
    const input = span.input && typeof span.input === 'object'
      ? span.input as Record<string, any>
      : {}
    const reflection = input.reflection_cache_probe
    if (reflection && typeof reflection === 'object') {
      labels.push([reflection.provider, reflection.model])
    }
  }
  const label = labels.map(parts => parts.filter(Boolean).join(' / ')).find(Boolean)
  if (label) return label
  if (selected.value?.ended_at && !(selected.value.spans ?? []).some(span => span.kind === 'llm')) {
    return t('monitor.noModelCall')
  }
  return t('monitor.modelUnknown')
})
const rootSpans = computed(() => (selected.value?.spans ?? []).filter(s => !s.parent_span_id))
const injectionSpans = computed(() => (selected.value?.spans ?? []).filter((span) => {
  const source = span.attributes?.context_source
  return source === 'tool_schema' || source === 'tool_schema_error' || source === 'capability_catalog' || source === 'skill_index' || source === 'skill_body' || source === 'shell_policy'
}))
function injectionLabel(span: any) {
  const labels: Record<string, string> = { tool_schema: 'trace.contextSchema', tool_schema_error: 'trace.schemaError', capability_catalog: 'trace.capabilityCatalog', skill_index: 'trace.skillIndex', skill_body: 'trace.skillBody', shell_policy: 'trace.shellPolicy' }
  const key = labels[String(span.attributes?.context_source)]
  return key ? t(key) : span.name
}
function injectionSummary(span: any) {
  const input = (span.input && typeof span.input === 'object' ? span.input : {}) as Record<string, any>
  if (span.attributes?.context_source === 'shell_policy') {
    return span.attributes?.role === 'stable_protocol' ? t('monitor.stableProtocol') : t('monitor.dynamicPermissions')
  }
  if (span.attributes?.context_source === 'tool_schema') {
    const selected = Array.isArray(input.selected_tool_names) ? input.selected_tool_names : []
    const count = selected.length > 0 ? selected.length : Number(input.tool_count ?? 0)
    const mcpCount = Array.isArray(input.mcp_tool_names) ? input.mcp_tool_names.length : 0
    return `${t('monitor.toolsCount', { count })}${mcpCount ? t('monitor.mcpCount', { count: mcpCount }) : ''}`
  }
  if (span.attributes?.context_source === 'capability_catalog') return `${t('monitor.skillsCount', { count: input.skill_count ?? 0 })} · ${t('monitor.capabilitiesCount', { count: input.catalog_count ?? 0 })}`
  if (span.attributes?.context_source === 'skill_index') return `${t('monitor.skillsCount', { count: span.attributes?.skill_count ?? 0 })} index`
  return `${input.skill ?? span.attributes?.skill ?? 'Skill'} · ${span.attributes?.action === 'reused' ? t('monitor.skillActionReused') : t('monitor.skillActionFirst')}`
}
function childrenOf(id: string) { return (selected.value?.spans ?? []).filter(s => s.parent_span_id === id) }
function previousRoundSpan(span: any) {
  if (span.kind !== 'llm') return undefined
  const rounds = rootSpans.value
    .filter(item => item.kind === 'llm' && item.id !== span.id)
    .sort((a, b) => (Number(a.attributes?.round ?? 0) - Number(b.attributes?.round ?? 0)) || a.ordinal - b.ordinal)
  const currentRound = Number(span.attributes?.round ?? 0)
  const previousInRun = rounds.reverse().find(item => Number(item.attributes?.round ?? 0) < currentRound)
  if (previousInRun) return previousInRun
  if (currentRound > 1) return undefined

  const currentRun = selected.value
  if (!currentRun) return undefined
  const previousRun = props.runs
    .filter(run => run.id !== currentRun.id && run.started_at < currentRun.started_at)
    .sort((a, b) => b.started_at - a.started_at)[0]
  const previousSpans = previousRun ? props.details?.[previousRun.id]?.spans ?? [] : []
  return previousSpans
    .filter(item => !item.parent_span_id && item.kind === 'llm')
    .sort((a, b) => (Number(a.attributes?.round ?? 0) - Number(b.attributes?.round ?? 0)) || a.ordinal - b.ordinal)
    .at(-1)
}
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
  const spans = run.spans ?? []
  if (!spans.some(span => span.kind === 'llm')) return {}
  const candidates = [run.usage, run.attributes?.tokens]
  for (const candidate of candidates) {
    const normalized = normalizeUsage(candidate)
    if (!Object.keys(normalized).length) continue
    if (hasPositiveUsage(normalized)) return normalized
  }

  const total = spans.reduce<TokenUsage>((sum, span) => {
    const usage = normalizeUsage(span.usage)
    const impact = span.token_impact ?? {}
    const hasUsage = hasPositiveUsage(usage)
    const measuredInput = hasUsage ? usage.input ?? (
      usage.fresh_input !== undefined || usage.cache_read !== undefined || usage.cache_write !== undefined
        ? Number(usage.fresh_input ?? 0) + Number(usage.cache_read ?? 0) + Number(usage.cache_write ?? 0)
        : undefined
    ) : undefined
    sum.input = (sum.input ?? 0) + (measuredInput ?? Number(impact.prompt_tokens_estimate ?? impact.estimated_input_tokens ?? 0))
    sum.output = (sum.output ?? 0) + ((hasUsage ? usage.output : undefined) ?? Number(impact.output_tokens_estimate ?? 0))
    sum.cache_read = (sum.cache_read ?? 0) + (usage.cache_read ?? 0)
    sum.cache_write = (sum.cache_write ?? 0) + (usage.cache_write ?? 0)
    return sum
  }, {})
  if (total.input || total.output || total.cache_read || total.cache_write) {
    total.fresh_input = Math.max((total.input ?? 0) - (total.cache_read ?? 0), 0)
    total.total = (total.input ?? 0) + (total.output ?? 0)
    total.cache_ratio = total.input ? (total.cache_read ?? 0) / total.input : 0
    return total
  }
  return total
}

function hasPositiveUsage(usage: TokenUsage): boolean {
  return [usage.input, usage.output, usage.cache_read, usage.cache_write, usage.total]
    .some(value => typeof value === 'number' && value > 0)
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
function runStatus(status: string) {
  if (status === 'running') return t('monitor.runStatusRunning')
  if (status === 'error' || status === 'failed' || status === 'cancelled') return t('monitor.runStatusFailed')
  return t('monitor.runStatusCompleted')
}
function fmtTokens(v: number | null | undefined) {
  return formatCompactNumber(v)
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
