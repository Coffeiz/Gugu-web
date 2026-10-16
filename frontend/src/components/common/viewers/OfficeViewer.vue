<template>
  <component
    :is="previewComponent"
    v-if="previewComponent"
    :blob-url="props.blobUrl"
    :ext="props.ext"
    :file-id="props.fileId"
    :file-version="props.fileVersion"
    @content-size="emitContentSize"
    @csv-render-failed="emitCsvRenderFailed"
  />
  <div v-else class="office-viewer-root">
    <div class="office-notice" role="note">{{ t('files.legacyOfficeHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DocxPreview from './office/DocxOfficePreview.vue'
import SpreadsheetPreview from './office/SpreadsheetOfficePreview.vue'
import PptxPreview from './office/PptxOfficePreview.vue'

const props = defineProps<{ blobUrl?: string; ext: string; fileId?: number; fileVersion?: number }>()
const emit = defineEmits<{
  (e: 'content-size', width: number, height: number): void
  (e: 'csv-render-failed'): void
}>()
const { t } = useI18n()

const previewComponent = computed(() => {
  const ext = props.ext.toLowerCase()
  if (ext === 'docx') return DocxPreview
  if (['csv', 'xls', 'xlsx'].includes(ext)) return SpreadsheetPreview
  if (ext === 'pptx') return PptxPreview
  return null
})

function emitContentSize(width: number, height: number) {
  emit('content-size', width, height)
}
function emitCsvRenderFailed() {
  emit('csv-render-failed')
}
</script>

<style scoped>
.office-viewer-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.office-notice {
  padding: 11px 14px;
  border-top: 1px solid var(--panel-glass-border);
  color: var(--content-secondary);
  font-size: 12px;
}
</style>
