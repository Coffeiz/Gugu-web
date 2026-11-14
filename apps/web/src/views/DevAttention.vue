<template>
  <main class="attention-lab">
    <header class="page-heading">
      <div><p class="eyebrow">{{ t('devAttention.eyebrow') }}</p><h1>{{ t('devAttention.title') }}</h1><p class="intro">{{ t('devAttention.intro') }}</p></div>
      <div class="heading-actions">
        <button class="reset-button" type="button" @click="reset">
          <Icon name="action.refresh" size="sm" />
          <span>{{ t('devAttention.reset') }}</span>
        </button>
      </div>
    </header>

    <section class="workspace">
      <div class="panel input-panel">
        <h2>{{ t('devAttention.inputTitle') }}</h2>
        <div class="field-grid">
          <div class="field mode-field"><span id="mode-label" class="field-title">{{ t('devAttention.mode') }}</span><SelectPopup v-model="mode" :options="modeOptions" aria-labelledby="mode-label" trigger-class="attention-mode-trigger" auto-flip /></div>
          <div class="field"><span id="alias-label" class="field-title">{{ t('devAttention.aliases') }}</span><input v-model="aliases" class="form-input" aria-labelledby="alias-label" :placeholder="t('devAttention.aliasPlaceholder')" /></div>
          <div class="field"><span id="gap-label" class="field-title">{{ t('devAttention.gapSeconds') }}</span><input v-model.number="gapSeconds" type="number" min="0" max="600" class="form-input number-input" aria-labelledby="gap-label" /></div>
          <div class="field"><span id="member-active-label" class="field-title">{{ t('devAttention.memberActiveAge') }}</span><input v-model.number="memberActiveAgeSeconds" type="number" min="0" max="600" class="form-input number-input" aria-labelledby="member-active-label" :placeholder="t('devAttention.memberActiveDisabled')" /></div>
        </div>

        <section class="conversation-section">
          <div class="section-heading"><h3>{{ t('devAttention.conversationTitle') }}</h3><span>{{ t('devAttention.conversationHint') }}</span></div>
          <div class="field"><span id="message-label" class="field-title">{{ t('devAttention.message') }}</span><textarea v-model="message" aria-labelledby="message-label" class="form-input message-input control-resizable" :placeholder="t('devAttention.messagePlaceholder')" rows="3" /></div>
          <div class="field"><span id="anchor-message-label" class="field-title">{{ t('devAttention.anchorMessage') }}</span><textarea v-model="anchorMessage" aria-labelledby="anchor-message-label" class="form-input message-input control-resizable" :placeholder="t('devAttention.anchorMessagePlaceholder')" rows="3" /></div>
          <div class="conversation-grid">
            <div class="field"><span id="before-anchor-label" class="field-title">{{ t('devAttention.beforeAnchor') }}</span><textarea v-model="beforeAnchor" aria-labelledby="before-anchor-label" class="form-input message-input control-resizable" rows="4" /></div>
            <div class="field"><span id="after-anchor-label" class="field-title">{{ t('devAttention.afterAnchor') }}</span><textarea v-model="afterAnchor" aria-labelledby="after-anchor-label" class="form-input message-input control-resizable" rows="4" /></div>
          </div>
        </section>
        <label class="check-row"><input v-model="snapshotComplete" type="checkbox" /><span>{{ t('devAttention.snapshotCompleteInput') }}</span></label>
      </div>

      <aside class="panel result-panel" aria-live="polite">
        <div class="result-topline" :class="{ 'has-error': error }">
          <div><p class="eyebrow">{{ t('devAttention.resultTitle') }}</p><h2>{{ outcomeLabel }}</h2></div>
          <button v-if="error" class="button-secondary retry-button" type="button" :disabled="loading" @click="retryConnection">{{ loading ? t('devAttention.calculating') : t('devAttention.retry') }}</button>
          <div class="score-circle" :class="result?.kind.toLowerCase()"><strong>{{ formatScore(result?.score) }}</strong><span>/ 100</span></div>
        </div>
        <p class="result-note">{{ error || resultNote }}</p>
        <div class="status-list">
          <div><span>{{ t('devAttention.algorithmVersion') }}</span><strong>{{ result?.algorithm_version ?? defaults?.algorithm_version ?? '—' }}</strong></div>
          <div><span>{{ t('devAttention.state') }}</span><strong>{{ result?.state ? t(`devAttention.${result.state.toLowerCase()}`) : '—' }}</strong></div>
          <div><span>{{ t('devAttention.scene') }}</span><strong>{{ sceneLabel }}</strong></div>
          <div><span>{{ t('devAttention.sceneScore') }}</span><strong>{{ formatWeight(result?.scene_score) }}</strong></div>
          <template v-if="result?.ask_raw_score">
            <div><span>{{ t('devAttention.askRawScore') }}</span><strong>{{ formatWeight(result.ask_raw_score) }}</strong></div>
            <div><span>{{ t('devAttention.askPositionWeight') }}</span><strong>{{ formatWeight(result.ask_position_weight) }}</strong></div>
            <div><span>{{ t('devAttention.askPunctuationWeight') }}</span><strong>{{ formatWeight(result.ask_punctuation_weight) }}</strong></div>
            <div><span>{{ t('devAttention.askAdjustedScore') }}</span><strong>{{ formatWeight(result.ask_adjusted_score) }}</strong></div>
            <div><span>{{ t('devAttention.askPosition') }}</span><strong>{{ formatSpan(result.ask_span_start, result.ask_span_end) }}</strong></div>
          </template>
          <template v-if="result?.capability_strength">
            <div><span>{{ t('devAttention.capabilityStrength') }}</span><strong>{{ result.capability_strength }}</strong></div>
            <div><span>{{ t('devAttention.capabilityPositionWeight') }}</span><strong>{{ formatWeight(result.capability_position_weight ?? undefined) }}</strong></div>
            <div><span>{{ t('devAttention.capabilityPosition') }}</span><strong>{{ formatSpan(result.capability_span_start, result.capability_span_end) }}</strong></div>
          </template>
          <div><span>{{ t('devAttention.topicScore') }}</span><strong>{{ formatWeight(result?.topic_score) }}</strong></div>
          <div><span>{{ t('devAttention.rawTopicScore') }}</span><strong>{{ formatWeight(result?.topic_raw_score) }}</strong></div>
          <div><span>{{ t('devAttention.threshold') }}</span><strong>{{ result?.threshold == null ? t('devAttention.notScored') : result.threshold }}</strong></div>
          <div><span>{{ t('devAttention.snapshot') }}</span><strong>{{ result ? (result.snapshot_complete ? t('devAttention.complete') : t('devAttention.incomplete')) : '—' }}</strong></div>
          <div><span>{{ t('devAttention.spanLengths') }}</span><strong>{{ result?.matched_span_lengths?.join(' / ') ?? '—' }}</strong></div>
        </div>
        <section class="breakdown"><h3>{{ t('devAttention.reasons') }}</h3><p v-if="error" class="empty-state">{{ t('devAttention.apiUnavailable') }}</p><p v-else-if="!result?.reasons.length" class="empty-state">{{ loading ? t('devAttention.calculating') : t('devAttention.noRules') }}</p><div v-for="reason in result?.reasons ?? []" :key="reason" class="breakdown-row"><code>{{ reason }}</code></div></section>
        <p class="scope-note">{{ t('devAttention.scopeNote') }}</p>
      </aside>
    </section>

    <section v-if="defaults" class="panel weights-panel"><div class="section-heading"><div><h2>{{ defaults.algorithm_version }}</h2><p>{{ t('devAttention.parametersHint') }}</p></div></div><div class="similarity-parameter-grid"><div><span>{{ t('devAttention.topicTtl') }}</span><strong>{{ defaults.topic_ttl_seconds }}s</strong></div><div><span>{{ t('devAttention.halfLife') }}</span><strong>{{ defaults.topic_half_life_seconds }}s</strong></div><div><span>{{ t('devAttention.memberActiveTtl') }}</span><strong>{{ defaults.member_active_ttl_seconds }}s</strong></div><div v-for="name in thresholdNames" :key="name"><span>{{ t(`devAttention.mode${name[0].toUpperCase()}${name.slice(1)}`) }}</span><strong>{{ defaults.thresholds[name] }}</strong></div></div></section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { attentionSandboxApi } from './devAttention/api'
