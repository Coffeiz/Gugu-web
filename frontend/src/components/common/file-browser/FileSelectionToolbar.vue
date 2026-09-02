<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
defineProps({
  fileCount: { type: Number, default: 0 },
  folderCount: { type: Number, default: 0 },
  downloading: { type: Boolean, default: false },
  trash: { type: Boolean, default: false },
  compact: { type: Boolean, default: false },
})

const emit = defineEmits<{
  download: []
  cut: []
  copy: []
  delete: []
  restore: []
  permanentDelete: []
  cancel: []
}>()
const { t } = useI18n()
</script>

<template>
  <div class="file-selection-toolbar" :class="{ compact, trash }" @click.stop>
    <span class="file-selection-count">{{ t('common.selected', { count: fileCount + folderCount }) }}</span>

    <template v-if="trash">
      <button class="file-selection-btn" @click="emit('restore')">
        <Icon name="status.success" :size="compact ? 11 : 12" />
        {{ t('common.actions.restore') }}
      </button>
      <button class="file-selection-btn danger" @click="emit('permanentDelete')">
        <Icon name="action.delete" :size="compact ? 11 : 12" />
        {{ t('common.actions.permanentDelete') }}
      </button>
    </template>

    <template v-else>
      <button class="file-selection-btn" :disabled="downloading" @click="emit('download')">
        <Icon name="action.download" v-if="!downloading" :size="compact ? 11 : 12" />
        <span v-else class="file-selection-spinner" />
        {{ downloading ? t('common.status.processing') : t('common.actions.download') }}
      </button>
      <span class="file-selection-divider" />
      <button class="file-selection-btn" @click="emit('cut')">
        <Icon name="action.cut" :size="compact ? 11 : 12" />
        {{ t('common.actions.cut') }}
      </button>
      <button class="file-selection-btn" @click="emit('copy')">
        <Icon name="action.copy" :size="compact ? 11 : 12" />
        {{ t('common.actions.copy') }}
      </button>
      <span class="file-selection-divider" />
      <button class="file-selection-btn danger" @click="emit('delete')">
        <Icon name="action.delete" :size="compact ? 11 : 12" />
        {{ t('common.actions.delete') }}
      </button>
    </template>

    <button class="file-selection-cancel" @click="emit('cancel')">{{ t('common.actions.cancel') }}</button>
  </div>
</template>

<style scoped>
/* 浮动栏只有这一份实体 paint；Light / Dark 均由共享 popup/control/danger token 解析。
   position:absolute 由宿主的相对定位容器决定坐标系：文件页挂 files-page，项目编辑卡挂 modal-right。 */
.file-selection-toolbar {
  position: absolute;
  left: 50%;
  bottom: 20px;
  z-index: var(--layer-popup);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 16px;
  border: 1px solid var(--popup-surface-border);
  border-radius: var(--radius-md);
  background: var(--popup-surface-bg);
  box-shadow: inset 0 1px 0 var(--popup-surface-highlight), var(--popup-surface-shadow);
  color: var(--content-primary);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
  white-space: nowrap;
}
.file-selection-toolbar.compact {
  bottom: 11px;
  padding: 8px 14px;
  gap: 8px;
  border-radius: var(--radius-sm);
}
.file-selection-count {
  margin-right: 3px;
  white-space: nowrap;
  font-size: 12px;
  color: var(--content-secondary);
}
.file-selection-btn,
.file-selection-cancel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 11px;
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  background: var(--control-bg);
  color: var(--control-fg);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  transition:
    color var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.compact .file-selection-btn,
.compact .file-selection-cancel {
  padding: 5px 10px;
  font-size: 11px;
}
.file-selection-btn:hover,
.file-selection-cancel:hover {
  background: var(--control-bg-hover);
  border-color: var(--control-border-hover);
  color: var(--control-fg-strong);
}
.file-selection-btn:disabled {
  opacity: .55;
  cursor: default;
}
.file-selection-btn:disabled:hover {
  background: var(--control-bg);
  border-color: var(--control-border);
  color: var(--control-fg);
}
.file-selection-btn.danger {
  background: var(--danger-button-bg);
  border-color: var(--danger-button-border);
  color: var(--danger-button-fg);
}
.file-selection-btn.danger:hover {
  background: var(--danger-button-bg-hover);
  border-color: var(--danger-button-border-hover);
  color: var(--danger-button-fg);
}
.file-selection-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  flex-shrink: 0;
  background: var(--popup-divider);
}
.file-selection-cancel {
  margin-left: 1px;
  color: var(--content-secondary);
}
.file-selection-spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid var(--control-border-hover);
  border-top-color: var(--action-primary);
  border-radius: 50%;
  animation: file-spin .7s linear infinite;
}
@keyframes file-spin { to { transform: rotate(360deg); } }
</style>
