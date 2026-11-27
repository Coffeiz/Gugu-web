<template>
  <section class="chat-email-compose">
    <div v-if="readOnly || disabled" class="email-fields email-summary">
      <section class="email-field-section">
        <h3>{{ $t('pageUi.sender') }}</h3>
        <span class="email-sender-address">{{ draft.senderName ? `${draft.senderName} · ${draft.sender}` : draft.sender }}</span>
      </section>
      <section class="email-field-section">
        <h3>{{ $t('pageUi.recipient') }}</h3>
        <span class="email-sender-address">{{ draft.recipient }}</span>
      </section>
      <section class="email-field-section">
        <h3>{{ $t('pageUi.subject') }}</h3>
        <span class="email-sender-address">{{ draft.subject }}</span>
      </section>
    </div>
    <div v-else class="email-fields">
      <section class="email-field-section">
        <h3>{{ $t('pageUi.sender') }}</h3>
        <div class="email-address-row">
          <SelectPopup v-if="draft.accounts.length" :model-value="draft.account ?? ''"
            :options="accountOptions" :aria-label="$t('pageUi.senderEmail')" :disabled="disabled" @update:model-value="selectAccount" />
          <span v-else class="email-sender-address">{{ draft.sender }}</span>
          <input v-model="draft.senderName" class="form-input" :aria-label="$t('pageUi.senderName')"
            :placeholder="$t('pageUi.optionalSender')" maxlength="160" :disabled="disabled" />
        </div>
      </section>
      <section class="email-field-section">
        <h3>{{ $t('pageUi.recipient') }}</h3>
        <div class="email-address-row">
          <input v-model.trim="draft.recipient" class="form-input" :aria-label="$t('pageUi.recipientEmail')"
            :placeholder="$t('pageUi.commaAddresses')" maxlength="5100" :disabled="disabled" />
          <input v-model="draft.recipientName" class="form-input" :aria-label="$t('pageUi.firstRecipient')"
            :placeholder="$t('pageUi.optionalFirstRecipient')" maxlength="160" :disabled="disabled" />
        </div>
      </section>
      <label class="email-field-section">
        <span class="email-field-title">{{ $t('pageUi.subject') }}</span>
        <input v-model.trim="draft.subject" class="form-input" maxlength="200" :disabled="disabled" />
      </label>
    </div>
    <iframe v-if="draft.templateHtml" ref="templateFrame" class="email-template-frame" :title="$t('pageUi.mailBodyPreview')"
      sandbox="allow-same-origin" referrerpolicy="no-referrer" :srcdoc="templateDocument"
      :style="{ height: templateHeight + 'px' }" @load="observeTemplate" />
    <section v-else-if="!disabled && !readOnly" class="email-body">
      <h3>{{ $t('pageUi.body') }}</h3>
      <MailMessageEditor v-model="draft.text" />
    </section>
    <div v-else class="email-text">{{ draft.text }}</div>
    <p v-if="draft.attachments.length" class="email-attachments">{{ $t('pageUi.attachmentNames', { names: draft.attachments.join(', ') }) }}</p>
    <div v-if="outcome" class="email-outcome" role="status">
      <span class="email-outcome-badge" :class="`is-${outcomeTone}`">
        <component :is="outcomeTone === 'success' ? PhCheckCircle : PhWarningCircle" :size="16" aria-hidden="true" />
        {{ outcome }}
      </span>
      <ActionButton v-if="draftRef" type="button" fit variant="secondary" @click="openDraft">{{ $t('pageUi.openDraft') }}</ActionButton>
    </div>
    <p v-if="error" role="alert" class="email-error">{{ error }}</p>
    <div v-if="!disabled" class="email-actions">
      <ActionButton type="button" fit variant="secondary" @click="$emit('cancel')">{{ $t('common.actions.cancel') }}</ActionButton>
      <ActionButton v-if="draft.canDraft && draft.account" type="button" fit variant="secondary" @click="submit('draft')">{{ $t('pageUi.saveDraftShort') }}</ActionButton>
      <ActionButton type="button" fit @click="submit('send')"><PhPaperPlaneTilt class="email-send-icon" :size="16" weight="bold" aria-hidden="true" />{{ $t('pageUi.send') }}</ActionButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, inject, onBeforeUnmount, reactive, ref } from 'vue'
