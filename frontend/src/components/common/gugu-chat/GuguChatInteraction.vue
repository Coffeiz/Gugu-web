<template>
  <div class="interaction-bubble">
    <div class="interaction-title">{{ msg.interaction?.title || t('chatUi.confirmRequired') }}</div>
    <div class="interaction-body">{{ msg.interaction?.body }}</div>
    <!-- 空 options 的存量提问（兜底按钮上线前创建的）不渲染空按钮区，避免悬空分隔线 -->
    <div v-if="displayOptions.length" class="interaction-actions">
      <ActionButton v-for="option in displayOptions" :key="option.id" class="interaction-option" fit
                    :class="{ 'is-selected': msg.interaction?.selectedOptionId === option.id }"
                    :aria-pressed="msg.interaction?.selectedOptionId === option.id"
                    :disabled="resolved || submitting || expired" @click="selectOption(option)">
        {{ option.label }}
      </ActionButton>
    </div>
    <form v-if="answerMode === 'inline' && customInputActive && msg.interaction?.allowTextInput && !resolved && !expired && !secretFields.length"
          class="interaction-answer" @submit.prevent="submitText">
      <textarea
        ref="answerInput"
        v-model="answerText"
        class="form-input control-resizable interaction-answer-input"
        rows="3"
        :aria-label="t('chatUi.interactionAnswerPlaceholder')"
        :placeholder="t('chatUi.interactionAnswerPlaceholder')"
        :disabled="submitting"
        @keydown="onAnswerKeydown"
      />
      <div class="interaction-answer-actions">
        <ActionButton type="submit" fit :disabled="submitting || !answerText.trim()">
          {{ t('chatUi.interactionAnswerSubmit') }}
        </ActionButton>
      </div>
    </form>
    <form v-if="secretFields.length && !resolved" class="interaction-secrets" @submit.prevent="submitSecrets">
      <div v-for="field in secretFields" :key="field.name" class="interaction-secret-field">
        <span>{{ field.label }}</span>
        <input v-model="secretValues[field.name]" type="password" autocomplete="new-password"
               :name="`mcp-secret-${field.name}`" :disabled="submitting || expired"
               :aria-label="field.label" spellcheck="false" required />
      </div>
      <div class="interaction-secret-actions">
        <ActionButton class="interaction-secret-submit" type="submit"
                      :disabled="resolved || submitting || expired || !secretsReady">
          {{ t('chatUi.submitSecretFields') }}
        </ActionButton>
        <ActionButton class="interaction-secret-cancel" type="button"
                      :disabled="resolved || submitting || expired" @click="cancelSecrets">
          {{ t('common.actions.cancel') }}
        </ActionButton>
      </div>
    </form>
    <div v-if="answerMode === 'composer' && customInputActive && !resolved && !expired" class="interaction-custom-hint">{{ t('chatUi.customReplyHint') }}</div>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { CUSTOM_REPLY_OPTION_ID, type ChatMessage, type InteractionAnswerMode } from './chatTypes'

