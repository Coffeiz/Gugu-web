<template>
  <button
    class="icon-btn"
    :class="{ spinning: loading || spinning }"
    :disabled="disabled || loading"
    :title="title"
    :aria-label="ariaLabel || title"
    type="button"
    @click="handleClick"
  >
    <Icon name="action.refresh" size="sm" />
  </button>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import Icon from '@/components/common/icons/Icon.vue'

withDefaults(defineProps<{
  title: string
  ariaLabel?: string
  loading?: boolean
  disabled?: boolean
}>(), { loading: false, disabled: false })

const emit = defineEmits<{ click: [] }>()
const spinning = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function handleClick() {
  spinning.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { spinning.value = false }, 550)
  emit('click')
}

onBeforeUnmount(() => { if (timer) clearTimeout(timer) })
</script>

<style scoped>
.icon-btn {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-subtle); background: var(--surface-glass);
  color: var(--content-secondary); cursor: pointer;
  transition: all var(--motion-fast) var(--motion-ease-standard);
}
.icon-btn:hover { background: var(--surface-glass-hover); color: var(--content-primary); }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.icon-btn.spinning :deep(svg) {
  animation: refresh-button-spin 0.5s ease-out;
  transform-box: fill-box; transform-origin: center;
}
@keyframes refresh-button-spin { to { transform: rotate(360deg); } }
</style>
