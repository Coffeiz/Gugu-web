<template>
  <router-view />
  <AppToast />
  <ConfirmDialog />
  <UndoHistoryPanel />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
import UndoHistoryPanel from '@/interaction/undo/UndoHistoryPanel.vue'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'
import { undoManager } from '@/interaction/undo/UndoManager'

provideRuntime(runtime)
onMounted(() => undoManager.start())
onBeforeUnmount(() => undoManager.stop())
</script>
