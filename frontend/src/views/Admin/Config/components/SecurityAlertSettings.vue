<template>
  <section id="sec-security-alert" class="config-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:rgba(224,120,120,0.12);--stroke:#e07878">
        <Icon name="user.security" size="md" />
      </div>
      <div class="card-title-block">
        <h3>{{ t('configUi.securityTitle') }}</h3>
        <p>{{ t('configUi.securityHint') }}</p>
      </div>
      <div class="toggle-group compact-toggle">
        <button class="toggle-btn" :class="{ active: model.alert_email_enabled }" @click="update({ alert_email_enabled: true })">{{ t('configUi.enabled') }}</button>
        <button class="toggle-btn" :class="{ active: !model.alert_email_enabled }" @click="update({ alert_email_enabled: false })">{{ t('configUi.disabled') }}</button>
      </div>
    </div>

    <div class="field-grid">
      <div class="field span2">
        <span class="field-label">{{ t('configUi.alertEmail') }}</span>
        <input v-model="recipientText" class="field-input" :placeholder="t('configUi.alertEmailPlaceholder')" />
        <span class="field-hint" :class="{ error: invalidRecipients.length }">
          {{ invalidRecipients.length ? t('configUi.invalidEmail', { emails: invalidRecipients.join('、') }) : t('configUi.privacyHint') }}
        </span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

interface SecuritySettings {
  alert_email_enabled: boolean
  alert_email_recipients: string[]
}

const props = defineProps<{ modelValue: SecuritySettings }>()
const { t } = useI18n()
const emit = defineEmits<{ (event: 'update:modelValue', value: SecuritySettings): void }>()
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const model = computed(() => props.modelValue)
const recipientText = computed({
  get: () => model.value.alert_email_recipients.join(', '),
  set: (value: string) => update({ alert_email_recipients: normalize(value) }),
})
const invalidRecipients = computed(() => model.value.alert_email_recipients.filter(value => !emailPattern.test(value)))

function normalize(value: string) {
  return [...new Set(value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
}

function update(changes: Partial<SecuritySettings>) {
  emit('update:modelValue', { ...model.value, ...changes })
}
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
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.span2 { grid-column: span 2; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; color: rgba(255,255,255,0.55); }
.field-input { width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.11); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.86); outline: none; }
.field-input:focus { border-color: rgba(123,127,178,0.55); }
.field-hint { font-size: 11px; color: rgba(255,255,255,0.32); }
.field-hint.error { color: #e07878; }
@media (max-width: 700px) { .card-head { align-items: flex-start; flex-wrap: wrap; } .compact-toggle { margin-left: 51px; } }
</style>
