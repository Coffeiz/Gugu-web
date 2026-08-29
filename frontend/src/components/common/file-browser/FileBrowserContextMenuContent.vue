<template>
  <template v-if="type === 'file' || type === 'multi-file'">
    <button v-if="type === 'file'" class="ctx-item popup-menu-item" @click="emit('action', 'info')">
      <PhInfo :size="13" weight="bold" />
      详细信息
    </button>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'download')">
      <PhDownloadSimple :size="13" weight="bold" />
      下载
    </button>
    <button v-if="type === 'file'" class="ctx-item popup-menu-item" @click="emit('action', 'rename')">
      <PhPencilSimple :size="13" weight="bold" />
      重命名
    </button>
    <div class="popup-menu-sep"></div>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'cut')">
      <PhScissors :size="13" weight="bold" />
      剪切
      <span class="popup-menu-shortcut">{{ modKey }}+X</span>
    </button>
    <button class="ctx-item popup-menu-item" @click="emit('action', 'copy')">
      <PhCopy :size="13" weight="bold" />
      复制
      <span class="popup-menu-shortcut">{{ modKey }}+C</span>
    </button>
    <div class="popup-menu-sep"></div>
    <button class="ctx-item popup-menu-item danger" @click="emit('action', 'delete')">
      <PhTrash :size="13" weight="bold" />
      移到回收站
    </button>
  </template>

  <template v-else-if="type === 'folder'">
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'download-folder')">
      <PhDownloadSimple :size="13" weight="bold" />
      下载为 ZIP
    </button>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'rename-folder')">
      <PhPencilSimple :size="13" weight="bold" />
      重命名
    </button>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item" @click="emit('action', 'cut-folder')">
      <PhScissors :size="13" weight="bold" />
      剪切
      <span class="popup-menu-shortcut">{{ modKey }}+X</span>
    </button>
    <button v-if="folderTargetValid && canCopyFolder" class="ctx-item popup-menu-item" @click="emit('action', 'copy-folder')">
      <PhCopy :size="13" weight="bold" />
      复制
      <span class="popup-menu-shortcut">{{ modKey }}+C</span>
    </button>
    <div v-if="folderTargetValid && ((canCopyFolder && copySeparator) || deleteSeparator)" class="popup-menu-sep"></div>
    <button v-if="folderTargetValid" class="ctx-item popup-menu-item danger" @click="emit('action', 'delete-folder')">
      <PhTrash :size="13" weight="bold" />
      删除
    </button>
    <button v-if="!folderTargetValid" class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
      <PhDotsThree :size="13" weight="bold" />
      此位置不可操作
    </button>
  </template>

  <template v-else-if="type === 'empty'">
    <button v-if="canCreateFolder" class="ctx-item popup-menu-item" @click="emit('action', 'create-folder')">
      <PhFolderPlus :size="13" weight="bold" />
      新建文件夹
    </button>
    <div v-if="canCreateFolder" class="popup-menu-sep"></div>
    <button v-if="canPaste" class="ctx-item popup-menu-item" @click="emit('action', 'paste')">
      <PhClipboardText :size="13" weight="bold" />
      粘贴
      <span class="popup-menu-shortcut">{{ modKey }}+V</span>
    </button>
    <button v-else class="ctx-item popup-menu-item" disabled style="opacity:.4;cursor:default">
      <PhClipboardText :size="13" weight="bold" />
      剪贴板为空
    </button>
  </template>
</template>

<script setup lang="ts">
import {
  PhClipboardText,
  PhCopy,
  PhDotsThree,
  PhDownloadSimple,
  PhFolderPlus,
  PhInfo,
  PhPencilSimple,
  PhScissors,
  PhTrash,
} from '@phosphor-icons/vue'
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
