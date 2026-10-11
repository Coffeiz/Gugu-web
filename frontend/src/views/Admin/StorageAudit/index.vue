<template>
  <div class="sa-page">
    <div class="sa-head">
      <h2 class="sa-title">{{ t('admin.storageAudit') }}</h2>
      <p class="sa-sub">{{ t('storageAudit.subtitle') }}</p>
    </div>

    <FileSyncAdminPanel />
    <UserStorageReconciliation @files-changed="fileObjectReconciliation?.scan()" />
    <FileObjectReconciliation ref="fileObjectReconciliation" />
    <PathOwnershipReconciliation />
    <DirectoryReconciliation />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import FileSyncAdminPanel from '@/components/filesync/FileSyncAdminPanel.vue'
import DirectoryReconciliation from './components/DirectoryReconciliation.vue'
import FileObjectReconciliation from './components/FileObjectReconciliation.vue'
import PathOwnershipReconciliation from './components/PathOwnershipReconciliation.vue'
import UserStorageReconciliation from './components/UserStorageReconciliation.vue'

const { t } = useI18n()
const fileObjectReconciliation = ref<{ scan: () => Promise<void> } | null>(null)
</script>

<style scoped>
.sa-page { padding: 28px 32px; color: var(--content-primary); font-family: var(--font-sans); font-size: var(--font-size-body); line-height: var(--line-height-body); }
.sa-head { margin-bottom: 20px; }
.sa-title { font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); margin: 0; }
.sa-sub { font-size: var(--font-size-sm); color: var(--content-secondary); margin: 4px 0 0; max-width: 720px; }
.sa-sub b { color: var(--content-primary); font-weight: var(--font-weight-semibold); }
</style>