const props = withDefaults(defineProps<{ msg: ChatMessage; answerMode?: InteractionAnswerMode }>(), {
  answerMode: 'composer',
})
const resolved = ref(Boolean(props.msg.interaction?.resolved))
const submitting = ref(Boolean(props.msg.interaction?.submitting))
const initiallyExpired = Boolean(
  props.msg.interaction?.expired
  || (!resolved.value && !submitting.value && !props.msg.interaction?.selectedOptionId
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
  .filter(() => !secretFields.value.length)
  .filter(option => !(option.id === CUSTOM_REPLY_OPTION_ID && (customInputActive.value || resolved.value || expired.value)))
  .map(option => option.id === CUSTOM_REPLY_OPTION_ID
    ? { ...option, label: t('chatUi.customReply') }
    : option))
const secretFields = computed(() => (props.msg.interaction?.secretFields || [])
  .filter(field => field && field.name))
const secretValues = ref<Record<string, string>>({})
const answerText = ref('')
const answerInput = ref<HTMLTextAreaElement | null>(null)
const secretsReady = computed(() => secretFields.value.length > 0
  && secretFields.value.every(field => Boolean(secretValues.value[field.name]?.trim())))
const emit = defineEmits<{
  select: [msg: ChatMessage, option: { id: string; label: string; token: string }]
  textSubmit: [msg: ChatMessage, text: string]
  secretSubmit: [msg: ChatMessage, values: Record<string, string>]
  secretCancel: [msg: ChatMessage]
}>()
function submitSecrets() {
  if (!secretsReady.value || resolved.value || submitting.value || expired.value) return
  submitting.value = true
  if (props.msg.interaction) props.msg.interaction.submitting = true
  emit('secretSubmit', props.msg, Object.fromEntries(
    secretFields.value.map(field => [field.name, secretValues.value[field.name] || '']),
  ))
}
function cancelSecrets() {
  if (resolved.value || submitting.value || expired.value) return
  submitting.value = true
  if (props.msg.interaction) props.msg.interaction.submitting = true
  emit('secretCancel', props.msg)
}
function selectOption(option: { id: string; label: string; token: string }) {
  if (resolved.value || submitting.value || expired.value) return
  submitting.value = true
  if (props.msg.interaction) props.msg.interaction.submitting = true
  emit('select', props.msg, option)
}
function submitText() {
  const text = answerText.value.trim()
  if (!text || resolved.value || submitting.value || expired.value) return
  submitting.value = true
  if (props.msg.interaction) props.msg.interaction.submitting = true
  emit('textSubmit', props.msg, text)
}
function onAnswerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submitText()
}
function activateOpenQuestion() {
  const interaction = props.msg.interaction
  const options = interaction?.options || []
  if (
    !interaction
    || interaction.kind !== 'question'
    || !interaction.allowTextInput
    || interaction.customInputActive
    || resolved.value
    || expired.value
    || secretFields.value.length
  ) return
  const hasRealOptions = options.some(option => option.id !== CUSTOM_REPLY_OPTION_ID)
  if (!hasRealOptions) interaction.customInputActive = true
}
function markExpired() {
  if (resolved.value || submitting.value) return
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
  if (!value || resolved.value || submitting.value) return
  const remaining = new Date(value).getTime() - Date.now()
  if (remaining <= 0) { markExpired(); return }
  expiryTimer = setTimeout(markExpired, remaining)
}
watch(() => props.msg.interaction?.resolved, (value) => {
  resolved.value = Boolean(value)
  scheduleExpiry()
})
watch(() => props.msg.interaction?.submitting, (value, previous) => {
  submitting.value = Boolean(value)
  if (previous && !value) secretValues.value = {}
  scheduleExpiry()
})
watch(() => props.msg.interaction?.resolved, (value) => {
  if (value) secretValues.value = {}
})
watch(() => props.msg.interaction?.expiresAt, scheduleExpiry)
watch(customInputActive, async (active) => {
  if (active && props.answerMode === 'inline' && !resolved.value && !expired.value) {
    await nextTick()
    answerInput.value?.focus()
  }
})
onMounted(() => {
  scheduleExpiry()
  activateOpenQuestion()
})
onBeforeUnmount(() => { if (expiryTimer) clearTimeout(expiryTimer) })
</script>

<style scoped>
.interaction-bubble { width: min(360px, 88%); box-sizing: border-box; margin: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); }
.interaction-title { color: var(--content-primary); font-size: var(--font-size-md); font-weight: 650; line-height: var(--line-height-ui); }
.interaction-body { min-width: 0; max-width: 100%; margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--content-divider); }
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
.interaction-actions :deep(.interaction-option.is-selected) {
  opacity: 1;
  color: var(--content-on-accent);
  background: var(--action-primary-bg);
  box-shadow: inset 0 0 0 2px var(--border-focus);
}
.interaction-actions :deep(.interaction-option .app-action-button-content) {
  display: block;
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.interaction-custom-hint { margin-top: 8px; color: var(--content-secondary); font-size: var(--font-size-xs); }
.interaction-answer { display:flex; flex-direction:column; gap:var(--space-sm); margin-top:13px; padding-top:11px; border-top:1px solid var(--content-divider); }
.interaction-answer-input { box-sizing:border-box; width:100%; min-height:72px; line-height:var(--line-height-body); }
.interaction-answer-actions { display:flex; justify-content:flex-end; }
.interaction-secrets { display: grid; gap: 9px; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--content-divider); }
.interaction-secret-field { display: grid; gap: 5px; color: var(--content-secondary); font-size: var(--font-size-xs); }
.interaction-secret-field input { width: 100%; box-sizing: border-box; min-height: 34px; padding: 7px 9px; border: 1px solid var(--input-border); border-radius: var(--control-radius); background: var(--surface-input); color: var(--content-primary); }
.interaction-secret-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-width: 100%; margin-top: 2px; }
.interaction-secret-actions :deep(.app-action-button) { width: 100%; min-width: 0; }
.interaction-response { margin-top: 8px; padding: 7px 9px; border-radius: var(--control-radius); background: var(--surface-soft); color: var(--content-secondary); font-size: var(--font-size-sm); white-space: pre-wrap; }
.interaction-resolved { margin-top: 8px; color: var(--content-tertiary); font-size: var(--font-size-xs); }
</style>
