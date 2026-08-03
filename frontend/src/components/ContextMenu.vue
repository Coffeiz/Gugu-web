<template>
  <Teleport to="body">
    <Transition name="menu-pop" :duration="{ enter: 240, leave: 180 }">
      <div v-if="show" ref="el" class="ctx-menu popup-menu" :style="style" @click.stop @contextmenu.prevent>
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { nextZ } from '@/composables/windowz'

const props = defineProps({ show: Boolean, x: Number, y: Number })
const emit  = defineEmits(['close'])
const el    = ref<HTMLElement | null>(null)

// 每次弹出领新 z：保证盖在当前最顶的窗口（编辑卡/预览器…）之上
const myZ = ref(0)
watch(() => props.show, v => { if (v) myZ.value = nextZ() })

const style = computed(() => ({
  position: 'fixed' as const,
  left: (props.x ?? 0) + 'px',
  top:  (props.y ?? 0) + 'px',
  zIndex: myZ.value,
}))

function close() { emit('close') }

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

watch(() => props.show, async (v) => {
  if (v) {
    await nextTick()
    // 边缘修正
    if (el.value) {
      const rect = el.value.getBoundingClientRect()
      if (rect.right  > window.innerWidth)  el.value.style.left = ((props.x ?? 0) - rect.width)  + 'px'
      if (rect.bottom > window.innerHeight) el.value.style.top  = ((props.y ?? 0) - rect.height) + 'px'
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
