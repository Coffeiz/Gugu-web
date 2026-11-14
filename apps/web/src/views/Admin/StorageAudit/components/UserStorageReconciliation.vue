<template>
  <section class="sa-card user-storage-audit">
    <div class="sa-card-head">
      <div>
        <h3 class="sa-card-title">{{ t('storageAuditUi.userTitle') }}</h3>
        <p class="sa-card-sub">{{ t('storageAuditUi.userHint') }}</p>
      </div>
      <div class="sa-card-head-right">
        <ActionButton variant="secondary" fit :disabled="scanning" @click="scanUsers">
          <Icon name="action.search" size="sm" />
          {{ scanning ? t('storageAuditUi.userScanning') : t('storageAuditUi.userScan') }}
        </ActionButton>
        <ActionButton v-if="report?.users.length" fit :disabled="cleaning" @click="cleanUsers">
          <Icon name="action.delete" size="sm" />
          {{ t('storageAuditUi.userClean', { count: report.users.length }) }}
        </ActionButton>
      </div>
    </div>
    <div v-if="message" class="sa-inline-msg" :class="messageKind">{{ message }}</div>
    <div v-if="report" class="recon-report">
      <div class="recon-summary">
        {{ t('storageAuditUi.userSummary', { total: report.user_count, missing: report.missing_directory_count, empty: report.missing_file_user_count }) }}
        <span class="recon-meta"> · {{ report.location }}</span>
      </div>
      <div v-if="!report.users.length" class="recon-ok"><RiCheckFill class="recon-ok__icon" aria-hidden="true" />{{ t('storageAuditUi.userHealthy') }}</div>
      <div v-else class="recon-block">
        <div class="recon-block-title">{{ t('storageAuditUi.userMissing') }}</div>
        <div v-for="user in report.users" :key="user.user_id" class="recon-row">
          <span class="recon-name">{{ user.display_name || user.username }}</span>
          <span class="recon-meta">{{ user.username }} · {{ user.user_id }} · {{ t(user.reason === 'missing_directory' ? 'storageAuditUi.userReasonDirectory' : 'storageAuditUi.userReasonFiles') }} · {{ t('storageAuditUi.userImpact', { files: user.files, physical: user.physical_files, projects: user.projects, tasks: user.scheduled_tasks }) }}</span>
        </div>
        <p class="sa-card-sub user-storage-warning">{{ t('storageAuditUi.userWarning') }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { RiCheckFill } from '@remixicon/vue'
import { useAdminStore } from '@/stores/admin'

interface UserStorageItem {
  user_id: string
  username: string
  display_name: string | null
  account_status: string
  created_at: string | null
  files: number
  projects: number
  scheduled_tasks: number
  physical_files: number
  reason: 'missing_directory' | 'missing_files'
}
interface UserStorageReport {
  backend: string
  location: string
  user_count: number
  missing_directory_count: number
  missing_file_user_count: number
  users: UserStorageItem[]
}

const emit = defineEmits<{ 'files-changed': [] }>()
const adminStore = useAdminStore()
const { t } = useI18n()
const scanning = ref(false)
const cleaning = ref(false)
const report = ref<UserStorageReport | null>(null)
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')

async function scanUsers() {
  scanning.value = true
  message.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-users')
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || t('storageAuditUi.userScanFailed'))
    report.value = data
  } catch (error) {
    messageKind.value = 'err'
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    scanning.value = false
  }
}

async function cleanUsers() {
  const users = report.value?.users || []
  if (!users.length || !await confirmDialog({
    title: t('storageAuditUi.userCleanTitle'),
    message: t('storageAuditUi.userCleanConfirm', { count: users.length }),
    tone: 'danger',
    confirmText: t('storageAuditUi.userCleanConfirmButton'),
  })) return

  cleaning.value = true
  message.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-users/repair', {
      method: 'POST',
      body: JSON.stringify({ user_ids: users.map(user => user.user_id), confirm: true }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || t('storageAuditUi.userCleanFailed'))
    messageKind.value = data.skipped?.length ? 'err' : 'ok'
    message.value = t('storageAuditUi.userCleanResult', { done: data.done.length, skipped: data.skipped?.length || 0 })
    await scanUsers()
    emit('files-changed')
  } catch (error) {
    messageKind.value = 'err'
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    cleaning.value = false
  }
}
</script>

<style scoped>
.sa-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 20px 22px; margin-bottom: 20px; }
.sa-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.sa-card-title { font-size: var(--font-size-md); font-weight: var(--font-weight-bold); margin: 0; }
.sa-card-sub { font-size: var(--font-size-sm); color: var(--content-secondary); margin: 4px 0 0; max-width: 560px; }
.sa-card-head-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.sa-inline-msg { font-size: var(--font-size-sm); margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; }
.sa-inline-msg.ok { color: var(--status-success); background: var(--status-success-bg); border: 1px solid color-mix(in srgb, var(--status-success) 22%, transparent); }
.sa-inline-msg.err { color: var(--status-danger); background: var(--status-danger-bg); border: 1px solid color-mix(in srgb, var(--status-danger) 25%, transparent); }
.recon-report { margin-top: 4px; padding: 12px 14px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); font-size: var(--font-size-sm); }
.recon-summary { line-height: var(--line-height-body); color: var(--content-primary); }
.recon-ok { display: flex; align-items: center; gap: 4px; margin-top: 8px; color: var(--status-success); font-weight: var(--font-weight-semibold); }
.recon-ok__icon { width: 1em; height: 1em; flex: 0 0 auto; }
.recon-block { margin-top: 10px; }
.recon-block-title { font-weight: var(--font-weight-semibold); margin-bottom: 4px; color: var(--content-primary); }
.recon-row { padding: 4px 0; border-top: 1px solid var(--panel-divider); display: flex; gap: 8px; align-items: center; }
.recon-name { font-weight: var(--font-weight-semibold); color: var(--content-primary); }
.recon-meta { color: var(--content-secondary); word-break: break-all; flex: 1; min-width: 0; }
.user-storage-warning { margin-top: 10px; }
@media (max-width: 700px) { .sa-card-head { flex-wrap: wrap; } }
</style>
