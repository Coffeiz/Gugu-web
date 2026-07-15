<script setup lang="ts">
import {
  PhCheck,
  PhCopy,
  PhDownloadSimple,
  PhScissors,
  PhTrash,
} from '@phosphor-icons/vue'

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
</script>

<template>
  <Transition name="file-action-bar">
    <div class="file-selection-toolbar" :class="{ compact, trash }" @click.stop>
      <span class="file-selection-count">已选 {{ fileCount + folderCount }} 项</span>

      <template v-if="trash">
        <button class="file-selection-btn" @click="emit('restore')">
          <PhCheck :size="compact ? 11 : 12" weight="bold" />
          恢复选中
        </button>
        <button class="file-selection-btn danger" @click="emit('permanentDelete')">
          <PhTrash :size="compact ? 11 : 12" weight="bold" />
          永久删除
        </button>
      </template>

      <template v-else>
        <button class="file-selection-btn" :disabled="downloading" @click="emit('download')">
          <PhDownloadSimple v-if="!downloading" :size="compact ? 11 : 12" weight="bold" />
          <span v-else class="file-selection-spinner" />
          {{ downloading ? '下载中…' : '下载' }}
        </button>
        <span class="file-selection-divider" />
        <button class="file-selection-btn" @click="emit('cut')">
          <PhScissors :size="compact ? 11 : 12" weight="bold" />
          剪切
        </button>
        <button class="file-selection-btn" @click="emit('copy')">
          <PhCopy :size="compact ? 11 : 12" weight="bold" />
          复制
        </button>
        <span class="file-selection-divider" />
        <button class="file-selection-btn danger" @click="emit('delete')">
          <PhTrash :size="compact ? 11 : 12" weight="bold" />
          删除
        </button>
      </template>

      <button class="file-selection-cancel" @click="emit('cancel')">取消</button>
    </div>
  </Transition>
</template>

<style scoped>
.file-selection-toolbar {
  position: absolute;
  left: 50%;
  bottom: 20px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 16px;
  border: 0;
  border-radius: 14px;
  background: rgba(30,32,44,.88);
  box-shadow: 0 8px 32px rgba(0,0,0,.22);
  color: rgba(255,255,255,.9);
  backdrop-filter: blur(18px);
  z-index: 100;
  white-space: nowrap;
}
.file-selection-toolbar.compact { bottom: 11px; padding: 8px 14px; gap: 8px; border-radius: 12px; z-index: 50; }
.file-selection-count { margin-right: 3px; white-space: nowrap; font-size: 12px; color: rgba(255,255,255,.75); }
.file-selection-btn, .file-selection-cancel {
  display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: 6px;
  padding: 6px 11px; border: 0; background: rgba(255,255,255,.12); color: rgba(255,255,255,.9); cursor: pointer; font: inherit; font-size: 12px; font-weight: 500;
}
.compact .file-selection-btn, .compact .file-selection-cancel { padding: 5px 10px; font-size: 11px; }
.file-selection-btn:hover, .file-selection-cancel:hover { background: rgba(255,255,255,.22); color: white; }
.file-selection-btn:disabled { opacity: .55; cursor: default; }
.file-selection-btn.danger { background: rgba(200,90,90,.85); color: white; }
.file-selection-btn.danger:hover { background: rgba(200,90,90,1); }
.file-selection-divider { width: 1px; height: 18px; background: rgba(255,255,255,.18); margin: 0 2px; }
.file-selection-cancel { margin-left: 1px; background: rgba(255,255,255,.12); color: rgba(255,255,255,.7); }
.file-selection-spinner { width: 11px; height: 11px; border: 1.5px solid rgba(255,255,255,.25); border-top-color: white; border-radius: 50%; animation: file-spin .7s linear infinite; }
@keyframes file-spin { to { transform: rotate(360deg); } }
.file-action-bar-enter-active, .file-action-bar-leave-active { transition: opacity .18s, transform .18s; }
.file-action-bar-enter-from, .file-action-bar-leave-to { opacity: 0; transform: translateY(5px); }
</style>
