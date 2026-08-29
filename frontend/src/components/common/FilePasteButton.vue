<script setup lang="ts">
import { PhClipboardText } from '@phosphor-icons/vue'

defineProps({
  count: { type: Number, default: 0 },
  compact: { type: Boolean, default: false },
})
const emit = defineEmits<{ paste: [] }>()
</script>

<template>
  <button class="file-paste-button" :class="{ compact }" title="粘贴到当前位置" @click.stop="emit('paste')">
    <PhClipboardText :size="compact ? 12 : 13" weight="bold" />
    粘贴{{ count > 1 ? ` (${count})` : '' }}
  </button>
</template>
