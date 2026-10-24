<template>
  <div class="reflection-page">
    <header class="page-head">
      <div>
        <span class="eyebrow">LOOPSCOPE · MEMORY</span>
        <h1>{{ t('reflection.title') }}</h1>
        <p>{{ t('reflection.description') }}</p>
      </div>
      <button class="ls-button" :disabled="loading" @click="refresh">{{ loading ? t('common.refreshing') : t('common.refresh') }}</button>
    </header>

    <p v-if="error" class="error-state">{{ error }}</p>
    <section class="metrics" :aria-label="t('reflection.stats')">
      <article class="metric ls-card"><span>{{ t('reflection.samples') }}</span><strong>{{ filtered.length }}</strong><small>{{ t('reflection.filtered') }}</small></article>
      <article class="metric ls-card"><span>{{ t('reflection.inputTokens') }}</span><strong>{{ fmt(totalInput) }}</strong><small>{{ t('reflection.cachedReadWrite') }}</small></article>
      <article class="metric ls-card"><span>{{ t('reflection.weightedHitRate') }}</span><strong>{{ percent(weightedCacheRate) }}</strong><small>{{ fmt(totalCacheRead) }} cache read</small></article>
      <article class="metric ls-card"><span>{{ t('reflection.lowHit') }}</span><strong>{{ lowHitCount }}</strong><small>{{ t('reflection.probeEligible') }}</small></article>
    </section>

    <section class="filters ls-card">
      <div class="filter-field">
        <span>{{ t('reflection.scope') }}</span>
        <ListSelect v-model="scopeFilter" :label="t('reflection.scope')" :options="scopeOptions" />
      </div>
      <div class="filter-field">
        <span>{{ t('reflection.trigger') }}</span>
        <ListSelect v-model="triggerFilter" :label="t('reflection.trigger')" :options="triggerOptions" />
      </div>
      <span class="filter-note">{{ t('reflection.sorted') }}</span>
    </section>

    <section class="sample-list">
      <article v-for="run in filtered" :key="run.id" class="sample ls-card">
        <header class="sample-head">
          <div class="sample-title">
            <span class="status-dot" :class="{ low: probe(run).cache_low_hit }"></span>
            <strong>{{ probe(run).provider || t('reflection.unknownProvider') }} <span>/</span> {{ probe(run).model || t('reflection.unknownModel') }}</strong>
            <small>{{ probe(run).api_format || t('reflection.unknownProtocol') }} · {{ scopeLabel(probe(run).reflection_scope) }} · {{ triggerLabel(probe(run).trigger_source) }} · {{ requestStatus(probe(run)) }}</small>
          </div>
          <div class="sample-rate" :class="{ low: probe(run).cache_low_hit }">{{ percent(number(probe(run).cache_hit_ratio)) }}</div>
        </header>

        <div class="sample-stats">
          <div><span>{{ t('reflection.input') }}</span><b>{{ fmt(number(probe(run).input_tokens)) }}</b></div>
          <div><span>{{ t('reflection.cacheRead') }}</span><b>{{ fmt(number(probe(run).cache_read_tokens)) }}</b></div>
          <div><span>{{ t('reflection.cacheWrite') }}</span><b>{{ fmt(number(probe(run).cache_write_tokens)) }}</b></div>
          <div><span>{{ t('reflection.prefixEstimate') }}</span><b>{{ fmt(number(probe(run).stable_prefix_tokens_estimate)) }}</b></div>
          <div><span>{{ probe(run).request_outcome === 'error' ? `${t('reflection.failure')} ${probe(run).request_error_status || ''}` : t('reflection.requestDuration') }}</span><b>{{ duration(probe(run).request_duration_ms) }}</b></div>
          <div><span>{{ t('reflection.gap') }}</span><b>{{ gap(probe(run).origin_gap_seconds) }}</b></div>
        </div>

        <details class="wire-detail">
          <summary>{{ t('reflection.wireAnchors') }}</summary>
          <dl>
            <div><dt>{{ t('reflection.requestStarted') }}</dt><dd>{{ dateTime(probe(run).request_started_at) }}</dd></div>
            <div><dt>{{ t('reflection.responseReceived') }}</dt><dd>{{ dateTime(probe(run).response_received_at) }}</dd></div>
            <div v-if="probe(run).request_outcome === 'error'"><dt>{{ t('reflection.failureType') }}</dt><dd>{{ probe(run).request_error_type || 'ProviderError' }} · {{ probe(run).request_error_code || t('reflection.noErrorCode') }}</dd></div>
            <div><dt>{{ t('reflection.wireDigest') }}</dt><dd><code>{{ wire(run).digest || t('reflection.unrecorded') }}</code></dd></div>
            <div><dt>{{ t('reflection.messageRange') }}</dt><dd>{{ wire(run).rows_key || '—' }} · {{ t('reflection.prefixRows', { prefix: wire(run).prefix_row_count ?? '—', request: wire(run).request_row_count ?? '—' }) }}</dd></div>
            <div><dt>{{ t('reflection.cacheAnchors') }}</dt><dd><code>{{ anchors(run) }}</code></dd></div>
            <div><dt>{{ t('reflection.bodyLength') }}</dt><dd>{{ fmt(number(wire(run).text_char_count)) }} {{ t('reflection.charactersNotSaved') }}</dd></div>
            <div><dt>{{ t('reflection.rawUsageFields') }}</dt><dd><code>{{ usageFields(run) }}</code></dd></div>
            <div><dt>{{ t('reflection.providerUsageProbe') }}</dt><dd><pre>{{ usageJson(run) }}</pre></dd></div>
          </dl>
        </details>
        <footer><span>Run {{ run.id }}</span><span v-if="probe(run).origin_run_id">{{ t('reflection.mainRun') }} {{ probe(run).origin_run_id }}</span></footer>
      </article>
      <div v-if="!filtered.length && !loading" class="empty-state ls-card">
        <strong>{{ runs.length ? t('reflection.noMatchingSamples') : t('reflection.noSamples') }}</strong>
        <span>{{ t('reflection.emptyHint') }}</span>
      </div>
    </section>
    <div v-if="hasMore" class="more-row"><button class="ls-button" :disabled="loading" @click="loadMore">{{ loading ? t('common.loading') : t('reflection.loadOlder') }}</button></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { TraceRun } from '../types'
