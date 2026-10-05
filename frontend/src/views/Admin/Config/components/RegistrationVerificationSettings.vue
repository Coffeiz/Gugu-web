<template>
  <section id="sec-registration-verification" class="config-card registration-verification-card">
    <div class="card-head">
      <div class="card-icon">
        <Icon name="admin.mail" size="md" />
      </div>
      <div class="card-title-block">
        <h3>{{ t('configUi.registrationVerificationTitle') }}</h3>
        <p>{{ t('configUi.registrationVerificationHint') }}</p>
      </div>
      <div class="toggle-group compact-toggle" role="group" :aria-label="t('configUi.registrationVerificationTitle')">
        <button
          type="button"
          class="toggle-btn"
          :class="{ active: modelValue }"
          :disabled="!smtpConfigured"
          @click="$emit('update:modelValue', true)"
        >{{ t('configUi.enabled') }}</button>
        <button
          type="button"
          class="toggle-btn"
          :class="{ active: !modelValue }"
          :disabled="!smtpConfigured"
          @click="$emit('update:modelValue', false)"
        >{{ t('configUi.disabled') }}</button>
      </div>
    </div>
    <p class="setting-note">{{ t('configUi.registrationVerificationNote') }}</p>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
defineProps<{ modelValue: boolean; smtpConfigured: boolean }>()
defineEmits<{ (event: 'update:modelValue', value: boolean): void }>()

const { t } = useI18n()
</script>

<style scoped>
.registration-verification-card { display: flex; flex-direction: column; gap: 12px; }
.registration-verification-card .card-head { display: flex; align-items: center; gap: 13px; margin: 0; }
.registration-verification-card .card-icon { width: 38px; height: 38px; border-radius: 11px; background: color-mix(in srgb, var(--status-info) 14%, transparent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.registration-verification-card .card-icon :deep(svg) { width: 18px; height: 18px; color: var(--status-info); }
.card-title-block { min-width: 0; flex: 1; }
.card-title-block h3 { margin: 0; color: var(--content-primary); font-size: 14px; font-weight: 700; line-height: 1.4; }
.card-title-block p { margin: 2px 0 0; color: var(--content-secondary); font-size: 12px; line-height: 1.5; }
.toggle-group { display: flex; gap: 6px; }
.compact-toggle { flex-shrink: 0; }
.toggle-btn { padding: 6px 18px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.38); cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s; }
.toggle-btn.active { background: rgba(123,127,178,0.2); border-color: rgba(123,127,178,0.35); color: rgba(255,255,255,0.88); }
.toggle-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.toggle-btn:hover:not(.active):not(:disabled) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.6); }
.setting-note { margin: 0; color: var(--content-tertiary); font-size: 12px; line-height: 1.5; }
@media (max-width: 640px) { .registration-verification-card .card-head { align-items: flex-start; flex-wrap: wrap; } .compact-toggle { margin-left: 51px; } }
</style>
