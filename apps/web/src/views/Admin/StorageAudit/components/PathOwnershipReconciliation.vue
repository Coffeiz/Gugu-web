<template>
  <section class="sa-card">
    <div class="sa-card-head">
      <div>
        <h3 class="sa-card-title">{{ t('storageAuditUi.pathTitle') }}</h3>
        <p class="sa-card-sub">{{ t('storageAuditUi.pathHint') }}</p>
      </div>
      <div class="sa-card-head-right">
        <ActionButton variant="secondary" fit :disabled="scanning" @click="scanPathMigration">
          <Icon name="action.search" size="sm" />{{ t('storageAuditUi.scanPath') }}
        </ActionButton>
        <ActionButton v-if="report?.candidates?.length" fit :disabled="repairing" @click="repairPathMigration">
          <Icon name="admin.wrench" size="sm" />{{ t('storageAuditUi.repairItems', { count: report.candidates.length }) }}
        </ActionButton>
      </div>
    </div>
    <div v-if="message" class="sa-inline-msg" :class="messageKind">{{ message }}</div>
    <div v-if="report" class="recon-report">
      <div class="recon-summary">{{ t('storageAuditExtra.safeMatch') }} {{ t('filesViewUi.items', { count: report.candidate_count }) }} · {{ t('storageAuditExtra.ambiguous') }} {{ t('filesViewUi.items', { count: report.ambiguous_count }) }}</div>
      <div v-if="report.ambiguous_count" class="recon-meta">{{ t('storageAuditExtra.ambiguousHint') }}</div>
      <div v-for="item in report.candidates" :key="item.file_id" class="recon-row">
        <span class="recon-name">{{ item.name }}</span>
        <span class="recon-meta">{{ item.expected_old_key }} → {{ item.key }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { useAdminStore } from '@/stores/admin'

interface PathCandidate { file_id: number; name: string; key: string; expected_old_key: string }
interface PathMigrationReport { candidates: PathCandidate[]; candidate_count: number; ambiguous_count: number }

const adminStore = useAdminStore()
const { t } = useI18n()
const scanning = ref(false)
const repairing = ref(false)
const report = ref<PathMigrationReport | null>(null)
const message = ref('')
const messageKind = ref<'ok' | 'err'>('ok')

async function scanPathMigration() {
  scanning.value = true
  message.value = ''
  try {
    const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/path-migration')
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || t('storageAuditExtra.pathScanFailed', { message: '' }))
    report.value = data
  } catch (error) {
    messageKind.value = 'err'
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    scanning.value = false
  }
}

async function repairPathMigration() {
  const candidates = report.value?.candidates || []
  if (!candidates.length || !await confirmDialog({
    title: t('storageAuditExtra.pathRepairTitle'),
    message: t('storageAuditExtra.pathRepairConfirm', { count: candidates.length }),
    tone: 'warning',
    confirmText: t('storageAuditExtra.pathRepairStart'),
  })) return

  repairing.value = true
  try {
    const response = await adminStore.authFetch('/api/v1/admin/config/reconcile-storage/path-migration/repair', {
      method: 'POST',
      body: JSON.stringify({ items: candidates.map(item => ({
        file_id: item.file_id,
        key: item.key,
        expected_old_key: item.expected_old_key,
      })) }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || t('storageAuditExtra.pathRepairFailed', { message: '' }))
    messageKind.value = data.failed?.length ? 'err' : 'ok'
    message.value = t('storageAuditExtra.pathRepaired', { count: data.done.length }) + (data.failed?.length ? ` ${t('storageAuditExtra.failed', { count: data.failed.length })}` : '')
    await scanPathMigration()
  } catch (error) {
    messageKind.value = 'err'
    message.value = error instanceof Error ? error.message : String(error)
  } finally {
    repairing.value = false
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
.sa-inline-msg.err { color: var(--status-danger); background: var(--status-danger-bg); border: 1px solid color-mix(in srgb, var(--status-danger) 25%, transparent); }
.recon-report { margin-top: 4px; padding: 12px 14px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); font-size: var(--font-size-sm); }
.recon-summary { line-height: var(--line-height-body); color: var(--content-primary); }
.recon-meta { color: var(--content-secondary); word-break: break-all; }
.recon-row { padding: 4px 0; border-top: 1px solid var(--panel-divider); display: flex; gap: 8px; align-items: center; }
.recon-name { font-weight: var(--font-weight-semibold); color: var(--content-primary); }
@media (max-width: 700px) { .sa-card-head { flex-wrap: wrap; } }
</style>
