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

<style scoped>
.file-paste-button {
  display: flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 12px; border: none; border-radius: 8px;
  background: rgba(255,255,255,0.55); color: var(--color-primary); cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 600; font-family: var(--font-sans);
  white-space: nowrap; transition: background 0.15s, box-shadow 0.15s;
}
.file-paste-button:hover { background: rgba(255,255,255,0.82); box-shadow: 0 1px 4px rgba(123,127,178,0.18); }
.file-paste-button svg { display: block; }
.file-paste-button.compact { padding: 0 12px; font-size: 12px; }
</style>
