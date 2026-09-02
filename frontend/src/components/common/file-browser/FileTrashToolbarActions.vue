<template>
  <template v-if="hasItems">
  <button class="select-all-btn" :class="{ on: allSelected }" @click="emit('toggle-select')" :title="allSelected ? t('common.actions.clearSelection') : t('common.actions.selectAll')">
    {{ allSelected ? t('common.actions.clearSelection') : t('common.actions.selectAll') }}
    </button>
  </template>
  <button class="empty-trash-btn" @click.stop="emit('empty')"><Icon name="action.delete" :size="12" /> {{ t('common.actions.emptyTrash') }}</button>
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
defineProps({ hasItems: Boolean, allSelected: Boolean })
const emit = defineEmits<{ 'toggle-select': []; empty: [] }>()
</script>