import type { AttentionDefaults, AttentionInput, AttentionMode, AttentionResult } from './devAttention/scoring'

const { t } = useI18n()
const mode = ref<AttentionMode>('natural')
const aliases = ref('咕咕')
const message = ref('他哪会翻跟斗')
const anchorMessage = ref('翻个跟斗——来了，落地了')
const beforeAnchor = ref('')
const afterAnchor = ref('')
const gapSeconds = ref(124)
const memberActiveAgeSeconds = ref<number | null>(null)
const snapshotComplete = ref(true)
const defaults = ref<AttentionDefaults | null>(null)
const result = ref<AttentionResult | null>(null)
const loading = ref(false)
const error = ref('')
const thresholdNames = ['quiet', 'natural', 'active'] as const
const modeOptions = computed(() => [
  { value: 'natural', label: t('devAttention.modeNatural') },
  { value: 'active', label: t('devAttention.modeActive') },
  { value: 'quiet', label: t('devAttention.modeQuiet') },
  { value: 'autonomous', label: t('devAttention.modeAutonomous') },
])
const outcomeLabel = computed(() => error.value ? t('devAttention.apiUnavailable') : result.value ? t(`devAttention.kind.${result.value.kind}`) : t('devAttention.waiting'))
const sceneLabel = computed(() => result.value?.scene_type ? t(`devAttention.${result.value.scene_type.toLowerCase()}`) : '—')
const resultNote = computed(() => {
  if (!result.value) return t('devAttention.connecting')
  return result.value.reasons.map((reason) => reason).join(' · ')
})

