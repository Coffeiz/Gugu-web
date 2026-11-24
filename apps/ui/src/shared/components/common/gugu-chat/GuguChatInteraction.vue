<template>
  <div class="interaction-bubble" :class="{ 'is-choice': isChoice, 'is-multiple-choice': isMultiple }">
    <div class="interaction-title">
      <span v-if="isChoice" class="interaction-choice-icon"><Icon name="action.list" :size="15" /></span>
      <span>{{ msg.interaction?.title || t('chatUi.confirmRequired') }}</span>
    </div>
    <div v-if="!isChoice || msg.interaction?.body" class="interaction-body">{{ msg.interaction?.body }}</div>
    <!-- 空 options 的存量提问（兜底按钮上线前创建的）不渲染空按钮区，避免悬空分隔线 -->
    <div v-if="displayOptions.length" class="interaction-actions"
         :role="isChoice ? 'group' : undefined" :aria-label="isChoice ? msg.interaction?.title : undefined">
      <ActionButton v-for="option in displayOptions" :key="option.id" class="interaction-option" fit
                    :variant="isChoice ? 'secondary' : 'primary'"
                    :class="{ 'is-selected': optionSelected(option.id), 'is-custom-choice': option.id === CUSTOM_REPLY_OPTION_ID }"
                    :aria-pressed="!isMultiple || option.id === CUSTOM_REPLY_OPTION_ID ? optionSelected(option.id) : undefined"
                    :aria-expanded="option.id === CUSTOM_REPLY_OPTION_ID ? customExpanded : undefined"
                    :role="isMultiple && option.id !== CUSTOM_REPLY_OPTION_ID ? 'checkbox' : undefined"
                    :aria-checked="isMultiple && option.id !== CUSTOM_REPLY_OPTION_ID ? optionSelected(option.id) : undefined"
                    :disabled="resolved || submitting || expired" @click="onOptionClick(option)">
        <template v-if="isChoice">
          <span class="interaction-choice-marker" aria-hidden="true">
            <Icon v-if="optionSelected(option.id)" name="status.success" :size="13" />
            <Icon v-else-if="option.id === CUSTOM_REPLY_OPTION_ID" name="action.edit" :size="13" />
          </span>
          <span class="interaction-choice-label">{{ option.label }}</span>
          <Icon v-if="!resolved && !expired && (!isMultiple || option.id === CUSTOM_REPLY_OPTION_ID)" class="interaction-choice-arrow" name="action.chevron-next" :size="15" />
        </template>
        <template v-else>{{ option.label }}</template>
      </ActionButton>
    </div>
    <form v-if="showAnswerInput && !resolved && !expired"
          class="interaction-answer" @submit.prevent="submitAnswer">
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
      <div v-if="!isMultiple" class="interaction-answer-actions">
        <ActionButton type="submit" fit :disabled="submitting || !answerText.trim()">
          {{ t('chatUi.interactionAnswerSubmit') }}
        </ActionButton>
      </div>
    </form>
    <div v-if="isMultiple && !resolved && !expired" class="interaction-choice-footer">
      <span role="status">{{ t('chatUi.multiSelected', { count: draftOptionIds.length }) }}</span>
      <div class="interaction-choice-footer-actions">
        <ActionButton fit variant="secondary" :disabled="submitting" @click="toggleAllChoices">
          {{ t(allChoicesSelected ? 'chatUi.multiClear' : 'chatUi.multiSelectAll') }}
        </ActionButton>
        <ActionButton fit :disabled="submitting || !draftOptionIds.length && !activeCustomAnswer" @click="submitChoices">
          {{ t('chatUi.interactionAnswerSubmit') }}
        </ActionButton>
      </div>
    </div>
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
    <div v-if="!isMultiple && answerMode === 'composer' && customInputActive && !resolved && !expired" class="interaction-custom-hint">{{ t('chatUi.customReplyHint') }}</div>
    <div v-if="resolved && msg.interaction?.responseText && !answerShownByOptions" class="interaction-response">
      {{ msg.interaction.customAnswer || msg.interaction.responseText }}
    </div>
    <div v-if="submitting" class="interaction-resolved">{{ t(isMultiple ? 'chatUi.multiSubmitting' : 'chatUi.confirmationSubmitting') }}</div>
    <div v-else-if="expired" class="interaction-resolved">{{ t('chatUi.expired') }}</div>
    <div v-else-if="resolved && isPausedConfirmation && msg.interaction?.selectedOptionId === 'cancel'" class="interaction-resolved">
      {{ t('chatUi.confirmationCancelled') }}
    </div>
    <div v-else-if="resolved && !msg.interaction?.submissionRejected && !(isPausedConfirmation && msg.interaction?.selectedOptionId === 'confirm')" class="interaction-resolved">{{ t('chatUi.submitted') }}</div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
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
const secretFields = computed(() => (props.msg.interaction?.secretFields || [])
  .filter(field => field && field.name))
