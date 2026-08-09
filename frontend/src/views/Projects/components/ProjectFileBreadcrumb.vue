<template>
  <FileBrowserBreadcrumb tag="nav" class-name="file-breadcrumb">
    <button class="pm-nav-hist-btn" :disabled="!canGoBack" @click="emit('goBack')" title="后退">
      <PhArrowLeft :size="13" weight="bold" />
    </button>
    <button class="pm-nav-hist-btn" :disabled="!canGoForward" @click="emit('goForward')" title="前进">
      <PhArrowRight :size="13" weight="bold" />
    </button>
    <button class="bc-seg" data-bc-idx="-1" :class="{ 'bc-drop-target': dragOverIndex === -1 }"
      :ref="(el: any) => bindEl?.(-1, el)"
      @click="emit('navigate', -1)">
      项目文件
    </button>
    <template v-for="(segment, index) in folderStack" :key="segment.id">
      <PhCaretRight :size="10" weight="bold" class="bc-sep" />
      <button v-if="index < folderStack.length - 1" class="bc-seg"
        :data-bc-idx="index"
        :class="{ 'bc-drop-target': dragOverIndex === index }"
        :ref="(el: any) => bindEl?.(index, el)"
        @click="emit('navigate', index)">
        {{ segment.name }}
      </button>
      <span v-else class="bc-seg bc-cur">{{ segment.name }}</span>
    </template>
  </FileBrowserBreadcrumb>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import type { FolderMeta } from '@/stores/filesCache'
import { PhArrowLeft, PhArrowRight, PhCaretRight } from '@phosphor-icons/vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'

defineProps({
  canGoBack: Boolean,
  canGoForward: Boolean,
  dragOverIndex: { type: Number, default: null },
  folderStack: { type: Array as PropType<FolderMeta[]>, required: true },
  // Runtime Core API 面包屑 Target 绑定：idx 与 data-bc-idx 一致（-1=项目文件根）。
  bindEl: { type: Function as PropType<(idx: number, el: HTMLElement | null) => void>, default: undefined },
})
const emit = defineEmits<{
  goBack: []
  goForward: []
  navigate: [index: number]
}>()
</script>