let timer: ReturnType<typeof setTimeout> | undefined
let requestSequence = 0
function lines(value: string): string[] { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 5) }
async function calculate() {
  const sequence = ++requestSequence
  loading.value = true
  error.value = ''
  const payload: AttentionInput = {
    text: message.value, anchor_text: anchorMessage.value,
    before_anchor: lines(beforeAnchor.value), after_anchor: lines(afterAnchor.value),
    gap_seconds: Math.max(0, Math.min(600, gapSeconds.value || 0)),
    member_active_age_seconds: memberActiveAgeSeconds.value,
    aliases: aliases.value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
    mode: mode.value, snapshot_complete: snapshotComplete.value,
  }
  try {
    const response = await attentionSandboxApi.score(payload)
    if (sequence === requestSequence) result.value = response
  } catch (cause) {
    if (sequence === requestSequence) error.value = cause instanceof Error ? cause.message : '无法连接开发算法接口。'
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}
function scheduleCalculate() { if (timer) clearTimeout(timer); timer = setTimeout(() => { void calculate() }, 180) }
async function retryConnection() {
  loading.value = true
  error.value = ''
  try { defaults.value = await attentionSandboxApi.defaults(); await calculate() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '无法读取开发算法默认值。' }
  finally { loading.value = false }
}
function reset() {
  mode.value = 'natural'; aliases.value = '咕咕'; message.value = '他哪会翻跟斗'
  anchorMessage.value = '翻个跟斗——来了，落地了'; beforeAnchor.value = ''; afterAnchor.value = ''
  gapSeconds.value = 124; memberActiveAgeSeconds.value = null; snapshotComplete.value = true; scheduleCalculate()
}
onMounted(() => { void retryConnection() })
watch([mode, aliases, message, anchorMessage, beforeAnchor, afterAnchor, gapSeconds, memberActiveAgeSeconds, snapshotComplete], scheduleCalculate)
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
function formatWeight(value: number | undefined) { return value == null ? '—' : value.toFixed(3) }
function formatSpan(start: number | null, end: number | null) { return start == null || end == null ? '—' : `${start}–${end}` }
function formatScore(value: number | null | undefined) { return value == null ? '—' : value.toFixed(2) }
</script>

<style scoped>
.attention-lab { display: grid; gap: var(--space-lg); padding: var(--space-lg); color: var(--content-primary); }
.page-heading, .workspace { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(300px, .8fr); gap: var(--space-lg); align-items: start; }
.page-heading { align-items: center; }
.heading-actions { display: flex; justify-content: flex-end; align-self: start; }
.page-heading h1 { margin: 0; font-size: 1.5rem; }
.eyebrow { margin: 0 0 var(--space-xs); color: var(--content-tertiary); font-size: .75rem; letter-spacing: .06em; }
.intro { color: var(--content-secondary); }
.panel { min-width: 0; padding: var(--space-lg); border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--surface-card); box-shadow: var(--shadow-sm); }
.reset-button { display: inline-flex; min-height: 36px; align-items: center; justify-content: center; gap: var(--space-xs); padding: 0 var(--space-md); border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--surface-glass); color: var(--content-secondary); font: inherit; font-size: .82rem; cursor: pointer; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
.reset-button:hover { border-color: var(--border-focus); background: var(--surface-glass-hover); color: var(--content-primary); }
.reset-button:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.reset-button :deep(.app-icon) { font-size: .95rem; }
.input-panel h2, .weights-panel h2 { margin: 0 0 var(--space-md); font-size: 1rem; }
.field-grid, .conversation-grid, .similarity-parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-md); }
.field-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field { display: grid; gap: var(--space-xs); min-width: 0; margin-bottom: var(--space-md); }
.field-title { color: var(--content-secondary); font-size: .8rem; }
.message-input { min-height: 5rem; resize: vertical; }
.conversation-section { display: grid; gap: var(--space-sm); margin-top: var(--space-lg); }
.section-heading, .result-topline { display: flex; justify-content: space-between; gap: var(--space-md); align-items: center; }
.section-heading h3, .breakdown h3 { margin: 0; font-size: .95rem; }
.section-heading span, .section-heading p, .scope-note { color: var(--content-tertiary); font-size: .78rem; }
.check-row { display: flex; gap: var(--space-sm); align-items: center; color: var(--content-secondary); font-size: .82rem; }
.result-panel { position: sticky; top: var(--space-md); }
.result-topline h2 { margin: 0; font-size: 1.15rem; }
.score-circle { width: 76px; height: 76px; display: grid; place-content: center; border: 2px solid var(--border-default); border-radius: 50%; text-align: center; }
.score-circle strong { font-size: 1.1rem; }
.score-circle span { color: var(--content-tertiary); font-size: .7rem; }
.result-note { min-height: 2rem; color: var(--content-secondary); }
.status-list { display: grid; gap: var(--space-xs); }
.status-list > div, .similarity-parameter-grid > div { display: flex; justify-content: space-between; gap: var(--space-sm); padding: var(--space-xs) 0; border-bottom: 1px solid var(--content-divider); font-size: .8rem; }
.status-list span, .similarity-parameter-grid span { color: var(--content-tertiary); }
.status-list strong { text-align: right; overflow-wrap: anywhere; }
.breakdown { margin-top: var(--space-md); }
.breakdown-row { padding: var(--space-xs) 0; }
.breakdown code { color: var(--content-secondary); }
.empty-state { color: var(--content-tertiary); font-size: .82rem; }
.scope-note { margin-top: var(--space-md); line-height: 1.5; }
.weights-panel { grid-column: 1 / -1; }
.similarity-parameter-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
@media (max-width: 900px) { .page-heading, .workspace { grid-template-columns: 1fr; } .result-panel { position: static; } }
@media (max-width: 640px) { .field-grid, .conversation-grid, .similarity-parameter-grid { grid-template-columns: 1fr; } .attention-lab { padding: var(--space-md); } }
</style>
