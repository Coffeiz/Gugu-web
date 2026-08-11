<template>
  <router-view />
  <AppToast />
</template>

<script setup lang="ts">
import AppToast from '@/components/common/AppToast.vue'
import { runtime } from '@/interaction/runtime'
import { provideRuntime } from '@/interaction/runtime/vue'

provideRuntime(runtime)
</script>