import { listReflectionRuns, subscribeTraceEvents } from '../services/api'
import { formatCompactNumber } from '../utils/formatNumber'
import { useLoopScopeI18n } from '../i18n/index'
import ListSelect from '../components/ListSelect.vue'

type Probe = Record<string, any>
const { t, locale } = useLoopScopeI18n()
const scopeOptions = computed(() => [
  { value: 'all', label: t('reflection.scopeAll') },
  { value: 'owner', label: t('reflection.owner') },
  { value: 'private', label: t('reflection.private') },
  { value: 'group', label: t('reflection.group') },
  { value: 'member', label: t('reflection.member') },
])
const triggerOptions = computed(() => [
  { value: 'all', label: t('reflection.all') },
  { value: 'threshold', label: t('reflection.threshold') },
  { value: 'idle', label: t('reflection.idle') },
  { value: 'background_job', label: t('reflection.background') },
  { value: 'session_snapshot', label: t('reflection.snapshot') },
])
const runs = ref<TraceRun[]>([])
const loading = ref(false)
const error = ref('')
const hasMore = ref(false)
const scopeFilter = ref('all')
const triggerFilter = ref('all')
let stopEvents: (() => void) | null = null

function probe(run: TraceRun): Probe {
  const value = run.attributes?.reflection_cache_probe
  return value && typeof value === 'object' ? value as Probe : {}
}
function wire(run: TraceRun): Probe {
  const value = probe(run).wire_prefix
  return value && typeof value === 'object' ? value as Probe : {}
}
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
const filtered = computed(() => runs.value.filter(run => {
  const p = probe(run)
  return (scopeFilter.value === 'all' || p.reflection_scope === scopeFilter.value)
    && (triggerFilter.value === 'all' || p.trigger_source === triggerFilter.value)
}))
const totalInput = computed(() => filtered.value.reduce((sum, run) => sum + number(probe(run).input_tokens), 0))
const totalCacheRead = computed(() => filtered.value.reduce((sum, run) => sum + number(probe(run).cache_read_tokens), 0))
const weightedCacheRate = computed(() => totalInput.value ? totalCacheRead.value / totalInput.value : 0)
const lowHitCount = computed(() => filtered.value.filter(run => probe(run).cache_low_hit).length)

async function fetchPage(append = false) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const current = runs.value
    const before = append && current.length ? current[current.length - 1].started_at : undefined
    const page = await listReflectionRuns({ limit: 50, before })
    runs.value = append ? [...current, ...page] : page
    hasMore.value = page.length === 50
  } catch {
    error.value = t('reflection.readFailed')
  } finally {
    loading.value = false
  }
}
function refresh() { return fetchPage(false) }
function loadMore() { return fetchPage(true) }
function onTraceEvent(event: { session_key: string }) {
  if (event.session_key.startsWith('gugu:reflection:')) void refresh()
}
function fmt(value: number) { return formatCompactNumber(value) }
function percent(value: number) { return `${(value * 100).toFixed(1)}%` }
function duration(value: unknown) { return typeof value === 'number' ? `${Math.round(value)} ms` : '—' }
function requestStatus(value: Probe) {
  if (value.request_outcome === 'error') return `${t('reflection.failure')}${value.request_error_status ? ` · HTTP ${value.request_error_status}` : ''}`
  return value.request_outcome === 'success' ? t('reflection.requestSucceeded') : t('reflection.statusUnrecorded')
}
function gap(value: unknown) { return typeof value === 'number' ? `${Math.round(value)} ${t('reflection.seconds')}` : '—' }
function dateTime(value: unknown) {
  if (typeof value !== 'string') return t('reflection.unrecorded')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t('reflection.unrecorded') : date.toLocaleString(locale.value)
}
function anchors(run: TraceRun) { return wire(run).anchor_paths?.join(' · ') || t('reflection.anchorsPassive') }
function usageFields(run: TraceRun) {
  const value = probe(run).raw_usage_probe
  return value && typeof value === 'object' ? Object.keys(value).join(', ') : t('reflection.unrecorded')
}
function usageJson(run: TraceRun) {
  const value = probe(run).raw_usage_probe
  return value && typeof value === 'object' ? JSON.stringify(value, null, 2) : t('reflection.unrecorded')
}
function scopeLabel(value: unknown) {
  const keys: Record<string, string> = { owner: 'reflection.owner', private: 'reflection.private', group: 'reflection.group', member: 'reflection.member' }
  return keys[String(value)] ? t(keys[String(value)]!) : t('reflection.unknownScope')
}
function triggerLabel(value: unknown) {
  const keys: Record<string, string> = { threshold: 'reflection.threshold', idle: 'reflection.idle', background_job: 'reflection.background', session_snapshot: 'reflection.snapshot', direct: 'reflection.trigger' }
  return keys[String(value)] ? t(keys[String(value)]!) : t('reflection.unknownTrigger')
}
onMounted(() => {
  void refresh()
  stopEvents = subscribeTraceEvents(onTraceEvent)
})
onUnmounted(() => stopEvents?.())
</script>