import { PhCheckCircle, PhPaperPlaneTilt, PhWarningCircle } from '@phosphor-icons/vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import MailMessageEditor from '@/views/Mail/MailMessageEditor.vue'
import { renderMarkdown } from '@/utils/markdown'
import { useRouter } from 'vue-router'
import { mailDraftLocation } from '@gugu/email/contracts'
import { openMailDraft, openMailDraftKey } from '@/api/mailLinks'
import type { ChatMessage, ChatEmailCompose } from './chatTypes'

const { t } = useI18n()

const props = defineProps<{ initial: ChatEmailCompose; disabled: boolean; emailTool?: { status: ChatMessage['toolStatus']; result: unknown } }>()
const emit = defineEmits<{ submit: [payload: string, action: 'send' | 'draft']; cancel: [] }>()
const draft = reactive({ ...props.initial, recipientName: props.initial.recipientName ?? '' })
const readOnly = computed(() => draft.format ? draft.format !== 'plain' : Boolean(draft.templateHtml))
const accountOptions = computed(() => [
  ...(!props.initial.account ? [{ value: '', label: props.initial.sender }] : []),
  ...draft.accounts.map(item => ({ value: item.id, label: item.email })),
])
const error = ref('')
const templateFrame = ref<HTMLIFrameElement | null>(null)
const templateHeight = ref(320)
let templateObserver: ResizeObserver | undefined
function observeTemplate() {
  templateObserver?.disconnect()
  const body = templateFrame.value?.contentDocument?.body
  if (!body) return
  const resize = () => { templateHeight.value = Math.max(1, Math.ceil(body.getBoundingClientRect().height)) }
  resize()
  if (typeof ResizeObserver !== 'undefined') {
    templateObserver = new ResizeObserver(resize)
    templateObserver.observe(body)
  }
}
onBeforeUnmount(() => templateObserver?.disconnect())
const templateDocument = computed(() => `<!doctype html><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'">
  <style>body{margin:0;overflow-wrap:anywhere}td{max-width:100%}
  @media(max-width:400px){body>table>tbody>tr>td>table>tbody>tr>td{padding:16px!important}img{max-width:100%;height:auto}}</style>
  ${draft.templateHtml ?? ''}`)

const router = useRouter()
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const receipt = computed(() => record(props.emailTool?.result))
const outcome = computed(() => {
  if (!props.disabled) return ''
  if (receipt.value.status === 'draft_saved') return t('pageUi.draftSaved')
  if (receipt.value.status === 'sent') return t('pageUi.sendSubmitted')
  if (receipt.value.status === 'partial') return t('pageUi.partialMailSubmitted')
  if (props.emailTool?.status === 'error') return typeof receipt.value.error === 'string' ? receipt.value.error : t('pageUi.mailOperationFailed')
  if (props.emailTool?.status === 'unknown') return t('pageUi.mailResultPending')
  return ''
})
const outcomeTone = computed(() => {
  if (receipt.value.status === 'sent' || receipt.value.status === 'draft_saved') return 'success'
  if (props.emailTool?.status === 'error') return 'danger'
  return 'warning'
})
const openDraftInMain = inject(openMailDraftKey, undefined)
const draftRef = computed(() => {
  if (receipt.value.status !== 'draft_saved') return null
  const result = mailDraftLocation.safeParse(receipt.value.draftRef)
  return result.success ? result.data : null
})
function openDraft() {
  if (!draftRef.value) return
  if (openDraftInMain) openDraftInMain(draftRef.value)
  else void openMailDraft(router, draftRef.value)
}

