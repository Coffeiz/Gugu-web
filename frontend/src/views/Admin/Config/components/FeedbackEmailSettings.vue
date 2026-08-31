<template>
  <section id="sec-feedback-email" class="config-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:rgba(90,184,153,0.12);--stroke:#5ab899">
        <Icon name="admin.mail" size="md" />
      </div>
      <div class="card-title-block">
        <h3>{{ t('configUi.feedbackTitle') }}</h3>
        <p>{{ t('configUi.feedbackHint') }}</p>
      </div>
      <div class="toggle-group compact-toggle">
        <button class="toggle-btn" :class="{ active: enabled }" @click="$emit('update:enabled', true)">{{ t('configUi.enabled') }}</button>
        <button class="toggle-btn" :class="{ active: !enabled }" @click="$emit('update:enabled', false)">{{ t('configUi.disabled') }}</button>
      </div>
    </div>

    <div class="field">
      <span class="field-label">{{ t('configUi.supportEmail') }}</span>
      <input
        class="field-input"
        :value="email"
        type="email"
        placeholder="support@example.com"
        @input="$emit('update:email', ($event.target as HTMLInputElement).value)"
      />
      <span class="field-hint">{{ t('configUi.smtpRequired') }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
defineProps<{
  enabled: boolean
  email: string
}>()

defineEmits<{
  (event: 'update:enabled', value: boolean): void
  (event: 'update:email', value: string): void
}>()
</script>

<style scoped>
.config-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 22px 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06); }
.card-head { display: flex; align-items: center; gap: 13px; margin-bottom: 20px; }
.card-icon { width: 38px; height: 38px; border-radius: 11px; background: var(--ic); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.card-title-block { flex: 1; }
.card-title-block h3 { font-size: 14px; font-weight: 700; color: rgba(255,255,255,0.88); }
.card-title-block p { font-size: 12px; color: rgba(255,255,255,0.38); margin-top: 2px; }
.toggle-group { display: flex; gap: 6px; }
.compact-toggle { flex-shrink: 0; }
.toggle-btn { padding: 6px 18px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.38); cursor: pointer; }
.toggle-btn.active { background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35); color: rgba(255,255,255,0.88); }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; color: rgba(255,255,255,0.55); }
.field-input { width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.11); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.86); outline: none; }
.field-input:focus { border-color: rgba(123,127,178,0.55); }
.field-hint { font-size: 11px; color: rgba(255,255,255,0.32); }
@media (max-width: 700px) { .card-head { align-items: flex-start; flex-wrap: wrap; } .compact-toggle { margin-left: 51px; } }
</style>
