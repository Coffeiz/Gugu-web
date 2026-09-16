<template>
  <div class="interaction-bubble">
    <div class="interaction-title">{{ msg.interaction?.title || t('chatUi.confirmRequired') }}</div>
    <div class="interaction-body">{{ msg.interaction?.body }}</div>
    <!-- 空 options 的存量提问（兜底按钮上线前创建的）不渲染空按钮区，避免悬空分隔线 -->
    <div v-if="displayOptions.length" class="interaction-actions">
      <ActionButton v-for="option in displayOptions" :key="option.id" class="interaction-option" fit
                    :disabled="resolved || submitting || expired" @click="selectOption(option)">
        {{ option.label }}
      </ActionButton>
    </div>
    <form v-if="secretFields.length && !resolved" class="interaction-secrets" @submit.prevent="submitSecrets">
      <label v-for="field in secretFields" :key="field.name" class="interaction-secret-field">
        <span>{{ field.label }}</span>
        <input v-model="secretValues[field.name]" type="password" autocomplete="new-password"
               :name="`mcp-secret-${field.name}`" :disabled="submitting || expired"
               spellcheck="false" required />
      </label>
      <ActionButton class="interaction-secret-submit" fit type="submit"
                    :disabled="resolved || submitting || expired || !secretsReady">
        {{ t('chatUi.submitSecretFields') }}
      </ActionButton>
    </form>
    <div v-if="customInputActive" class="interaction-custom-hint">{{ t('chatUi.customReplyHint') }}</div>
    <div v-if="resolved && msg.interaction?.responseText" class="interaction-response">
      {{ msg.interaction.responseText }}
    </div>
    <div v-if="submitting" class="interaction-resolved">{{ t('chatUi.confirmationSubmitting') }}</div>
    <div v-else-if="expired" class="interaction-resolved">{{ t('chatUi.expired') }}</div>
    <div v-else-if="resolved && isPausedConfirmation && msg.interaction?.selectedOptionId === 'confirm'" class="interaction-resolved">
      {{ t('chatUi.confirmationConfirmed') }}
    </div>
    <div v-else-if="resolved && isPausedConfirmation && msg.interaction?.selectedOptionId === 'cancel'" class="interaction-resolved">
      {{ t('chatUi.confirmationCancelled') }}
    </div>
    <div v-else-if="resolved" class="interaction-resolved">{{ t('chatUi.submitted') }}</div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { CUSTOM_REPLY_OPTION_ID, type ChatMessage } from './chatTypes'

const props = defineProps<{ msg: ChatMessage }>()
const resolved = ref(Boolean(props.msg.interaction?.resolved))
const submitting = ref(Boolean(props.msg.interaction?.submitting))
const initiallyExpired = Boolean(
  props.msg.interaction?.expired
  || (!props.msg.interaction?.selectedOptionId
    && props.msg.interaction?.expiresAt
    && new Date(props.msg.interaction.expiresAt).getTime() <= Date.now()),
)
const expired = ref(initiallyExpired)
let expiryTimer: ReturnType<typeof setTimeout> | undefined
const customInputActive = computed(() => Boolean(props.msg.interaction?.customInputActive))
const isPausedConfirmation = computed(() => Boolean(
  props.msg.interaction?.taskPaused
  || (props.msg.interaction?.kind === 'confirm' && props.msg.interaction?.toolCallId),
))
const displayOptions = computed(() => (props.msg.interaction?.options || [])
  .filter(option => !(option.id === CUSTOM_REPLY_OPTION_ID && customInputActive.value))
  .map(option => option.id === CUSTOM_REPLY_OPTION_ID
    ? { ...option, label: t('chatUi.customReply') }
    : option))
const secretFields = computed(() => (props.msg.interaction?.secretFields || [])
  .filter(field => field && field.name))
const secretValues = ref<Record<string, string>>({})
const secretsReady = computed(() => secretFields.value.length > 0
  && secretFields.value.every(field => Boolean(secretValues.value[field.name]?.trim())))
const emit = defineEmits<{
  select: [msg: ChatMessage, option: { id: string; label: string; token: string }]
  secretSubmit: [msg: ChatMessage, values: Record<string, string>]
}>()
function submitSecrets() {
  if (!secretsReady.value || resolved.value || submitting.value || expired.value) return
  submitting.value = true
  if (props.msg.interaction) props.msg.interaction.submitting = true
  emit('secretSubmit', props.msg, Object.fromEntries(
    secretFields.value.map(field => [field.name, secretValues.value[field.name] || '']),
  ))
}
function selectOption(option: { id: string; label: string; token: string }) {
  if (resolved.value || submitting.value || expired.value) return
  submitting.value = true
  if (props.msg.interaction) props.msg.interaction.submitting = true
  emit('select', props.msg, option)
}
function markExpired() {
  if (resolved.value) return
  expired.value = true
  resolved.value = true
  if (props.msg.interaction) {
    props.msg.interaction.expired = true
    props.msg.interaction.resolved = true
  }
}
function scheduleExpiry() {
  if (expiryTimer) clearTimeout(expiryTimer)
  const value = props.msg.interaction?.expiresAt
  if (!value || resolved.value) return
  const remaining = new Date(value).getTime() - Date.now()
  if (remaining <= 0) { markExpired(); return }
  expiryTimer = setTimeout(markExpired, remaining)
}
watch(() => props.msg.interaction?.resolved, (value) => {
  resolved.value = Boolean(value)
  scheduleExpiry()
})
watch(() => props.msg.interaction?.submitting, (value) => {
  submitting.value = Boolean(value)
})
watch(() => props.msg.interaction?.resolved, (value) => {
  if (value) secretValues.value = {}
})
watch(() => props.msg.interaction?.expiresAt, scheduleExpiry)
onMounted(scheduleExpiry)
onBeforeUnmount(() => { if (expiryTimer) clearTimeout(expiryTimer) })
</script>

<style scoped>
.interaction-bubble { width: min(360px, 88%); box-sizing: border-box; margin: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); }
.interaction-title { color: var(--content-primary); font-size: var(--font-size-md); font-weight: 650; line-height: var(--line-height-ui); }
.interaction-body { margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); white-space: pre-wrap; }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border-subtle); }
.interaction-actions :deep(.interaction-option) {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  height: auto;
  min-height: 34px;
  white-space: normal;
  word-break: normal;
  overflow-wrap: anywhere;
  line-height: var(--line-height-body);
}
.interaction-actions :deep(.interaction-option .app-action-button-content) {
  display: block;
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.interaction-custom-hint { margin-top: 8px; color: var(--content-secondary); font-size: var(--font-size-xs); }
.interaction-secrets { display: grid; gap: 9px; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border-subtle); }
.interaction-secret-field { display: grid; gap: 5px; color: var(--content-secondary); font-size: var(--font-size-xs); }
.interaction-secret-field input { width: 100%; box-sizing: border-box; min-height: 34px; padding: 7px 9px; border: 1px solid var(--input-border); border-radius: var(--control-radius); background: var(--surface-input); color: var(--content-primary); }
.interaction-secret-submit { justify-self: start; margin-top: 2px; }
.interaction-response { margin-top: 8px; padding: 7px 9px; border-radius: var(--control-radius); background: var(--surface-soft); color: var(--content-secondary); font-size: var(--font-size-sm); white-space: pre-wrap; }
.interaction-resolved { margin-top: 8px; color: var(--content-tertiary); font-size: var(--font-size-xs); }
</style>
