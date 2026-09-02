<template>
  <div class="privacy-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />
    <div class="privacy-card">
      <div class="privacy-header">
        <router-link to="/login" class="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          {{ t('privacyUi.back') }}
        </router-link>
        <div class="header-brand">{{ t('privacyUi.title') }}</div>
        <AuthLanguageSwitcher />
      </div>
      <div class="privacy-body md-content" v-html="html" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import { sanitizeHtml } from '@/utils/markdown'
import { useI18n } from 'vue-i18n'
import AuthLanguageSwitcher from '@/components/common/auth/AuthLanguageSwitcher.vue'
import { privacyPolicy } from '@/i18n/privacyPolicy'

const { t, locale } = useI18n()
const html = computed(() => sanitizeHtml(marked(privacyPolicy[locale.value as keyof typeof privacyPolicy]) as string))
</script>

<style scoped>
.privacy-page { position: fixed; inset: 0; overflow-y: auto; background: var(--bg-gradient, linear-gradient(160deg, #e8e9ee 0%, #d8dae4 35%, #bfc4d2 65%, #9aa2b8 100%)); display: flex; align-items: flex-start; justify-content: center; font-family: var(--font-sans); padding: 40px 16px 60px; }
.bg-glow { position: fixed; border-radius: 50%; pointer-events: none; filter: blur(80px); }
.glow-1 { width: 500px; height: 500px; top: -120px; left: -100px; background: radial-gradient(circle, rgba(123,127,178,0.18) 0%, transparent 65%); }
.glow-2 { width: 380px; height: 380px; bottom: -100px; right: -80px; background: radial-gradient(circle, rgba(196,175,200,0.14) 0%, transparent 65%); }
.privacy-card { width: 100%; max-width: 760px; position: relative; z-index: 1; background: rgba(255,255,255,0.56); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.76); border-radius: 20px; box-shadow: 0 20px 60px rgba(80,90,110,0.12), inset 0 1px 0 rgba(255,255,255,0.95), inset 1px 0 0 rgba(255,255,255,0.55); overflow: hidden; }
.privacy-header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding: 14px 22px; background: rgba(255,255,255,0.5); border-bottom: 1px solid rgba(0,0,0,0.06); }
.privacy-header :deep(.language-switcher) { justify-content: flex-end; }
.back-link { display: flex; align-items: center; gap: 5px; justify-self: start; font-size: 13px; color: var(--text-secondary, #6b7280); text-decoration: none; transition: color 0.15s; }
.back-link:hover { color: var(--text-primary, #1a1d27); }
.header-brand { justify-self: center; font-size: 13px; font-weight: 600; color: var(--text-secondary, #6b7280); }
.privacy-body { padding: 32px 36px 40px; }
.md-content :deep(h1) { font-size: 22px; font-weight: 700; color: var(--text-primary, #1a1d27); margin: 0 0 6px; }
.md-content :deep(h2) { font-size: 17px; font-weight: 700; color: var(--text-primary, #1a1d27); margin: 26px 0 10px; }
.md-content :deep(h3) { font-size: 14px; font-weight: 650; color: var(--text-primary, #1a1d27); margin: 18px 0 7px; }
.md-content :deep(p), .md-content :deep(li) { font-size: 13px; line-height: 1.75; color: var(--text-primary, #1a1d27); }
.md-content :deep(p) { margin: 7px 0 10px; }
.md-content :deep(ul) { margin: 4px 0 10px; padding-left: 20px; }
.md-content :deep(li) { margin-bottom: 3px; }
.md-content :deep(blockquote) { margin: 4px 0 20px; padding: 0; border: none; font-size: 12px; color: var(--text-secondary, #6b7280); }
.md-content :deep(strong) { font-weight: 600; }
.md-content :deep(code) { font-family: var(--font-family-mono); font-size: 12px; background: rgba(0,0,0,0.05); border-radius: 4px; padding: 1px 5px; }
.md-content :deep(table) { width: 100%; border-collapse: collapse; font-size: 13px; margin: 10px 0 14px; }
.md-content :deep(th) { text-align: left; font-weight: 600; padding: 7px 12px; background: rgba(0,0,0,0.04); border-bottom: 1px solid rgba(0,0,0,0.08); }
.md-content :deep(td) { padding: 7px 12px; border-bottom: 1px solid rgba(0,0,0,0.05); color: var(--text-primary, #1a1d27); }
.md-content :deep(a) { color: #7b7fb2; text-decoration: none; }
.md-content :deep(a:hover) { text-decoration: underline; }
@media (max-width: 620px) {
  .privacy-page { padding: 16px 8px 28px; }
  .privacy-header { grid-template-columns: 1fr auto; }
  .header-brand { grid-column: 1 / -1; grid-row: 1; }
  .back-link { grid-row: 2; }
  .privacy-header :deep(.language-switcher) { grid-row: 2; }
  .privacy-body { padding: 24px 20px 30px; }
}
</style>
