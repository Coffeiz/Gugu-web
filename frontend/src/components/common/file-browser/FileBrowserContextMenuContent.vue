<template>
  <template v-if="type === 'file' || type === 'multi-file'">
    <button v-if="type === 'file'" class="ctx-item popup-menu-item" @click="emit('action', 'info')">
      <Icon name="status.info" :size="13" />
      详细信息
    </button>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'download')">
      <Icon name="action.download" :size="13" />
      下载
    </button>
    <button v-if="type === 'file'" class="ctx-item popup-menu-item" @click="emit('action', 'rename')">
      <Icon name="action.edit" :size="13" />
      重命名
    </button>
    <div class="popup-menu-sep"></div>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'cut')">
      <Icon name="action.cut" :size="13" />
      剪切
      <span class="popup-menu-shortcut">{{ modKey }}+X</span>
    </button>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'copy')">
      <Icon name="action.copy" :size="13" />
      复制
      <span class="popup-menu-shortcut">{{ modKey }}+C</span>
    </button>
    <div class="popup-menu-sep"></div>
    <button class="ctx-item popup-menu-item danger" @click="emit('action', 'delete')">
      <Icon name="action.delete" :size="13" />
      移到回收站
    </button>
  </template>

  <template v-else-if="type === 'folder'">
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'download-folder')">
      <Icon name="action.download" :size="13" />
      下载为 ZIP
    </button>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'rename-folder')">
      <Icon name="action.edit" :size="13" />
      重命名
    </button>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'cut-folder')">
      <Icon name="action.cut" :size="13" />
      剪切
      <span class="popup-menu-shortcut">{{ modKey }}+X</span>
    </button>
    <button v-if="folderTargetValid && canCopyFolder" class="ctx-item popup-menu-item" @click="emit('action', 'copy-folder')">
      <Icon name="action.copy" :size="13" />
      复制
      <span class="popup-menu-shortcut">{{ modKey }}+C</span>
    </button>
    <div v-if="folderTargetValid && ((canCopyFolder && copySeparator) || deleteSeparator)" class="popup-menu-sep"></div>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item danger" @click="emit('action', 'delete-folder')">
      <Icon name="action.delete" :size="13" />
      删除
    </button>
    <button v-if="!folderTargetValid" class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
      <Icon name="action.more" :size="13" />
      此位置不可操作
    </button>
  </template>

  <template v-else-if="type === 'empty'">
    <button v-if="canCreateFolder" class="ctx-item popup-menu-item" @click="emit('action', 'create-folder')">
      <Icon name="file.folder-add" :size="13" />
      新建文件夹
    </button>
    <div v-if="canCreateFolder" class="popup-menu-sep"></div>
    <button v-if="canPaste" class="ctx-item popup-menu-item" @click="emit('action', 'paste')">
      <Icon name="action.copy" :size="13" />
      粘贴
      <span class="popup-menu-shortcut">{{ modKey }}+V</span>
    </button>
    <button v-else class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
      <Icon name="action.copy" :size="13" />
      剪贴板为空
    </button>
  </template>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import type { PropType } from 'vue'

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
