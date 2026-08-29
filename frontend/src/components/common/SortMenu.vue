<script setup lang="ts" generic="T">
import { ref } from 'vue'
import ContextMenu from '@/components/ContextMenu.vue'
import Icon from '@/components/common/Icon.vue'
import type { SortOption } from '@/composables/useSortedList'

defineProps({
  options: { type: Array as () => SortOption<T>[], required: true },
  sortKey: { type: String, required: true },
  sortDir: { type: String as () => 'asc' | 'desc', required: true },
  /** 可选：按钮里的语义图标。传空字符串不显示。 */
  icon: { type: String, default: 'action.sort' },
})

const emit = defineEmits<{
  select: [key: string]
}>()

const sortBtnRef   = ref<HTMLElement | null>(null)
const sortMenuOpen = ref(false)
const sortMenuPos  = ref<{ x: number; y: number }>({ x: 0, y: 0 })

function openMenu() {
  if (sortMenuOpen.value) { sortMenuOpen.value = false; return }
  const r = sortBtnRef.value?.getBoundingClientRect()
  // ContextMenu 的基础宽度为 160px；用按钮中心作为锚点，避免菜单左边缘跟按钮左边缘对齐造成视觉偏移。
  if (r) { sortMenuPos.value = { x: r.left + r.width / 2 - 80, y: r.bottom + 6 } }
  sortMenuOpen.value = true
}

function onSelect(key: string) {
  emit('select', key)
}

function closeMenu() { sortMenuOpen.value = false }

defineExpose({ closeMenu })
</script>

<template>
  <div class="sort-selector" @click.stop>
    <button
      ref="sortBtnRef"
      class="sort-btn"
      type="button"
      @click.stop="openMenu"
    >
      <Icon :name="icon" v-if="icon" size="sm" tone="inherit" />
      {{ options.find(o => o.key === sortKey)?.label ?? '' }}
      <svg
        class="sort-dir-icon"
        :class="{ desc: sortDir === 'desc' }"
        width="9" height="9" viewBox="0 0 10 10" fill="none"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      >
        <path d="M5 2v6M2 5l3-3 3 3" />
      </svg>
    </button>
    <!-- 与右键菜单同源：Teleport 到 body，backdrop-filter 才能正确生效 -->
    <ContextMenu :show="sortMenuOpen" :anchor="sortBtnRef" :x="sortMenuPos.x" :y="sortMenuPos.y" @close="closeMenu">
      <button
        v-for="opt in options"
        :key="opt.key"
        class="ctx-item popup-menu-item sort-menu-item"
        :class="{ active: opt.key === sortKey }"
        type="button"
        @click="onSelect(opt.key)"
      >
        {{ opt.label }}
        <svg
          v-if="opt.key === sortKey"
          class="sort-check"
          :class="{ desc: sortDir === 'desc' }"
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
        >
          <path d="M5 2v6M2 5l3-3 3 3" />
        </svg>
      </button>
    </ContextMenu>
  </div>
</template>

<style scoped>
.sort-selector { position: relative; }
.sort-btn {
  display: flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 10px; border-radius: 8px; border: none;
  background: rgba(255,255,255,0.55); cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--color-primary);
  font-family: var(--font-sans); transition: background 0.15s, color 0.15s;
}
.sort-btn:hover { background: rgba(255,255,255,0.82); }
.sort-dir-icon { transition: transform 0.2s; }
.sort-dir-icon.desc { transform: rotate(180deg); }
/* 排序弹窗经 ContextMenu(Teleport 到 body) 渲染，外观与右键菜单完全一致 */
.sort-check { flex-shrink: 0; margin-left: auto; color: var(--color-primary); }
.sort-check.desc { transform: rotate(180deg); }
</style>
