<template>
  <Teleport to="body">
    <div v-if="show" ref="el" class="ctx-menu" :style="style" @click.stop @contextmenu.prevent>
      <slot />
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'

const props = defineProps({ show: Boolean, x: Number, y: Number })
const emit  = defineEmits(['close'])
const el    = ref(null)

const style = computed(() => ({
  position: 'fixed',
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
.ctx-menu {
  background: rgba(255,255,255,0.96);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
  padding: 4px;
  min-width: 160px;
  user-select: none;
}
</style>