const isChoice = computed(() => {
  const interaction = props.msg.interaction
  return !secretFields.value.length && (interaction?.kind === 'choice' ||
    (interaction?.kind === 'question' && interaction.options.some(option => option.id !== CUSTOM_REPLY_OPTION_ID)))
})
const isMultiple = computed(() => isChoice.value && props.msg.interaction?.selectionMode === 'multiple')
const customExpanded = ref(customInputActive.value)
const showAnswerInput = computed(() => props.msg.interaction?.allowTextInput && !secretFields.value.length &&
  customExpanded.value && (isMultiple.value || props.answerMode === 'inline'))
const displayOptions = computed(() => {
  if (secretFields.value.length) return []
  const options = (props.msg.interaction?.options ?? []).filter(option => option.id !== CUSTOM_REPLY_OPTION_ID)
  if (resolved.value || expired.value) return options
  const custom = props.msg.interaction?.options.find(option => option.id === CUSTOM_REPLY_OPTION_ID)
  if ((!customInputActive.value || isMultiple.value || props.answerMode === 'inline') &&
    (custom || (customInputActive.value && options.length))) {
    options.push({ id: CUSTOM_REPLY_OPTION_ID, token: custom?.token ?? '', label: t('chatUi.customReply') })
  }
  return options
})
const draftOptionIds = ref<string[]>([])
const answerShownByOptions = computed(() => {
  const interaction = props.msg.interaction
  return isChoice.value && !interaction?.customAnswer && (
    Boolean(interaction?.selectedOptionIds?.length) || displayOptions.value.some(option =>
      option.id === interaction?.selectedOptionId && option.label === interaction?.responseText)
  )
})
const choiceOptions = computed(() => displayOptions.value.filter(option => option.id !== CUSTOM_REPLY_OPTION_ID))
const allChoicesSelected = computed(() => choiceOptions.value.length > 0 && draftOptionIds.value.length === choiceOptions.value.length)

function toggleAllChoices() {
  draftOptionIds.value = allChoicesSelected.value ? [] : choiceOptions.value.map(option => option.id)
}
function optionSelected(id: string) {
  if (id === CUSTOM_REPLY_OPTION_ID && !resolved.value) return customExpanded.value
  if (!isMultiple.value) return props.msg.interaction?.selectedOptionId === id
  return (resolved.value ? props.msg.interaction?.selectedOptionIds : draftOptionIds.value)?.includes(id) ?? false
}

function onOptionClick(option: { id: string; label: string; token: string }) {
  if (resolved.value || submitting.value || expired.value) return
  if (option.id === CUSTOM_REPLY_OPTION_ID && (isMultiple.value || (customInputActive.value && props.answerMode === 'inline'))) {
    customExpanded.value = !customExpanded.value
    return
  }
  if (!isMultiple.value) {
    selectOption(option)
    return
  }
  draftOptionIds.value = optionSelected(option.id)
    ? draftOptionIds.value.filter(id => id !== option.id)
    : [...draftOptionIds.value, option.id]
}

function submitChoices() {
  const options = choiceOptions.value.filter(option => draftOptionIds.value.includes(option.id))
  const customAnswer = activeCustomAnswer.value
  const first = options[0]
  if (first) {
    selectOption({
      ...first, label: options.map(option => option.label).join('、'), selectedOptionIds: options.map(option => option.id),
      ...(customAnswer ? { customAnswer } : {}),
    })
    return
  }
  if (!customAnswer) return
  const custom = displayOptions.value.find(option => option.id === CUSTOM_REPLY_OPTION_ID)
  if (custom?.token) selectOption({ ...custom, label: customAnswer, customAnswer })
  else if (customInputActive.value) submitText()
}

const secretValues = ref<Record<string, string>>({})
const answerText = ref('')
const activeCustomAnswer = computed(() => customExpanded.value ? answerText.value.trim() : '')
const answerInput = ref<HTMLTextAreaElement | null>(null)
const secretsReady = computed(() => secretFields.value.length > 0
  && secretFields.value.every(field => Boolean(secretValues.value[field.name]?.trim())))
