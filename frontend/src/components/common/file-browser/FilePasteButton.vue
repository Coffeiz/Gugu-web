<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
defineProps({
  count: { type: Number, default: 0 },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits<{ paste: [] }>()
</script>

<template>
  <button class="file-paste-button" :class="{ compact }" :title="t('files.pasteHere')" @click.stop="emit('paste')">
    <Icon name="action.copy" :size="compact ? 12 : 13" />
    {{ t('common.actions.paste') }}{{ count > 1 ? ` (${count})` : '' }}
  </button>
</template>
