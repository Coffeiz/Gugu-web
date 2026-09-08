<template>
  <div class="interaction-bubble">
    <div class="interaction-title">{{ msg.interaction?.title || t('chatUi.confirmRequired') }}</div>
    <div class="interaction-body">{{ msg.interaction?.body }}</div>
    <div class="interaction-actions">
      <ActionButton v-for="option in displayOptions" :key="option.id" fit
                    :disabled="resolved || submitting || expired" @click="selectOption(option)">
        {{ option.label }}
      </ActionButton>
    </div>
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
const emit = defineEmits<{
  select: [msg: ChatMessage, option: { id: string; label: string; token: string }]
}>()
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
watch(() => props.msg.interaction?.expiresAt, scheduleExpiry)
onMounted(scheduleExpiry)
onBeforeUnmount(() => { if (expiryTimer) clearTimeout(expiryTimer) })
</script>

<style scoped>
.interaction-bubble { width: min(360px, 88%); box-sizing: border-box; margin: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); }
.interaction-title { color: var(--content-primary); font-size: var(--font-size-md); font-weight: 650; line-height: var(--line-height-ui); }
.interaction-body { margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); white-space: pre-wrap; }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--border-subtle); }
.interaction-custom-hint { margin-top: 8px; color: var(--content-secondary); font-size: var(--font-size-xs); }
.interaction-response { margin-top: 8px; padding: 7px 9px; border-radius: var(--control-radius); background: var(--surface-soft); color: var(--content-secondary); font-size: var(--font-size-sm); white-space: pre-wrap; }
.interaction-resolved { margin-top: 8px; color: var(--content-tertiary); font-size: var(--font-size-xs); }
</style>
