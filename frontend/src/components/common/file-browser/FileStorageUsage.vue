<template>
  <div v-if="loaded" class="storage-pill" :class="{ 'no-limit': limit === null }"
    :title="limit ? `已用 ${fmtBytes(used)} / ${fmtBytes(limit)}` : `已用 ${fmtBytes(used)}`">
    <template v-if="limit !== null">
      <div class="storage-bar-bg"><div class="storage-bar-fill" :style="fillStyle"></div></div>
    </template>
    <span class="storage-text">{{ fmtBytes(used) }}<template v-if="limit !== null"> / {{ fmtBytes(limit) }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { fmtBytes } from '@/utils/fileSize'

const props = defineProps({
  used: { type: Number, default: 0 },
  limit: { type: Number as PropType<number | null>, default: null },
  loaded: Boolean,
})
const fillStyle = computed(() => {
  if (!props.limit) return { width: '0%' }
  const pct = Math.min(100, (props.used / props.limit) * 100)
  const color = pct >= 90 ? '#c05050' : pct >= 70 ? '#b07858' : '#7b7fb2'
  return { width: `${pct}%`, background: color }
})
</script>

<style scoped>
.storage-pill { display: flex; align-items: center; gap: 7px; padding: 0 4px; height: 30px; flex-shrink: 0; }
.storage-bar-bg { width: 52px; height: 3px; border-radius: 2px; flex-shrink: 0; background: rgba(0,0,0,0.07); overflow: hidden; }
.storage-bar-fill { height: 100%; border-radius: 2px; transition: width 0.4s ease, background 0.4s; }
.storage-text { font-size: 11px; color: #8a8fa8; white-space: nowrap; }
</style>