<style scoped>
.reflection-page{max-width:1180px;margin:0 auto;padding:38px 32px 72px}.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--space-lg)}.eyebrow{font-size:var(--font-size-xs);letter-spacing:.12em;color:var(--content-tertiary)}h1{margin:5px 0;font-size:var(--font-size-xl)}.page-head p{margin:0;color:var(--content-secondary);font-size:var(--font-size-sm);line-height:var(--line-height-body);max-width:720px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-md);margin:var(--space-xl) 0}.metric{padding:var(--space-lg);display:grid;gap:5px}.metric span,.metric small{color:var(--content-secondary);font-size:var(--font-size-xs)}.metric strong{font-size:24px;font-variant-numeric:tabular-nums}.filters{position:relative;z-index:2;padding:var(--space-md) var(--space-lg);display:flex;align-items:center;gap:var(--space-lg);flex-wrap:wrap}.filter-field{display:flex;align-items:center;gap:var(--space-sm);font-size:var(--font-size-sm);color:var(--content-secondary)}.filter-note{margin-left:auto;color:var(--content-tertiary);font-size:var(--font-size-xs)}.sample-list{display:grid;gap:var(--space-md);margin-top:var(--space-lg)}.sample{padding:var(--space-lg)}.sample-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-md)}.sample-title{display:grid;grid-template-columns:9px 1fr;column-gap:var(--space-sm);align-items:center}.sample-title strong{font-size:var(--font-size-md)}.sample-title strong span{color:var(--content-tertiary);font-weight:400}.sample-title small{grid-column:2;color:var(--content-secondary);font-size:var(--font-size-xs);margin-top:3px}.status-dot{grid-row:1/3;width:8px;height:8px;border-radius:50%;background:var(--status-success)}.status-dot.low{background:var(--status-warning)}.sample-rate{font-size:var(--font-size-lg);font-weight:var(--font-weight-semibold);color:var(--status-success);font-variant-numeric:tabular-nums}.sample-rate.low{color:var(--status-warning)}.sample-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--space-sm);margin:var(--space-lg) 0}.sample-stats div{padding:var(--space-sm) var(--space-md);border-radius:var(--radius-sm);background:var(--surface-soft);display:grid;gap:4px}.sample-stats span{font-size:var(--font-size-xs);color:var(--content-secondary)}.sample-stats b{font-size:var(--font-size-sm);font-variant-numeric:tabular-nums}.wire-detail{border-top:1px solid var(--border-subtle);padding-top:var(--space-md)}summary{cursor:pointer;color:var(--action-primary);font-size:var(--font-size-sm);font-weight:var(--font-weight-medium)}dl{display:grid;gap:7px;margin:var(--space-md) 0 0}dl div{display:grid;grid-template-columns:130px minmax(0,1fr);gap:var(--space-md);font-size:var(--font-size-xs)}dt{color:var(--content-secondary)}dd{margin:0;overflow-wrap:anywhere}dd code{font-size:11px;color:var(--content-primary)}footer{display:flex;gap:var(--space-lg);margin-top:var(--space-md);font-size:10px;color:var(--content-tertiary)}.empty-state{padding:48px;display:grid;place-items:center;gap:var(--space-sm);color:var(--content-secondary)}.empty-state strong{color:var(--content-primary)}.more-row{text-align:center;margin-top:var(--space-lg)}.error-state{padding:var(--space-md);border-radius:var(--radius-sm);color:var(--status-danger);background:color-mix(in srgb,var(--status-danger) 10%,transparent)}@media(max-width:900px){.sample-stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:640px){.reflection-page{padding:var(--space-lg) var(--space-md) 48px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.sample-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.filter-note{width:100%;margin-left:0}dl div{grid-template-columns:100px minmax(0,1fr)}}
dd pre{margin:6px 0 0;padding:var(--space-md);max-height:260px;overflow:auto;border-radius:var(--radius-sm);background:var(--surface-soft);color:var(--content-primary);font-size:11px;line-height:var(--line-height-body)}
</style>
