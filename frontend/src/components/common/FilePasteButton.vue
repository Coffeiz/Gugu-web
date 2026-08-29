<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
defineProps({
  count: { type: Number, default: 0 },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits<{ paste: [] }>()
</script>

<template>
  <button class="file-paste-button" :class="{ compact }" title="粘贴到当前位置" @click.stop="emit('paste')">
    <Icon name="action.copy" :size="compact ? 12 : 13" />
    粘贴{{ count > 1 ? ` (${count})` : '' }}
  </button>
</template>