function selectAccount(value: unknown) {
  const account = draft.accounts.find(item => item.id === value)
  draft.account = account?.id
  draft.senderName = account?.name ?? props.initial.senderName
}

function submit(action: 'send' | 'draft') {
  if (props.disabled) return
  const { account, senderName, recipientName, subject, text } = draft
  const addresses = (value: string) => value.split(/[,，;；]/).map(part => part.trim()).filter(Boolean)
  const [recipient = '', ...additionalRecipients] = addresses(draft.recipient)
  const html = readOnly.value ? undefined : renderMarkdown(text)
  const names = /^[^\p{Cc}\p{Cf}]*$/u
  const validAddress = (address: string) => address.length <= 254 && /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/u.test(address)
  if (action === 'send' && (!recipient || !subject.trim() || !text.trim())
    || ![recipient, ...additionalRecipients].filter(Boolean).every(validAddress)
    || additionalRecipients.length > 19
    || !names.test(senderName) || !names.test(recipientName)) {
    error.value = t('pageUi.checkMailFields')
    return
  }
  const payload = JSON.stringify({ account, senderName, recipientName, recipient, additionalRecipients, subject, text, html, action })
  if (text.length > 20_000 || (html?.length ?? 0) > 40_000 || new TextEncoder().encode(payload).length > 80_000) {
    error.value = t('pageUi.mailBodyTooLong')
    return
  }
  error.value = ''
  emit('submit', payload, action)
}
</script>

<style scoped>
.chat-email-compose, .email-fields, .email-field-section, .email-fields label, .email-body {
  display: grid; gap: var(--space-sm); min-width: 0; grid-template-columns: minmax(0, 1fr);
}
.chat-email-compose { container-type: inline-size; gap: var(--space-md); margin-block-start: var(--space-md); }
.email-field-section + .email-field-section, .email-body {
  border-top: 1px solid var(--content-divider); padding-block-start: var(--space-sm);
}
.email-field-section h3, .email-field-title, .email-body h3 { margin: 0; font: inherit; font-weight: 600; }
.email-address-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: var(--space-sm); }
.email-fields input { width: 100%; min-width: 0; }
.email-sender-address { align-self: center; overflow-wrap: anywhere; }
.email-summary {
  gap: 0; padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--content-divider); border-radius: var(--radius-sm);
  background: var(--surface-soft);
}
.email-summary .email-field-section { gap: 3px; padding-block: var(--space-sm); }
.email-summary .email-field-section + .email-field-section { border-top: 1px solid var(--content-divider); }
.email-summary h3 { color: var(--content-secondary); font-size: var(--font-size-sm); font-weight: 500; }
.email-summary .email-sender-address { color: var(--content-primary); line-height: var(--line-height-ui); }
.email-summary .email-field-section:last-child .email-sender-address { font-weight: 600; }
@container (max-width: 500px) { .email-address-row { grid-template-columns: minmax(0, 1fr); } }
.email-template-frame { display: block; width: 100%; min-width: 0; margin-block-start: var(--space-sm); border: 1px solid var(--content-divider); border-radius: var(--radius-xs); }
.email-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.email-send-icon { display: block; flex: none; }
.email-actions, .email-outcome { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-sm); }
.email-attachments, .email-error { margin: 0; overflow-wrap: anywhere; }
.email-attachments { color: var(--content-secondary); }
.email-outcome { align-items: center; }
.email-outcome-badge {
  display: inline-flex; align-items: center; gap: var(--space-xs); max-width: 100%;
  padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm);
  color: var(--status-warning); background: var(--status-warning-bg); overflow-wrap: anywhere;
  font-size: var(--font-size-sm); font-weight: 600;
}
.email-outcome-badge svg { flex: none; }
.email-outcome-badge.is-success { color: var(--status-success); background: var(--status-success-bg); }
.email-outcome-badge.is-danger { color: var(--status-danger); background: var(--status-danger-bg); }
.email-error { color: var(--status-danger); }
</style>
