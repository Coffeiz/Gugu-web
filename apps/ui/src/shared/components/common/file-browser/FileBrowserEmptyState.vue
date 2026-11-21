<template>
  <div :class="[variant === 'list' ? 'list-empty' : 'grid-empty', { 'trash-empty': variant === 'trash' && !loading }]" :role="loading ? 'status' : undefined" :aria-live="loading ? 'polite' : undefined">
    <span v-if="loading" class="file-browser-loading-spinner" aria-hidden="true"></span>
    <component :is="trashIcon" v-else-if="variant === 'trash'" :size="32" :style="{ color: trashAccent }" aria-hidden="true" />
    <svg v-else-if="variant === 'grid'" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
      <path d="M4 9a2 2 0 012-2h5l2 2h10a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V9z"/>
    </svg>
    <svg v-else width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity="0.3">
      <path d="M4 8a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z"/>
    </svg>
    <span class="file-browser-empty-text">{{ text }}</span>
  </div>
</template>

<script setup lang="ts">
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'

const { folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()
const trash = { type: 'trash' }
const trashIcon = folderListIcon(trash)
const trashAccent = folderAccentColor(trash)

defineProps({
  variant: { type: String as () => 'grid' | 'list' | 'trash', default: 'grid' },
  text: { type: String, default: '暂无文件' },
  loading: { type: Boolean, default: false },
})
</script>

<style scoped>
.list-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 8px; padding: 56px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.5;
}
.grid-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 72px 0;
  font-size: 12px; color: var(--text-secondary); opacity: 0.5;
}
.grid-empty.trash-empty { opacity: 1; }
.trash-empty .file-browser-empty-text { opacity: 0.5; }
.file-browser-loading-spinner { width:20px; height:20px; border:2px solid var(--border-subtle); border-top-color:var(--action-primary); border-radius:50%; animation:file-browser-spin .75s linear infinite; }
@keyframes file-browser-spin { to { transform:rotate(360deg); } }
</style>
