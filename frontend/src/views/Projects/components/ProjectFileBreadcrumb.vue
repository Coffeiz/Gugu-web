<template>
  <FileBrowserBreadcrumb tag="nav" class-name="file-breadcrumb">
    <button class="pm-nav-hist-btn" :disabled="!canGoBack" @click="emit('goBack')" title="后退">
      <Icon name="action.back" :size="13" />
    </button>
    <button class="pm-nav-hist-btn" :disabled="!canGoForward" @click="emit('goForward')" title="前进">
      <Icon name="action.next" :size="13" />
    </button>
    <button v-if="folderStack.length === 0" class="bc-seg"
      data-bc-idx="-1" @click="emit('navigate', -1)">
      <span class="bc-label">项目文件</span>
    </button>
    <RuntimeBreadcrumbTarget v-else class="bc-seg" target-id="bc:-1"
      :surface-id="breadcrumbSurfaceId(runtimeScope, -1)"
      data-bc-idx="-1" @click="emit('navigate', -1)">
        <span class="bc-label">项目文件</span>
    </RuntimeBreadcrumbTarget>
    <template v-for="(segment, index) in folderStack" :key="segment.id">
      <Icon name="action.next" :size="10" class="bc-sep" />
      <RuntimeBreadcrumbTarget v-if="index < folderStack.length - 1" class="bc-seg"
        :target-id="`bc:${index}`"
        :surface-id="breadcrumbSurfaceId(runtimeScope, index)"
        :data-bc-idx="index"
        @click="emit('navigate', index)">
        <span class="bc-label">{{ segment.name }}</span>
      </RuntimeBreadcrumbTarget>
      <span v-else class="bc-seg bc-cur"><span class="bc-label">{{ segment.name }}</span></span>
    </template>
  </FileBrowserBreadcrumb>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import type { PropType } from 'vue'
import type { FolderMeta } from '@/stores/filesCache'
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
