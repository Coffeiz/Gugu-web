<template>
  <ActionButton v-if="hasItems" variant="secondary" fit :aria-pressed="allSelected" @click.stop="emit('toggle-select')">
    {{ allSelected ? t('common.actions.clearSelection') : t('common.actions.selectAll') }}
  </ActionButton>
  <div v-if="emptyBusy || emptyProgress" class="empty-trash-progress" role="status" aria-live="polite">
    <progress :value="emptyProgress?.done ?? 0" :max="Math.max(emptyProgress?.total ?? 1, 1)"></progress>
    <span v-if="emptyProgress">{{ t('filesViewUi.emptyTrashProgress', { done: emptyProgress.done, total: emptyProgress.total, failed: emptyProgress.failed }) }}</span>
    <span v-else>{{ t('filesViewUi.emptyTrashStarting') }}</span>
  </div>
  <ActionButton variant="danger" fit class="empty-trash-btn" :disabled="!hasItems || emptyBusy" @click.stop="emit('empty')"><Icon name="action.delete" :size="13" />{{ t('common.actions.emptyTrash') }}</ActionButton>
</template>

<script setup lang="ts">
import ActionButton from '@/components/common/controls/ActionButton.vue'
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
.empty-trash-progress progress { inline-size: 100%; }
.empty-trash-progress span { white-space: nowrap; }
</style>
