<template>
  <FileBrowserBreadcrumb tag="nav" class-name="file-breadcrumb">
    <button class="pm-nav-hist-btn" :disabled="!canGoBack" @click="emit('goBack')" title="后退">
      <PhArrowLeft :size="13" weight="bold" />
    </button>
    <button class="pm-nav-hist-btn" :disabled="!canGoForward" @click="emit('goForward')" title="前进">
      <PhArrowRight :size="13" weight="bold" />
    </button>
    <RuntimeBreadcrumbTarget class="bc-seg" target-id="bc:-1"
      :surface-id="breadcrumbSurfaceId(runtimeScope, -1)"
      data-bc-idx="-1" @click="emit('navigate', -1)">
      项目文件
    </RuntimeBreadcrumbTarget>
    <template v-for="(segment, index) in folderStack" :key="segment.id">
      <PhCaretRight :size="10" weight="bold" class="bc-sep" />
      <RuntimeBreadcrumbTarget v-if="index < folderStack.length - 1" class="bc-seg"
        :target-id="`bc:${index}`"
        :surface-id="breadcrumbSurfaceId(runtimeScope, index)"
        :data-bc-idx="index"
        @click="emit('navigate', index)">
        {{ segment.name }}
      </RuntimeBreadcrumbTarget>
      <span v-else class="bc-seg bc-cur">{{ segment.name }}</span>
    </template>
  </FileBrowserBreadcrumb>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import type { FolderMeta } from '@/stores/filesCache'
import { PhArrowLeft, PhArrowRight, PhCaretRight } from '@phosphor-icons/vue'
import FileBrowserBreadcrumb from '@/components/common/file-browser/FileBrowserBreadcrumb.vue'
import RuntimeBreadcrumbTarget from '@/components/common/file-browser/RuntimeBreadcrumbTarget.vue'
import { breadcrumbSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'

defineProps({
  canGoBack: Boolean,
  canGoForward: Boolean,
  folderStack: { type: Array as PropType<FolderMeta[]>, required: true },
  runtimeScope: { type: String, required: true },
})
const emit = defineEmits<{
  goBack: []
  goForward: []
  navigate: [index: number]
}>()
</script>
