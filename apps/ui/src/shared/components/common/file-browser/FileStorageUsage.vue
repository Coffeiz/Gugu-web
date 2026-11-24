<template>
  <div v-if="loaded" class="storage-pill" :title="t('filesViewUi.storageUsed', { used: fmtBytes(used) })">
    <span class="storage-text">{{ fmtBytes(used) }}</span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { fmtBytes } from '@/utils/fileSize'

const { t } = useI18n()
defineProps({ used: { type: Number, default: 0 }, loaded: Boolean })
</script>

<style scoped>
/* 这里只保留存储进度条自身的结构；toolbar 文字颜色/字号/高度由统一文件工具栏契约负责。 */
.storage-pill { display: flex; align-items: center; gap: 7px; padding: 0 4px; flex-shrink: 0; }
.storage-text { white-space: nowrap; }
</style>
