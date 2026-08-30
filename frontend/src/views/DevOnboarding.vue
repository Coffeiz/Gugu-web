<template>
  <main class="onb-dev">
    <header class="page-head">
      <div><p class="eyebrow">DEVELOPER · ONBOARDING</p><h1>{{ t('devOnboarding.title') }}</h1><p class="intro">{{ t('devOnboarding.description') }}</p></div>
      <code>/dev/onboarding</code>
    </header>

    <section class="hero-card">
      <div class="hero-copy"><span class="hero-mark">✦</span><div><h2>{{ state?.seeded ? t('devOnboarding.seeded') : t('devOnboarding.notSeeded') }}</h2><p>{{ state?.seeded ? t('devOnboarding.reseedHint') : t('devOnboarding.description') }}</p></div></div>
      <div class="actions"><button class="button button-ghost" @click="refresh">{{ t('devOnboarding.refresh') }}</button><button class="button button-primary" :disabled="busy" @click="reseed">{{ busy ? t('devOnboarding.reseedStarted') : t('devOnboarding.reseed') }}</button></div>
    </section>

    <section class="status-grid">
      <article class="status-card"><span class="status-icon">⌂</span><div><p class="card-label">{{ t('devOnboarding.project') }}</p><strong>{{ state?.seeded ? t('devOnboarding.projectKept') : t('devOnboarding.notSeeded') }}</strong><small>{{ t('devOnboarding.projectId') }}：{{ state?.seeded_project_id ?? '—' }}</small></div></article>
      <article class="status-card"><span class="status-icon">♫</span><div><p class="card-label">{{ t('devOnboarding.mp3') }}</p><strong>{{ t('devOnboarding.projectKept') }}</strong><small>{{ t('devOnboarding.reseedHint') }}</small></div></article>
      <article class="status-card muted"><span class="status-icon">◌</span><div><p class="card-label">{{ t('devOnboarding.bubble') }}</p><strong>{{ t('devOnboarding.bubbleRemoved') }}</strong><small>{{ t('devOnboarding.description') }}</small></div></article>
    </section>

    <section class="state-card"><div class="section-head"><div><p class="eyebrow">INSPECT</p><h2>{{ t('devOnboarding.state') }}</h2></div><span class="state-dot" :class="{ ready: !!state }"></span></div><pre>{{ stateText }}</pre></section>
    <p v-if="msg" class="feedback" role="status">{{ msg }}</p>
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { onboardingApi } from '@/services/api'

const { t } = useI18n()
const state = ref<Record<string, any> | null>(null)
const msg = ref('')
const busy = ref(false)
const stateText = computed(() => state.value ? JSON.stringify(state.value, null, 2) : t('devOnboarding.loading'))

async function refresh() {
  try { state.value = await onboardingApi.getState() } catch { msg.value = t('devOnboarding.refreshFailed') }
}
async function reseed() {
  busy.value = true; msg.value = t('devOnboarding.reseedStarted')
  try { const r = await onboardingApi.devReseed(); state.value = r.state; msg.value = t('devOnboarding.reseedDone') } catch { msg.value = t('devOnboarding.reseedFailed') } finally { busy.value = false }
}

onMounted(refresh)
</script>

<style scoped>
.onb-dev { max-width: 1080px; margin: 0 auto; padding: clamp(24px, 4vw, 52px) clamp(18px, 4vw, 48px); color: var(--content-primary); }
.page-head, .hero-card, .section-head, .hero-copy, .actions, .status-card { display: flex; align-items: center; }
.page-head { justify-content: space-between; gap: 24px; margin-bottom: 28px; } h1, h2, p { margin: 0; } h1 { font-size: clamp(25px, 3vw, 34px); letter-spacing: -.03em; } h2 { font-size: 18px; } .eyebrow { color: var(--content-tertiary); font-size: 10px; font-weight: 750; letter-spacing: .14em; margin-bottom: 8px; } .intro { color: var(--content-secondary); font-size: 13px; line-height: 1.65; margin-top: 8px; max-width: 650px; } code { color: var(--content-tertiary); font: 11px var(--font-family-mono); background: var(--surface-soft); border: 1px solid var(--border-subtle); padding: 7px 10px; border-radius: var(--radius-sm); }
.hero-card, .status-card, .state-card { border: 1px solid var(--border-default); background: var(--surface-glass); box-shadow: var(--elevation-card); border-radius: var(--card-radius); } .hero-card { justify-content: space-between; gap: 24px; padding: 22px 24px; margin-bottom: 16px; } .hero-copy { gap: 14px; } .hero-mark, .status-icon { display: grid; place-items: center; color: var(--theme-action-primary); background: var(--theme-selection); border-radius: var(--radius-md); } .hero-mark { width: 42px; height: 42px; font-size: 20px; } .hero-copy p, .status-card small { display: block; color: var(--content-secondary); font-size: 12px; line-height: 1.55; margin-top: 5px; } .actions { gap: 8px; } .button { border: 1px solid var(--border-default); border-radius: var(--control-radius); padding: 9px 13px; font-size: 12px; cursor: pointer; transition: transform var(--motion-hover-control) var(--motion-ease-standard), background var(--motion-hover-control) var(--motion-ease-standard); } .button:hover:not(:disabled) { transform: translateY(-1px); } .button:active:not(:disabled) { transform: translateY(1px); } .button-ghost { color: var(--content-secondary); background: var(--control-bg); } .button-primary { color: var(--content-on-accent); border-color: transparent; background: var(--action-primary); } .button:disabled { cursor: wait; opacity: .6; }
.status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; } .status-card { align-items: flex-start; gap: 12px; padding: 18px; min-height: 108px; } .status-icon { flex: 0 0 30px; width: 30px; height: 30px; font-size: 15px; } .card-label { color: var(--content-tertiary); font-size: 11px; letter-spacing: .04em; } .status-card strong { display: block; margin-top: 6px; font-size: 14px; } .status-card small { color: var(--content-tertiary); font-size: 11px; } .status-card.muted { opacity: .78; }
.state-card { padding: 20px 22px; } .section-head { justify-content: space-between; margin-bottom: 14px; } .section-head h2 { margin-top: 0; } .state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-warning); } .state-dot.ready { background: var(--status-success); } pre { margin: 0; padding: 16px; max-height: 420px; overflow: auto; white-space: pre-wrap; color: var(--content-secondary); background: var(--surface-soft); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); font: 11px/1.65 var(--font-family-mono); } .feedback { margin-top: 12px; color: var(--status-success); font-size: 12px; }
@media (max-width: 700px) { .page-head, .hero-card { align-items: flex-start; flex-direction: column; } .page-head code { display: none; } .actions { width: 100%; } .button { flex: 1; } .status-grid { grid-template-columns: 1fr; } }
</style>
