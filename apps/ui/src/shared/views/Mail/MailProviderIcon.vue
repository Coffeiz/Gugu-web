<script setup lang="ts">
import { PhEnvelopeSimple } from '@phosphor-icons/vue'

defineProps<{ src: string | null }>()
</script>

<template>
  <img v-if="src" :src="src" alt="" class="mail-provider-icon" width="18" height="18" />
  <PhEnvelopeSimple v-else :size="18" class="mail-provider-icon" aria-hidden="true" />
</template>

<style scoped>
.mail-provider-icon { flex: none; object-fit: contain; }
</style>
