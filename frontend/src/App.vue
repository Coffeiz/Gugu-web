<template>
  <router-view />
  <AppToast />
  <ConfirmDialog />
</template>

<script setup lang="ts">
import AppToast from '@/components/common/feedback/AppToast.vue'
import ConfirmDialog from '@/components/common/overlays/ConfirmDialog.vue'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'

provideRuntime(runtime)
</script>
