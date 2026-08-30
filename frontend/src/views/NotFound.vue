<template>
  <div class="nf-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="nf-card">
      <div class="nf-brand">
        <div class="brand-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 7h.01"/>
            <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
            <path d="M20 7l2 .5-2 .5"/>
            <path d="M10 18v3"/>
            <path d="M14 17.75V21"/>
            <path d="M7 18a6 6 0 0 0 3.84-10.61"/>
          </svg>
        </div>
        <span class="brand-name">{{ t('notFound.brand') }}</span>
      </div>

      <div class="nf-code">404</div>
      <div class="nf-title">{{ t('notFound.title') }}</div>
      <p class="nf-desc">{{ t('notFound.description') }}<br>{{ t('notFound.descriptionHint') }}</p>

      <div class="nf-actions">
        <button class="btn-primary" @click="goHome">{{ t('notFound.home') }}</button>
        <button class="btn-ghost" @click="goBack">{{ t('notFound.back') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const { t } = useI18n()
const goHome = () => router.push('/')
const goBack = () => (window.history.length > 1 ? router.back() : router.push('/'))
</script>

<style scoped>
.nf-page {
  min-height: 100vh;
  background: var(--surface-page, var(--bg-gradient, linear-gradient(160deg, #e8e9ee 0%, #d8dae4 35%, #bfc4d2 65%, #9aa2b8 100%)));
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-sans); position: relative; overflow: hidden;
}

.bg-glow { position: absolute; border-radius: 50%; pointer-events: none; filter: blur(80px); }
.glow-1 {
  width: 500px; height: 500px; top: -120px; left: -100px;
  background: radial-gradient(circle, color-mix(in srgb, var(--action-primary) 18%, transparent) 0%, transparent 65%);
}
.glow-2 {
  width: 380px; height: 380px; bottom: -100px; right: -80px;
  background: radial-gradient(circle, color-mix(in srgb, var(--status-info) 14%, transparent) 0%, transparent 65%);
}

.nf-card {
  width: 420px; max-width: calc(100vw - 40px); position: relative; z-index: 1;
  text-align: center;
  background: var(--surface-glass);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid var(--border-strong);
  border-radius: 20px; padding: 40px 36px;
  box-shadow: var(--elevation-window);
}

.nf-brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 22px; }
.brand-icon {
  width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;
  background: var(--brand-gradient);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--action-primary) 35%, transparent);
}
.brand-name { font-size: 17px; font-weight: 700; color: var(--content-primary); }

.nf-code {
  font-size: 84px; font-weight: 800; line-height: 1; letter-spacing: 0.02em;
  background: var(--brand-gradient);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  margin-bottom: 14px;
}
.nf-title { font-size: 19px; font-weight: 700; color: var(--content-primary); margin-bottom: 10px; }
.nf-desc { font-size: 13.5px; line-height: 1.7; color: var(--content-secondary); margin: 0 0 26px; }

.nf-actions { display: flex; gap: 10px; justify-content: center; }
.btn-primary {
  padding: 10px 22px;
  background: var(--action-primary-bg);
  border: none; border-radius: 11px;
  font-size: 14px; font-weight: 600; color: var(--content-on-accent);
  cursor: pointer; transition: opacity 0.15s, transform 0.15s;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--action-primary) 32%, transparent);
}
.btn-primary:hover { background: var(--action-primary-bg-hover); transform: translateY(-1px); }
.btn-ghost {
  padding: 10px 22px;
  background: var(--control-bg); border: 1px solid var(--control-border);
  border-radius: 11px; font-size: 14px; font-weight: 600; color: var(--control-fg);
  cursor: pointer; transition: background 0.15s, transform 0.15s;
}
.btn-ghost:hover { background: var(--control-bg-hover); color: var(--control-fg-strong); transform: translateY(-1px); }
</style>
