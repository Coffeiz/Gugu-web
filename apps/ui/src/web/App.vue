<template>
  <router-view />
  <AppToast />
  <ConfirmDialog />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'
import { useBrowserReminderPermission } from '@/composables/schedules/browserNotifications'
import { undoManager } from '@/interaction/undo/UndoManager'

provideRuntime(runtime)
useBrowserReminderPermission()
onMounted(() => undoManager.start())
onBeforeUnmount(() => undoManager.stop())
</script>
