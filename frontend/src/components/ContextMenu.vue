<template>
  <Teleport to="body">
    <div v-if="show" ref="el" class="ctx-menu popup-menu" :style="style" @click.stop @contextmenu.prevent>
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'

const props = defineProps({ show: Boolean, x: Number, y: Number })
const emit  = defineEmits(['close'])
const el    = ref(null)

const style = computed(() => ({
  position: 'fixed' as const,
  left: props.x + 'px',
  top:  props.y + 'px',
  zIndex: 9999,
}))

function close() { emit('close') }

function onKey(e) {
  if (e.key === 'Escape') close()
}

watch(() => props.show, async (v) => {
  if (v) {
    await nextTick()
    // 边缘修正
    if (el.value) {
      const rect = el.value.getBoundingClientRect()
      if (rect.right  > window.innerWidth)  el.value.style.left = (props.x - rect.width)  + 'px'
      if (rect.bottom > window.innerHeight) el.value.style.top  = (props.y - rect.height) + 'px'
    }
    setTimeout(() => document.addEventListener('click',       close, { once: true }), 0)
    setTimeout(() => document.addEventListener('contextmenu', close, { once: true }), 0)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('click',       close)
    document.removeEventListener('contextmenu', close)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('click',       close)
  document.removeEventListener('contextmenu', close)
})
</script>

<style scoped>
.ctx-menu { min-width: 160px; }
</style>