const emit = defineEmits<{
  select: [msg: ChatMessage, option: { id: string; label: string; token: string; selectedOptionIds?: string[]; customAnswer?: string }]
  textSubmit: [msg: ChatMessage, text: string]
  secretSubmit: [msg: ChatMessage, values: Record<string, string>]
  secretCancel: [msg: ChatMessage]
}>()
function submitSecrets() {
  if (!secretsReady.value || resolved.value || submitting.value || expired.value) return
  emit('secretSubmit', props.msg, Object.fromEntries(
    secretFields.value.map(field => [field.name, secretValues.value[field.name] || '']),
  ))
}
function cancelSecrets() {
  if (resolved.value || submitting.value || expired.value) return
  emit('secretCancel', props.msg)
}
function selectOption(option: { id: string; label: string; token: string; selectedOptionIds?: string[]; customAnswer?: string }) {
  if (resolved.value || submitting.value || expired.value) return
  emit('select', props.msg, option)
}
function submitText() {
  const text = answerText.value.trim()
  if (!text || resolved.value || submitting.value || expired.value) return
  emit('textSubmit', props.msg, text)
}
function submitAnswer() {
  if (isMultiple.value) submitChoices()
  else submitText()
}
function onAnswerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submitAnswer()
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
watch(() => props.msg.interaction?.expired, value => { expired.value = Boolean(value) })
watch(() => props.msg.interaction?.submitting, (value, previous) => {
  submitting.value = Boolean(value)
  if (previous && !value) secretValues.value = {}
  scheduleExpiry()
})
watch(() => props.msg.interaction?.resolved, (value) => {
  if (value) secretValues.value = {}
})
watch(() => props.msg.interaction?.expiresAt, scheduleExpiry)
watch(customInputActive, active => {
  if (!isMultiple.value && active) customExpanded.value = true
})
watch(showAnswerInput, async active => {
  if (active && !resolved.value && !expired.value) {
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
.interaction-bubble { width: 100%; max-width: var(--chat-assistant-bubble-max-width, 88%); min-width: 0; box-sizing: border-box; margin: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-card-solid); color: var(--content-primary); box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card); }
.interaction-title { color: var(--content-primary); font-size: var(--font-size-md); font-weight: 650; line-height: var(--line-height-ui); }
.interaction-body { min-width: 0; max-width: 100%; max-height: 40vh; overflow: auto; margin-top: 5px; color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%; margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--content-divider); }
.interaction-actions :deep(.interaction-option) {
  flex: 1 1 auto;
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
.interaction-bubble.is-choice {
  padding: 15px;
  border-color: var(--action-outline);
  background: var(--surface-card-solid);
}
.is-choice .interaction-title { display: flex; align-items: center; gap: 9px; overflow-wrap: anywhere; }
.interaction-choice-icon {
  display: grid; place-items: center; flex: 0 0 28px; block-size: 28px;
  border-radius: var(--radius-xs); background: var(--action-soft); color: var(--action-primary);
}
.is-choice .interaction-body { margin-top: 8px; }
.is-choice .interaction-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.is-choice .interaction-actions :deep(.interaction-option) {
  width: 100%; padding: 8px 10px; min-height: 38px;
  justify-content: flex-start; text-align: start; color: var(--content-primary);
  border-color: var(--content-divider); background: var(--surface-soft);
  transition: background-color var(--motion-hover-control), border-color var(--motion-hover-control), opacity var(--motion-hover-control);
}
.is-choice .interaction-actions :deep(.interaction-option:hover:not(:disabled)),
.is-choice .interaction-actions :deep(.interaction-option.is-selected) {
  background: var(--action-soft); border-color: var(--action-outline); box-shadow: none;
}
.is-choice .interaction-actions :deep(.interaction-option .app-action-button-content) {
  display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%;
}
.interaction-choice-marker {
  display: grid; place-items: center; inline-size: 18px; block-size: 18px;
  box-sizing: border-box; border: 1px solid var(--border-default); border-radius: 50%;
  color: var(--action-primary);
}
.is-selected .interaction-choice-marker { border-color: var(--action-outline); background: var(--action-soft); }
.interaction-choice-label { min-width: 0; }
.interaction-choice-arrow { color: var(--content-secondary); }
.is-custom-choice[aria-expanded="true"] .interaction-choice-arrow { transform: rotate(90deg); }
.is-multiple-choice .interaction-option:not(.is-custom-choice) .interaction-choice-marker {
  border-radius: var(--radius-xs);
}
.interaction-choice-footer {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-sm);
  margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--content-divider);
  color: var(--content-secondary); font-size: var(--font-size-xs);
}
.interaction-choice-footer-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
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
