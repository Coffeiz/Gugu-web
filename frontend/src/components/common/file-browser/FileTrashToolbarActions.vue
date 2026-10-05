<template>
  <template v-if="hasItems">
  <button class="select-all-btn" :class="{ on: allSelected }" @click="emit('toggle-select')" :title="allSelected ? t('common.actions.clearSelection') : t('common.actions.selectAll')">
    {{ allSelected ? t('common.actions.clearSelection') : t('common.actions.selectAll') }}
    </button>
  </template>
  <div v-if="emptyBusy || emptyProgress" class="empty-trash-progress" role="status" aria-live="polite">
    <progress :value="emptyProgress?.done ?? 0" :max="Math.max(emptyProgress?.total ?? 1, 1)"></progress>
    <span v-if="emptyProgress">{{ t('filesViewUi.emptyTrashProgress', { done: emptyProgress.done, total: emptyProgress.total, failed: emptyProgress.failed }) }}</span>
    <span v-else>{{ t('filesViewUi.emptyTrashStarting') }}</span>
  </div>
  <button class="empty-trash-btn" :disabled="emptyBusy" @click.stop="emit('empty')"><Icon name="action.delete" :size="12" /> {{ t('common.actions.emptyTrash') }}</button>
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
import type { PropType } from 'vue'
import type { EmptyTrashProgress } from '@/composables/files/useFileLibraryTrashActions'
const { t } = useI18n()
defineProps({
  hasItems: Boolean,
  allSelected: Boolean,
  emptyBusy: Boolean,
  emptyProgress: { type: Object as PropType<EmptyTrashProgress | null>, default: null },
})
const emit = defineEmits<{ 'toggle-select': []; empty: [] }>()
</script>

<style scoped>
.empty-trash-progress { display: grid; grid-template-columns: minmax(60px, 100px) auto; align-items: center; gap: 6px; min-width: 0; color: var(--text-secondary); font-size: 11px; }
.empty-trash-progress progress {
  display: block;
  width: 100%;
  height: var(--progress-track-height);
  appearance: none;
  border: 0;
  border-radius: var(--progress-track-radius);
  background: var(--progress-track-bg);
  color: var(--progress-fill-bg);
}
.empty-trash-progress progress::-webkit-progress-bar {
  border: 0;
  border-radius: var(--progress-track-radius);
  background: var(--progress-track-bg);
}
.empty-trash-progress progress::-webkit-progress-value {
  border: 0;
  border-radius: var(--progress-track-radius);
  background: var(--progress-fill-bg);
}
.empty-trash-progress progress::-moz-progress-bar {
  border: 0;
  border-radius: var(--progress-track-radius);
  background: var(--progress-fill-bg);
}
.empty-trash-progress span { white-space: nowrap; }
.empty-trash-btn:disabled { opacity: .55; cursor: wait; }
</style>
