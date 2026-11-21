<template>
  <div class="log-entry">
    <div class="log-body">
      <div class="log-message">{{ message }}</div>
      <dl v-if="context.length" class="log-context">
        <div v-for="({ key, value }, index) in context" :key="index" class="log-field">
          <dt>{{ key }}</dt>
          <dd>{{ value }}</dd>
        </div>
      </dl>
    </div>
    <div class="log-actions">
      <span v-if="copyStatus" role="status">{{ t(copyStatus) }}</span>
      <button class="log-copy-button" type="button" :title="t('adminLogs.copy')"
        :aria-label="t('adminLogs.copy')" @click="copyOriginal">
        <Icon name="action.copy" size="sm" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
import { copyTextToClipboard } from '@/components/common/gugu-chat/composables/copyTextToClipboard'

const props = defineProps({
  line: { type: String, required: true },
  message: { type: String, required: true },
})
const { t } = useI18n()
const copyStatus = ref('')

const context = computed(() => {
  const raw = props.line.replace(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*/, '').trim()
  if (!raw.startsWith('{') || raw === props.message.trim()) return []
  try {
    const { time, message, attributes, ...fields } = JSON.parse(raw)
    const extras = attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? Object.entries(attributes) : attributes === undefined ? [] : [['attributes', attributes]]
    const summaryFields = new Map<string, string>([
      ['round', `第 ${fields.round} 轮`],
      ['elapsedMs', `耗时 ${attributes?.elapsedMs} 毫秒`],
      ['httpStatus', `HTTP ${attributes?.httpStatus}`],
      ['signal', String(attributes?.signal ?? '')],
    ])
    const summaryParts = props.message.split(' · ')
    return [...Object.entries(fields), ...extras]
      .filter(([key]) => !summaryParts.includes(summaryFields.get(key) ?? ''))
      .map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }))
  } catch {
    return []
  }
})

async function copyOriginal() {
  copyStatus.value = await copyTextToClipboard(props.line) ? 'adminLogs.copied' : 'adminLogs.copyFailed'
}
</script>

<style scoped>
.log-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; min-width: 0; }
.log-body { align-self: center; min-width: 0; }
.log-message { font-weight: 600; overflow-wrap: anywhere; white-space: pre-wrap; }
.log-context { display: flex; flex-wrap: wrap; gap: 3px 14px; margin: 4px 0 0; font-size: 11px; }
.log-field { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; max-width: 100%; }
.log-field dt { flex-shrink: 0; color: var(--content-tertiary); }
.log-field dd { min-width: 0; margin: 0; color: var(--content-secondary); overflow-wrap: anywhere; }
.log-actions { display: flex; align-items: center; gap: 8px; color: var(--content-secondary); }
.log-copy-button {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--content-secondary);
  cursor: pointer;
}
.log-copy-button:hover { background: var(--action-soft); color: var(--content-primary); }
</style>
