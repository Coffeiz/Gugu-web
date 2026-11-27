<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MailMessage } from '@gugu/email/contracts'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import { computed, ref, watch } from 'vue'

const { locale } = useI18n()

const props = defineProps<{ message: MailMessage; account?: string; canReply?: boolean }>()
const emit = defineEmits<{ reply: [] }>()
const senderLabel = computed(() => {
  const { fromName, from } = props.message
  return fromName && from && fromName !== from ? `${fromName} <${from}>` : fromName || from
})
const open = ref(false)
watch(() => [props.message.uid, props.message.subject], () => { open.value = false })
</script>

<template>
  <header class="mail-message-heading">
    <h2>{{ message.subject || $t('pageUi.noSubject') }}</h2>
    <div class="mail-message-from">
      <span>{{ message.fromName || message.from }}</span>
      <time v-if="message.date">{{ new Date(message.date).toLocaleString(locale) }}</time>
    </div>
    <details :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open" class="mail-address-details">
      <summary>{{ $t('pageUi.sentTo') }} {{ account || message.to.join('、') || $t('pageUi.recipient') }} <FlipChevron :open="open" :size="11" /></summary>
      <dl>
        <template v-if="message.from">
          <dt>{{ $t('pageUi.sender') }}</dt>
          <dd><button v-if="canReply" type="button" class="mail-sender-reply" :title="$t('pageUi.reply')" @click="emit('reply')">{{ senderLabel }}</button><span v-else>{{ senderLabel }}</span></dd>
        </template>
        <template v-if="message.replyTo">
          <dt>{{ $t('pageUi.replyTo') }}</dt>
          <dd><button v-if="canReply" type="button" class="mail-sender-reply" :title="$t('pageUi.reply')" @click="emit('reply')">{{ message.replyTo }}</button><span v-else>{{ message.replyTo }}</span></dd>
        </template>
        <template v-if="message.to.length"><dt>{{ $t('pageUi.recipient') }}</dt><dd>{{ message.to.join('、') }}</dd></template>
        <template v-if="account"><dt>{{ $t('pageUi.recipientAccount') }}</dt><dd>{{ account }}</dd></template>
        <template v-if="message.date"><dt>{{ $t('pageUi.date') }}</dt><dd>{{ new Date(message.date).toLocaleString(locale) }}</dd></template>
        <dt>{{ $t('pageUi.subject') }}</dt><dd>{{ message.subject || $t('pageUi.noSubject') }}</dd>
      </dl>
    </details>
  </header>
</template>

<style scoped>
.mail-message-heading { display: grid; flex: none; gap: var(--space-sm); padding: var(--page-content-inset); border-bottom: 1px solid var(--content-divider); }
.mail-message-heading h2 { font-size: var(--font-size-lg); }
.mail-message-from { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-sm); color: var(--content-primary); }
.mail-message-from time { color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-message-from > :first-child, .mail-sender-reply { min-width: 0; overflow-wrap: anywhere; }
.mail-sender-reply { max-width: 100%; padding: 0; border: 0; background: transparent; color: var(--action-primary); font: inherit; text-align: start; text-decoration: underline; text-underline-offset: 0.18em; cursor: pointer; }
.mail-sender-reply:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.mail-address-details { position: relative; color: var(--content-secondary); font-size: var(--font-size-sm); }
.mail-address-details summary { display: inline-flex; align-items: center; gap: var(--space-xs); cursor: pointer; list-style: none; }
.mail-address-details summary::-webkit-details-marker { display: none; }
.mail-address-details summary:hover { color: var(--content-primary); }
.mail-address-details summary:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.mail-address-details dl { position: absolute; z-index: 5; inset-block-start: 100%; inset-inline-start: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-xs) var(--space-md); width: min(420px, 75vw); margin: var(--space-xs) 0 0; padding: var(--space-md); border: 1px solid var(--content-divider); border-radius: var(--radius-sm); background: var(--surface-popup); box-shadow: var(--elevation-card-hover); }
.mail-address-details dt { color: var(--content-secondary); }
.mail-address-details dd { min-width: 0; margin: 0; color: var(--content-primary); overflow-wrap: anywhere; }
</style>
