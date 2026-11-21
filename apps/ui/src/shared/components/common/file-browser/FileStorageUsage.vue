<template>
  <div v-if="loaded" class="storage-pill" :class="{ 'no-limit': limit === null }"
    :title="limit ? t('filesViewUi.storageUsedWithLimit', { used: fmtBytes(used), limit: fmtBytes(limit) }) : t('filesViewUi.storageUsed', { used: fmtBytes(used) })">
    <template v-if="limit !== null">
      <div class="storage-bar-bg"><div class="storage-bar-fill" :style="fillStyle"></div></div>
    </template>
    <span class="storage-text">{{ fmtBytes(used) }}<template v-if="limit !== null"> / {{ fmtBytes(limit) }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { fmtBytes } from '@/utils/fileSize'

const { t } = useI18n()

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
/* 这里只保留存储进度条自身的结构；toolbar 文字颜色/字号/高度由统一文件工具栏契约负责。 */
.storage-pill { display: flex; align-items: center; gap: 7px; padding: 0 4px; flex-shrink: 0; }
.storage-bar-bg { width: 52px; height: 3px; border-radius: 2px; flex-shrink: 0; overflow: hidden; }
.storage-bar-fill { height: 100%; border-radius: 2px; transition: width 0.4s ease, background 0.4s; }
.storage-text { white-space: nowrap; }
</style>
