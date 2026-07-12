<template>
  <aside class="canvas-sidebar glass-card" @pointerdown.stop>
    <div class="cs-head"><span>画布</span><button title="新建画布" @click="emit('create')"><PhPlus :size="15" weight="bold" /></button></div>
    <button
      v-for="canvas in canvases"
      :key="canvas.id"
      class="canvas-item"
      :class="{ active: canvas.id === activeId }"
      @click="emit('open', canvas.id)"
    >
      <PhGraph :size="14" weight="bold" />
      <span>{{ canvas.title || '未命名画布' }}</span>
    </button>
  </aside>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import { PhGraph, PhPlus } from '@phosphor-icons/vue'
import type { MindCanvas } from '@/services/api'

defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
})
const emit = defineEmits<{ (e: 'create'): void; (e: 'open', id: number): void }>()
</script>

<style scoped>
/* left 要加回 --sidebar-width：画布本体（.mind-canvas）铺满整个浏览器、含侧栏（AppSidebar）
   背后那一段（见 MindCanvas.vue），这块面板是 z-index:8 的浮层 UI，比侧栏的 z-index:20 低，
   若直接贴视口左缘 12px 会整个落进侧栏底下、被完全盖住（"画布切换面板被导航栏挡住"就是
   这么来的）——不靠裁切画布范围解决，而是让这块 UI 自己躲开侧栏占的那段宽度。 */
.canvas-sidebar { position: absolute; top: 12px; left: calc(var(--sidebar-width) + 12px); z-index: 8; width: 176px; padding: 9px; }
.cs-head { display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 5px 4px 7px; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.cs-head button { display: inline-flex; align-items: center; justify-content: center; width: 25px; height: 25px; border: 0; border-radius: 6px; background: none; color: var(--text-secondary); cursor: pointer; }
.cs-head button:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }
.canvas-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: 6px; background: none; color: var(--text-secondary); text-align: left; font-size: 12px; cursor: pointer; }
.canvas-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-item:hover { background: rgba(255,255,255,.55); }
.canvas-item.active { background: rgba(255,255,255,.86); color: var(--color-primary); font-weight: 700; box-shadow: 0 1px 3px rgba(60,70,100,.08); }
</style>
