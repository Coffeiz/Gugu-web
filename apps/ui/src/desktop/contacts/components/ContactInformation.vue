<script setup lang="ts">
import { computed } from 'vue'
import { RiMailLine, RiMapPinLine, RiPhoneLine, RiStickyNoteLine } from '@remixicon/vue'
import type { DesktopClientFields } from '@gugu/core/desktop'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { isMailRecipient } from '@/api/mailLinks'

defineProps<{ editing: boolean; busy: boolean }>()
const fields = defineModel<DesktopClientFields>({ required: true })
const emit = defineEmits<{ save: []; cancel: [] }>()
const rows = [
  { key: 'email', label: 'pageUi.mail', type: 'email', limit: 300, icon: RiMailLine },
  { key: 'phone', label: 'pageUi.phone', type: 'tel', limit: 50, icon: RiPhoneLine },
  { key: 'address', label: 'pageUi.address', type: 'text', limit: 500, icon: RiMapPinLine },
  { key: 'notes', label: 'pageUi.notes', type: 'text', limit: undefined, icon: RiStickyNoteLine },
] as const
const visibleRows = computed(() => rows.flatMap(row => {
  const value = fields.value[row.key]?.trim()
  if (!value) return []
  let href: string | undefined
  if (row.key === 'email' && isMailRecipient(value)) {
    href = 'mailto:' + encodeURIComponent(value).replace('%40', '@')
  } else if (row.key === 'phone') {
    const number = value.replace(/[\s().-]/g, '')
    if (/^\+?[0-9]{1,32}$/.test(number)) href = 'tel:' + number
  } else if (row.key === 'address') {
    href = 'https://maps.apple.com/?' + new URLSearchParams({ q: value })
  }
  return [{ ...row, value, href }]
}))
</script>

<template>
  <form v-if="editing" id="contact-details-form" class="contact-information contact-form" @submit.prevent="emit('save')">
    <h3 class="contact-section-title">{{ $t('pageUi.contactInfo') }}</h3>
    <div v-for="row in rows" :key="row.key" class="contact-field">
      <span :id="'contact-title-' + row.key" class="contact-field-title">
        <component :is="row.icon" size="16px" aria-hidden="true" />{{ $t(row.label) }}
      </span>
      <textarea v-if="row.key === 'notes'" :id="'contact-field-' + row.key" v-model="fields.notes" :aria-labelledby="'contact-title-' + row.key" class="form-input control-resizable" rows="3" :disabled="busy" />
      <input v-else :id="'contact-field-' + row.key" v-model="fields[row.key]" class="form-input"
        :aria-labelledby="'contact-title-' + row.key" :type="row.type" :maxlength="row.limit" :disabled="busy" />
    </div>
    <div class="contact-actions">
      <ActionButton fit variant="secondary" :disabled="busy" @click="emit('cancel')">{{ $t('common.actions.cancel') }}</ActionButton>
      <ActionButton fit type="submit" :disabled="busy || !fields.name.trim()">{{ $t('common.actions.save') }}</ActionButton>
    </div>
  </form>
  <section v-else class="contact-information" aria-labelledby="contact-info-heading">
    <h3 id="contact-info-heading" class="contact-section-title">{{ $t('pageUi.contactInfo') }}</h3>
    <dl v-if="visibleRows.length" class="contact-methods">
      <div v-for="row in visibleRows" :key="row.key" class="contact-method">
        <dt><component :is="row.icon" size="var(--icon-size-sm)" aria-hidden="true" />{{ $t(row.label) }}</dt>
        <dd :class="{ 'contact-value--phone': row.key === 'phone' }">
          <a v-if="row.href" class="contact-link" :href="row.href" :target="row.key === 'address' ? '_blank' : 'gugu-contact-handler'" :rel="row.key === 'address' ? 'noopener noreferrer' : undefined" data-system-contact-link>{{ row.value }}</a>
          <template v-else>{{ row.value }}</template>
        </dd>
      </div>
    </dl>
    <p v-else class="contact-hint">{{ $t('pageUi.addContactInfo') }}</p>
  </section>
</template>

<style scoped>
.contact-information {
  margin-block-start: var(--space-lg);
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.contact-section-title {
  margin: 0; padding: var(--space-sm) var(--space-md);
  border-block-end: 1px solid var(--content-divider);
  color: var(--content-primary); font-size: var(--font-size-body); font-weight: var(--font-weight-semibold);
}
.contact-form .contact-section-title { margin: calc(-1 * var(--space-md)) calc(-1 * var(--space-md)) 0; }
.contact-methods { margin: 0; }
.contact-method {
  display: grid; grid-template-columns: var(--icon-size-sm) minmax(0, 1fr); align-items: start; column-gap: var(--space-sm); row-gap: var(--space-xs);
  padding-block: var(--space-md);
  padding-inline: calc(var(--space-md) + var(--space-sm));
}
.contact-method + .contact-method { border-block-start: 1px solid var(--content-divider); }
.contact-method svg, .contact-field-title svg { color: var(--action-primary); }
.contact-method dt { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; }
.contact-method dt, .contact-field-title {
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-body);
}
.contact-field-title { display: flex; align-items: center; gap: var(--space-sm); margin: 0; }
.contact-method dd {
  grid-column: 2;
  margin: 0;
  font-weight: var(--font-weight-regular);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.contact-value--phone { font-variant-numeric: tabular-nums; }
.contact-link { color: var(--action-primary); text-decoration: underline; text-underline-offset: 0.18em; }
.contact-hint {
  margin: 0;
  padding: var(--space-md);
}
.contact-hint, .contact-method dd {
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-body);
}
.contact-form { padding: var(--space-md); }
.contact-form { display: grid; gap: var(--space-md); }
.contact-field { display: grid; gap: var(--space-xs); min-width: 0; }
.contact-field input, .contact-field textarea { width: 100%; min-width: 0; }
.contact-actions { display: flex; justify-content: end; gap: var(--space-sm); }
</style>
