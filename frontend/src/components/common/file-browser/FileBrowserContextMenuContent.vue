<template>
  <template v-if="type === 'file' || type === 'multi-file'">
    <button v-if="type === 'file'" class="ctx-item popup-menu-item" @click="emit('action', 'info')">
      <Icon name="status.info" :size="13" />
      {{ t('sharedUi.info') }}
    </button>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'download')">
      <Icon name="action.download" :size="13" />
      {{ t('sharedUi.download') }}
    </button>
    <button v-if="type === 'file'" class="ctx-item popup-menu-item" @click="emit('action', 'rename')">
      <Icon name="action.edit" :size="13" />
      {{ t('sharedUi.rename') }}
    </button>
    <div class="popup-menu-sep"></div>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'cut')">
      <Icon name="action.cut" :size="13" />
      {{ t('sharedUi.cut') }}
      <span class="popup-menu-shortcut">{{ modKey }}+X</span>
    </button>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'copy')">
      <Icon name="action.copy" :size="13" />
      {{ t('sharedUi.copy') }}
      <span class="popup-menu-shortcut">{{ modKey }}+C</span>
    </button>
    <div class="popup-menu-sep"></div>
    <button class="ctx-item popup-menu-item danger" @click="emit('action', 'delete')">
      <Icon name="action.delete" :size="13" />
      {{ t('sharedUi.moveToTrash') }}
    </button>
  </template>

  <template v-else-if="type === 'folder'">
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'download-folder')">
      <Icon name="action.download" :size="13" />
      {{ t('sharedUi.downloadZip') }}
    </button>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'rename-folder')">
      <Icon name="action.edit" :size="13" />
      {{ t('sharedUi.rename') }}
    </button>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'cut-folder')">
      <Icon name="action.cut" :size="13" />
      {{ t('sharedUi.cut') }}
      <span class="popup-menu-shortcut">{{ modKey }}+X</span>
    </button>
    <button v-if="folderTargetValid && canCopyFolder" class="ctx-item popup-menu-item" @click="emit('action', 'copy-folder')">
      <Icon name="action.copy" :size="13" />
      {{ t('sharedUi.copy') }}
      <span class="popup-menu-shortcut">{{ modKey }}+C</span>
    </button>
    <div v-if="folderTargetValid && ((canCopyFolder && copySeparator) || deleteSeparator)" class="popup-menu-sep"></div>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item danger" @click="emit('action', 'delete-folder')">
      <Icon name="action.delete" :size="13" />
      {{ t('common.actions.delete') }}
    </button>
    <button v-if="!folderTargetValid" class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
      <Icon name="action.more" :size="13" />
      {{ t('sharedUi.cannotOperate') }}
    </button>
  </template>

  <template v-else-if="type === 'empty'">
    <button v-if="canCreateFolder" class="ctx-item popup-menu-item" @click="emit('action', 'create-folder')">
      <Icon name="file.folder-add" :size="13" />
      {{ t('sharedUi.createFolder') }}
    </button>
    <div v-if="canCreateFolder" class="popup-menu-sep"></div>
    <button v-if="canPaste" class="ctx-item popup-menu-item" @click="emit('action', 'paste')">
      <Icon name="action.copy" :size="13" />
      {{ t('sharedUi.paste') }}
      <span class="popup-menu-shortcut">{{ modKey }}+V</span>
    </button>
    <button v-else class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
      <Icon name="action.copy" :size="13" />
      {{ t('sharedUi.clipboardEmpty') }}
    </button>
  </template>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps({
  type: { type: String as PropType<string | null>, default: null },
  modKey: { type: String, default: '⌘' },
  folderTargetValid: { type: Boolean, default: true },
  canCopyFolder: { type: Boolean, default: true },
  copySeparator: { type: Boolean, default: false },
  deleteSeparator: { type: Boolean, default: false },
  canCreateFolder: { type: Boolean, default: true },
  canPaste: { type: Boolean, default: false },
})

const emit = defineEmits(['action'])
</script>
